#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Claude Mobile -- Updater
# Pulls latest from GitHub, updates deps, restarts PM2.
# Auth credentials, config, and identity keys are preserved.
# ─────────────────────────────────────────────────────────
set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
RED='\033[31m'
RESET='\033[0m'

say()  { echo -e "${BOLD}${BLUE}>>>${RESET} $1"; }
ok()   { echo -e "${GREEN}  OK${RESET} $1"; }
warn() { echo -e "${YELLOW}  !!${RESET} $1"; }
fail() { echo -e "${RED}  ERROR${RESET} $1"; exit 1; }

# Platform detection (needed by the secret-hardening helpers below)
IS_WINDOWS=false
[[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "$WINDIR" ]] && IS_WINDOWS=true

# ── Secret file hardening ────────────────────────────────
# Mirrors install.sh. Re-applied on every update because a restore, a
# re-clone, or a file the server recreated can pick the inherited ACLs back
# up -- inherited grants hand Modify on the identity PRIVATE key and the
# TOTP seed to other local accounts. Idempotent.
SECRET_FILES=(".totp-secret" ".server-identity-key" ".credentials.json")

lock_secret_file() {
  local f="$1"
  [ -e "$f" ] || return 0
  if $IS_WINDOWS; then
    local winpath acct
    winpath="$(cygpath -w "$f" 2>/dev/null || echo "$f")"
    acct="${USERNAME:-$USER}"
    # /inheritance:r drops inherited ACEs; /grant:r replaces rather than appends.
    MSYS_NO_PATHCONV=1 icacls "$winpath" /inheritance:r \
      /grant:r "${acct}:F" "SYSTEM:F" "Administrators:F" >/dev/null 2>&1
  else
    chmod 600 "$f" >/dev/null 2>&1
  fi
}

# Returns non-zero if ANY file could not be locked, so the caller can refuse
# to report success for a guarantee that did not hold.
harden_secrets() {
  local f rc=0
  for f in "${SECRET_FILES[@]}"; do
    lock_secret_file "$f" || { warn "Could not lock permissions on $f"; rc=1; }
  done
  local audit="$HOME/.claude-mobile-audit.log"
  [ -e "$audit" ] || : > "$audit" 2>/dev/null || true
  lock_secret_file "$audit" \
    || { warn "Could not lock permissions on ~/.claude-mobile-audit.log"; rc=1; }
  return $rc
}

# Find install directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/server.js" ]; then
  INSTALL_DIR="$SCRIPT_DIR"
else
  fail "Cannot find server.js. Run from the claude-mobile directory."
fi

cd "$INSTALL_DIR"
say "Updating Claude Mobile in $INSTALL_DIR"

# Show current version
CURRENT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
say "Current: $CURRENT"

# Check for local changes
if ! git diff --quiet 2>/dev/null; then
  warn "You have local changes. Stashing..."
  git stash
  STASHED=1
fi

# Pull latest
say "Pulling latest from GitHub..."
git pull origin master --ff-only || {
  warn "Fast-forward failed. Trying rebase..."
  git pull origin master --rebase || fail "Pull failed. Resolve conflicts manually."
}

NEW=$(git rev-parse --short HEAD)
if [ "$CURRENT" = "$NEW" ]; then
  ok "Already up to date ($CURRENT)"
else
  say "Updated: $CURRENT -> $NEW"
  echo ""
  git log --oneline "$CURRENT".."$NEW" 2>/dev/null | head -15
  echo ""
fi

# Restore stashed changes
if [ "${STASHED:-0}" = "1" ]; then
  say "Restoring local changes..."
  git stash pop || warn "Stash pop failed -- check manually"
fi

# Which PM2 process this install IS, resolved BEFORE the dependency step
# because that step now has to stop it. CM_PM2_NAME is set by the server when
# an update is triggered from the client; the default preserves the behaviour
# of a hand-run update.
#
# The existence check is `pm2 describe`, an EXACT lookup, not a grep over
# `pm2 list`. A substring match is what made this restart the wrong process:
# "claude-mobile" matches the line for "claude-mobile-herdr".
PM2_NAME="${CM_PM2_NAME:-claude-mobile}"
PM2_PRESENT=false
if command -v pm2 &>/dev/null && pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  PM2_PRESENT=true
fi

