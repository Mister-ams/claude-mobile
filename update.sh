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

harden_secrets() {
  local f
  for f in "${SECRET_FILES[@]}"; do
    lock_secret_file "$f" || warn "Could not lock permissions on $f"
  done
  lock_secret_file "$HOME/.claude-mobile-audit.log" \
    || warn "Could not lock permissions on ~/.claude-mobile-audit.log"
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

# Update npm deps if package.json changed
if [ "$CURRENT" != "$NEW" ] && git diff "$CURRENT".."$NEW" --name-only 2>/dev/null | grep -q "package.json"; then
  say "package.json changed -- updating dependencies..."
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

# Re-assert secret file permissions (see harden_secrets above)
harden_secrets
ok "Secret file permissions verified"

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
say "Done. Preserved: .totp-secret, .credentials.json, .server-identity-key, config.json"
