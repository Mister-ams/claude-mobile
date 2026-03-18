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
  npm install --production
  ok "Dependencies updated"
fi

# Update WSL deps if on Windows and server.js changed
IS_WINDOWS=false
[[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "$WINDIR" ]] && IS_WINDOWS=true

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