# If this script stops the server, SOMETHING has to start it again on every
# exit path -- not just the happy one. `set -e` is on, `fail` calls exit, and
# the operator may be holding a phone with no other way in. A trap is the only
# construct that covers all of those at once.
STOPPED_FOR_NPM=false
RESTARTED=false
# Set only where restarting would be the destructive act -- see the dependency
# step. Default false so every ordinary run restarts as before.
SKIP_RESTART=false
on_exit() {
  if $STOPPED_FOR_NPM && ! $RESTARTED; then
    warn "Update exited before restarting -- bringing $PM2_NAME back up"
    pm2 restart "$PM2_NAME" >/dev/null 2>&1 \
      || pm2 start server.js --name "$PM2_NAME" >/dev/null 2>&1 \
      || warn "Could not bring $PM2_NAME back -- start it manually on the host"
  fi
}
trap on_exit EXIT

# Update npm deps if EITHER manifest moved.
# package-lock.json matters on its own: a security fix is very often
# lockfile-only (the fixed version already satisfies the existing caret range,
# so package.json never changes). Triggering on package.json alone would skip
# exactly those -- including the ws HIGH advisory this repo just patched --
# and leave the installed tree behind the audited one indefinitely.
if [ "$CURRENT" != "$NEW" ] && git diff "$CURRENT".."$NEW" --name-only 2>/dev/null | grep -qE '^(package\.json|package-lock\.json)$'; then
  say "Dependency manifest changed -- updating dependencies..."
  # npm ci, not npm install: installs exactly the tree in package-lock.json.
  # With `npm install` the lockfile is advisory and every caret range
  # re-resolves on each update, so a compromised upstream patch release
  # lands silently.
  # Default true so the verification block below can test it on every path,
  # including the one where the lockfile is missing.
  SAFE_TO_INSTALL=true
  if [ -f package-lock.json ]; then
    # STOP THE SERVER FIRST. npm deletes node_modules alphabetically, and a
    # running server holds node-pty's native .node open -- so the wipe dies
    # partway and everything before it is simply gone. It stays invisible
    # until the next restart, because the live process keeps running on the
    # modules it already loaded.
    #
    # Not hypothetical. This fired on the first real update through the new
    # client button, 24 Aug 2026: node_modules went from 115 entries to 3
    # (@peculiar, @simplewebauthn, node-pty), require('node-pty') threw, and
    # /health still answered 200 with a live session. The next restart would
    # have been a dead server.
    if $PM2_PRESENT; then
      say "Stopping $PM2_NAME so npm can replace node_modules..."
      if pm2 stop "$PM2_NAME" >/dev/null 2>&1; then
        STOPPED_FOR_NPM=true
      else
        # Installing anyway is what causes the damage. A dependency tree one
        # version behind still runs; a half-deleted one does not, and it fails
        # silently until the next restart. Skipping leaves node_modules
        # untouched and the server serving.
        warn "Could not stop $PM2_NAME -- SKIPPING npm ci rather than corrupting node_modules"
        SAFE_TO_INSTALL=false
        UPDATE_DEGRADED=1
      fi
    fi
    if $SAFE_TO_INSTALL; then
      # Not `fail`: the server is stopped now, so exiting here would leave it
      # down. Record it and press on to the restart. One retry, because the
      # common cause of a first failure is a file still being released.
      npm ci --omit=dev || {
        warn "npm ci failed -- retrying once"
        npm ci --omit=dev || { warn "npm ci FAILED twice -- the installed tree is probably incomplete"; NPM_FAILED=1; }
      }
    fi
  else
    # No silent fallback to `npm install`. package-lock.json is committed, so
    # a missing one means a broken checkout -- and installing anyway would
    # re-resolve every caret range unchecked, which is exactly the posture
    # this task removed. The audit gate only means something if the installed
    # tree IS the audited tree.
    fail "package-lock.json is missing -- refusing to install an unpinned tree. Restore it (git checkout -- package-lock.json) and re-run."
  fi
  # The check IS the point, and it runs on EVERY path including a failed
  # install. A half-deleted node_modules exits 0 and looks like a clean install
  # -- that is exactly what happened -- so the only honest test is loading the
  # native module that gets clobbered first. Skipping the check when npm ci
  # already failed would restart into an unverified tree and report nothing
  # about it.
  if node -e "require('node-pty')" >/dev/null 2>&1; then
    if [ "${NPM_FAILED:-0}" = "1" ]; then
      warn "npm ci failed, but node-pty still loads -- the previous tree is intact"
      UPDATE_DEGRADED=1
    else
      ok "Dependencies updated"
    fi
  elif ! $SAFE_TO_INSTALL; then
    # We could not stop the server, so running npm ci now is the destructive
    # operation this whole change exists to prevent. Refuse, and do not claim
    # to be "repairing with the server stopped" when it is not.
    #
    # And do NOT restart afterwards. This is the one state where restarting is
    # the destructive act: the on-disk tree is broken, but the running process
    # is healthy because it holds the modules it loaded at startup. Restarting
    # trades a working server for a dead one. Leaving it alone keeps the
    # operator connected while they fix the tree.
    warn "node-pty does not load and $PM2_NAME could not be stopped -- NOT installing and NOT restarting; the running server still works. Run 'pm2 stop $PM2_NAME && npm ci --omit=dev && pm2 restart $PM2_NAME' on the host."
    SKIP_RESTART=true
    UPDATE_DEGRADED=1
  else
    # Detecting a broken tree and restarting into it anyway just converts a
    # visible problem into a crash loop. The server IS stopped at this point,
    # which is precisely the condition under which the install works -- so
    # repair it here rather than reporting it and moving on.
    warn "node-pty does not load -- node_modules is incomplete. Repairing with the server stopped..."
    if npm ci --omit=dev && node -e "require('node-pty')" >/dev/null 2>&1; then
      ok "Dependencies repaired"
    else
      warn "Repair FAILED -- node_modules is still incomplete. The server will restart but may not stay up; run 'pm2 stop $PM2_NAME && npm ci --omit=dev && pm2 restart $PM2_NAME' on the host."
      UPDATE_DEGRADED=1
    fi
  fi
