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
  if [ -f package-lock.json ]; then
    npm ci --omit=dev
  else
    # No silent fallback to `npm install`. package-lock.json is committed, so
    # a missing one means a broken checkout -- and installing anyway would
    # re-resolve every caret range unchecked, which is exactly the posture
    # this task removed. The audit gate only means something if the installed
    # tree IS the audited tree.
    fail "package-lock.json is missing -- refusing to install an unpinned tree. Restore it (git checkout -- package-lock.json) and re-run."
  fi
  ok "Dependencies updated"
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

# Restart via PM2
if command -v pm2 &>/dev/null && pm2 list 2>/dev/null | grep -q "claude-mobile"; then
  say "Restarting via PM2..."
  pm2 restart claude-mobile
  ok "Restarted"
  sleep 2
  pm2 logs claude-mobile --lines 8 --nostream
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
