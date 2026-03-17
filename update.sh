#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Claude Mobile -- Updater
# Pulls latest code from GitHub and restarts the service.
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
elif [ -f "$HOME/Projects/claude-mobile/server.js" ]; then
  INSTALL_DIR="$HOME/Projects/claude-mobile"
else
  fail "Cannot find claude-mobile installation. Run from the install directory."
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
  # Show what changed
  echo ""
  git log --oneline "$CURRENT".."$NEW" 2>/dev/null | head -10
  echo ""
fi

# Restore stashed changes if any
if [ "${STASHED:-0}" = "1" ]; then
  say "Restoring local changes..."
  git stash pop || warn "Stash pop failed -- check manually"
fi

# Update dependencies if package.json changed
if git diff "$CURRENT".."$NEW" --name-only 2>/dev/null | grep -q "package.json"; then
  say "package.json changed -- updating dependencies..."
  npm install --production
  ok "Dependencies updated"
fi

# Restart if PM2 is managing the process
if command -v pm2 &>/dev/null && pm2 list 2>/dev/null | grep -q "claude-mobile"; then
  say "Restarting via PM2..."
  pm2 restart claude-mobile
  ok "Restarted"
  pm2 logs claude-mobile --lines 5 --nostream
else
  ok "Update complete. Restart manually: node server.js"
fi

echo ""
say "Done. Preserved: .totp-secret, .credentials.json, .server-identity-key, config.json"