fi

# Re-assert secret file permissions (see harden_secrets above).
# Do not claim "verified" for a check that failed: .server-identity-key holds
# the identity private key, and leaving it group-writable is the finding this
# task exists to close.
if harden_secrets; then
  ok "Secret file permissions verified"
else
  warn "Secret file permissions could NOT be fully hardened -- .totp-secret / .server-identity-key may remain group-writable. Fix before relying on this host."
  UPDATE_DEGRADED=1
fi

# Update WSL deps if on Windows and server.js changed
if $IS_WINDOWS && wsl --list --quiet 2>/dev/null | grep -qi "Ubuntu-24.04"; then
  say "Updating WSL tools..."
  wsl -d Ubuntu-24.04 -u root -- bash -c "
    npm update -g @anthropic-ai/claude-code 2>/dev/null | tail -1
  " 2>/dev/null && ok "WSL Claude Code updated" || warn "WSL update skipped"
fi

# Restart via PM2. `pm2 restart` also STARTS a stopped app, which matters here:
# the dependency step above stops it, and this is what brings it back.
#
# The failure is handled rather than allowed to abort under `set -e`: aborting
# here is the one outcome nobody can recover from remotely, because the server
# that serves the UI is the server that is down.
if $PM2_PRESENT && $SKIP_RESTART; then
  warn "Skipping the restart on purpose -- see the dependency warning above. $PM2_NAME is still serving on its loaded modules."
elif $PM2_PRESENT; then
  say "Restarting via PM2 ($PM2_NAME)..."
  if pm2 restart "$PM2_NAME"; then
    RESTARTED=true
    ok "Restarted"
    sleep 2
    pm2 logs "$PM2_NAME" --lines 8 --nostream
  elif pm2 start server.js --name "$PM2_NAME"; then
    RESTARTED=true
    warn "pm2 restart failed; started $PM2_NAME fresh instead"
    UPDATE_DEGRADED=1
  else
    warn "Could not restart $PM2_NAME -- start it manually on the host"
    UPDATE_DEGRADED=1
  fi
else
  ok "Update complete. Restart manually: node server.js"
fi

echo ""
if [ "${UPDATE_DEGRADED:-0}" -eq 1 ]; then
  warn "Update finished DEGRADED -- see the warnings above; a guarantee did not hold."
else
  say "Done. Preserved: .totp-secret, .credentials.json, .server-identity-key, config.json"
fi
exit "${UPDATE_DEGRADED:-0}"
