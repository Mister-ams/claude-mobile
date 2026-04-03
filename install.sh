#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Claude Mobile v3.1.3 -- Installer
# Checks prerequisites, clones repo, configures Tailscale,
# sets up WSL/dtach, installs deps, and runs TOTP setup.
# ─────────────────────────────────────────────────────────
set -e

VERSION="3.1.3"
REPO="https://github.com/Mister-ams/claude-mobile.git"
DEFAULT_DIR="$HOME/Projects/claude-mobile"
PORT=3456

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
RED='\033[31m'
RESET='\033[0m'

say()  { echo -e "${BOLD}${BLUE}>>>${RESET} $1"; }
ok()   { echo -e "${GREEN}  [ok]${RESET} $1"; }
warn() { echo -e "${YELLOW}  [!!]${RESET} $1"; }
fail() { echo -e "${RED}  [FAIL]${RESET} $1"; exit 1; }
skip() { echo -e "${DIM}  [--]${RESET} $1"; }
ask()  { echo -en "${BOLD}${BLUE}>>>${RESET} $1: "; read -r REPLY; }

# ── Banner ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}+==========================================+${RESET}"
echo -e "${BOLD}|         Claude Mobile v${VERSION}             |${RESET}"
echo -e "${BOLD}|   Mobile terminal gateway for Claude     |${RESET}"
echo -e "${BOLD}+==========================================+${RESET}"
echo ""

# ── Detect platform ─────────────────────────────────────
IS_WINDOWS=false
IS_MAC=false
IS_LINUX=false
[[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "$WINDIR" ]] && IS_WINDOWS=true
[[ "$OSTYPE" == "darwin"* ]] && IS_MAC=true
[[ "$OSTYPE" == "linux-gnu"* ]] && IS_LINUX=true

PLATFORM="unknown"
$IS_WINDOWS && PLATFORM="Windows"
$IS_MAC && PLATFORM="macOS"
$IS_LINUX && PLATFORM="Linux"
say "Platform: $PLATFORM"
echo ""

# ════════════════════════════════════════════════════════
# PHASE 1: PREREQUISITE CHECK
# ════════════════════════════════════════════════════════
say "Phase 1/4: Checking prerequisites..."
echo ""
PREREQ_PASS=true

# -- git --
if command -v git &>/dev/null; then
  ok "git $(git --version | cut -d' ' -f3)"
else
  fail "git not found. Install git first."
fi

# -- Node.js --
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 18 ]; then
    ok "Node.js $(node -v)"
  else
    warn "Node.js v$NODE_VER found -- v18+ required"
    echo -e "    ${DIM}Install from https://nodejs.org${RESET}"
    PREREQ_PASS=false
  fi
else
  warn "Node.js not found"
  echo -e "    ${DIM}Install from https://nodejs.org (v18+)${RESET}"
  PREREQ_PASS=false
fi

# -- npm --
if command -v npm &>/dev/null; then
  ok "npm $(npm -v)"
else
  warn "npm not found"
  PREREQ_PASS=false
fi

# -- Claude Code CLI --
if command -v claude &>/dev/null; then
  ok "Claude Code CLI"
else
  warn "Claude Code CLI not found"
  echo -e "    ${DIM}Install: npm i -g @anthropic-ai/claude-code${RESET}"
  echo -e "    ${DIM}You can install this later -- not blocking.${RESET}"
fi

# -- PM2 --
if command -v pm2 &>/dev/null; then
  ok "PM2 $(pm2 -v 2>/dev/null | tail -1)"
  PM2_INSTALLED=true
else
  skip "PM2 not installed (will offer to install in Phase 3)"
  PM2_INSTALLED=false
fi

# -- Tailscale --
TS_CMD=""
if command -v tailscale &>/dev/null; then
  TS_CMD="tailscale"
elif [ -f "/c/Program Files/Tailscale/tailscale.exe" ]; then
  TS_CMD="/c/Program Files/Tailscale/tailscale.exe"
elif [ -f "/mnt/c/Program Files/Tailscale/tailscale.exe" ]; then
  TS_CMD="/mnt/c/Program Files/Tailscale/tailscale.exe"
fi

if [ -n "$TS_CMD" ]; then
  if "$TS_CMD" status &>/dev/null 2>&1; then
    ok "Tailscale (connected)"
  else
    warn "Tailscale installed but not connected"
    echo -e "    ${DIM}Run: tailscale up${RESET}"
    PREREQ_PASS=false
  fi
else
  warn "Tailscale not found"
  if $IS_WINDOWS; then
    echo -e "    ${DIM}Install: winget install Tailscale.Tailscale${RESET}"
  elif $IS_MAC; then
    echo -e "    ${DIM}Install: brew install tailscale${RESET}"
  else
    echo -e "    ${DIM}Install: curl -fsSL https://tailscale.com/install.sh | sh${RESET}"
  fi
  PREREQ_PASS=false
fi

# -- WSL + dtach (Windows only) --
WSL_DISTRO="Ubuntu-24.04"
if $IS_WINDOWS; then
  if wsl --list --quiet 2>/dev/null | grep -qi "Ubuntu-24.04"; then
    ok "WSL Ubuntu-24.04"
    # Check dtach inside WSL
    if wsl -d "$WSL_DISTRO" -u root -- bash -c "command -v dtach" &>/dev/null 2>&1; then
      ok "dtach (WSL)"
    else
      skip "dtach not yet installed in WSL (will install in Phase 3)"
    fi
  else
    skip "WSL Ubuntu-24.04 not installed (will install in Phase 3)"
  fi
elif command -v dtach &>/dev/null; then
  ok "dtach"
else
  warn "dtach not found -- sessions won't persist across restarts"
  if $IS_MAC; then
    echo -e "    ${DIM}Install: brew install dtach${RESET}"
  else
    echo -e "    ${DIM}Install: sudo apt install dtach${RESET}"
  fi
fi

echo ""
if ! $PREREQ_PASS; then
  echo -e "  ${YELLOW}Some prerequisites are missing.${RESET}"
  ask "Continue anyway? Remaining steps will install what they can. (y/n)"
  [[ ! "$REPLY" =~ ^[Yy] ]] && { echo "Exiting."; exit 0; }
  echo ""
fi

# ════════════════════════════════════════════════════════
# PHASE 2: GET CODE + CONFIGURE
# ════════════════════════════════════════════════════════
say "Phase 2/4: Getting code + configuring..."
echo ""

# -- Clone or update repo --
ask "Install directory (default: $DEFAULT_DIR)"
INSTALL_DIR="${REPLY:-$DEFAULT_DIR}"

if [ -f "$INSTALL_DIR/server.js" ]; then
  ok "Already installed at $INSTALL_DIR -- pulling latest"
  cd "$INSTALL_DIR"
  git pull origin master --ff-only 2>/dev/null || git pull origin master --rebase 2>/dev/null || warn "Pull failed -- using existing code"
else
  PARENT_DIR="$(dirname "$INSTALL_DIR")"
  mkdir -p "$PARENT_DIR"
  say "Cloning from GitHub..."
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

# -- Tailscale hostname --
TS_HOSTNAME=""
if [ -n "$TS_CMD" ]; then
  TS_HOSTNAME=$("$TS_CMD" status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/\.$//' | sed 's/"$//')
fi

if [ -z "$TS_HOSTNAME" ]; then
  echo -e "  ${DIM}Could not auto-detect. Find it in Tailscale > Machines.${RESET}"
  ask "Tailscale hostname (e.g., my-laptop.tail12345.ts.net)"
  TS_HOSTNAME="$REPLY"
fi

if [ -n "$TS_HOSTNAME" ]; then
  ok "Hostname: $TS_HOSTNAME"
else
  warn "No hostname set -- you'll need to edit config.json manually"
fi

# -- Configure Tailscale serve --
if [ -n "$TS_CMD" ] && [ -n "$TS_HOSTNAME" ]; then
  say "Configuring HTTPS proxy..."
  echo -e "  ${DIM}https://$TS_HOSTNAME -> localhost:$PORT${RESET}"
  SERVE_OUTPUT=$("$TS_CMD" serve --bg http://localhost:$PORT 2>&1) && ok "tailscale serve configured" || {
    if echo "$SERVE_OUTPUT" | grep -qi "not enabled"; then
      ENABLE_URL=$(echo "$SERVE_OUTPUT" | grep -o 'https://login.tailscale.com/[^ ]*' | head -1)
      [ -n "$ENABLE_URL" ] && echo -e "  ${GREEN}$ENABLE_URL${RESET}"
      ask "Press Enter after enabling Tailscale Serve, then we'll retry"
      "$TS_CMD" serve --bg http://localhost:$PORT 2>/dev/null && ok "tailscale serve configured" || {
        warn "Configure manually later: tailscale serve --bg http://localhost:$PORT"
      }
    else
      warn "Configure manually later: tailscale serve --bg http://localhost:$PORT"
    fi
  }
fi

# -- config.json --
if [ -f config.json ]; then
  ok "config.json already exists -- keeping existing config"
else
  echo ""
  echo -e "  ${DIM}Claude Mobile opens Claude Code in a project directory.${RESET}"
  echo ""
  ask "Main project path (e.g., C:\\Users\\me\\Projects\\my-project)"
  MAIN_DIR="$REPLY"
  [ -z "$MAIN_DIR" ] && fail "No project path provided"

  ask "Short name for this project (e.g., 'My Project')"
  MAIN_NAME="${REPLY:-Main Project}"

  PROJECTS="[{\"name\":\"$MAIN_NAME\",\"dir\":\"$MAIN_DIR\"}"
  echo -e "  ${DIM}Add up to 3 more projects (Enter to skip):${RESET}"
  for i in 2 3 4; do
    ask "Project #$i path (Enter to skip)"
    [ -z "$REPLY" ] && break
    EXTRA_DIR="$REPLY"
    ask "Short name"
    EXTRA_NAME="${REPLY:-Project $i}"
    PROJECTS="$PROJECTS,{\"name\":\"$EXTRA_NAME\",\"dir\":\"$EXTRA_DIR\"}"
  done
  PROJECTS="$PROJECTS]"

  # Escape JSON-special characters in user-provided values
  json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
  MAIN_NAME_E=$(json_escape "$MAIN_NAME")
  TS_HOSTNAME_E=$(json_escape "$TS_HOSTNAME")
  WSL_DISTRO_E=$(json_escape "$WSL_DISTRO")
  MAIN_DIR_E=$(json_escape "$MAIN_DIR")

  cat > config.json << JSONEOF
{
  "port": $PORT,
  "tailscaleHostname": "$TS_HOSTNAME_E",
  "inactivityTimeout": 15,
  "wslDistro": "$WSL_DISTRO_E",
  "autoStart": ["$MAIN_NAME_E"],
  "defaultDir": "$MAIN_DIR_E",
  "projects": $PROJECTS
}
JSONEOF
  ok "config.json created"
fi

# ════════════════════════════════════════════════════════
# PHASE 3: INSTALL DEPENDENCIES
# ════════════════════════════════════════════════════════
echo ""
say "Phase 3/4: Installing dependencies..."
echo ""

# -- npm deps --
npm install --production 2>&1 | tail -3
ok "Node dependencies installed"

# -- PM2 --
if ! $PM2_INSTALLED; then
  ask "Install PM2 for background running? (recommended) (y/n)"
  if [[ "$REPLY" =~ ^[Yy] ]]; then
    npm install -g pm2 2>&1 | tail -3
    ok "PM2 installed"
  else
    skip "PM2 skipped -- you'll need to run server.js manually"
  fi
fi

# -- WSL + dtach (Windows only) --
if $IS_WINDOWS; then
  say "Setting up WSL + dtach..."

  if ! wsl --list --quiet 2>/dev/null | grep -qi "Ubuntu-24.04"; then
    say "Installing WSL Ubuntu-24.04 (this may take a few minutes)..."
    wsl --install Ubuntu-24.04 --no-launch 2>&1 | tail -3
    ok "Ubuntu-24.04 installed"
  fi

  say "Installing dtach + Claude Code in WSL..."
  wsl -d "$WSL_DISTRO" -u root -- bash -c "
    apt-get update -qq && apt-get install -y -qq dtach curl > /dev/null 2>&1
    if ! command -v node &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
      apt-get install -y -qq nodejs > /dev/null 2>&1
    fi
    if ! command -v pm2 &>/dev/null; then
      npm install -g pm2 > /dev/null 2>&1
    fi
    if ! command -v claude &>/dev/null; then
      npm install -g @anthropic-ai/claude-code > /dev/null 2>&1
    fi
    echo \"dtach installed, node \$(node -v), pm2 \$(pm2 -v 2>/dev/null | tail -1)\"
  " 2>/dev/null && ok "WSL tools installed" || warn "WSL setup had issues -- dtach persistence may not work"
elif ! $IS_WINDOWS; then
  if ! command -v dtach &>/dev/null; then
    warn "dtach not installed. Session persistence requires dtach."
    if $IS_MAC; then
      echo -e "    ${DIM}brew install dtach${RESET}"
    else
      echo -e "    ${DIM}sudo apt install dtach${RESET}"
    fi
  fi
fi

# ════════════════════════════════════════════════════════
# PHASE 4: START + TOTP SETUP
# ════════════════════════════════════════════════════════
echo ""
say "Phase 4/4: Starting server for TOTP setup..."
echo ""

node server.js &
SERVER_PID=$!
sleep 4

if ! kill -0 $SERVER_PID 2>/dev/null; then
  fail "Server failed to start. Check for port conflicts on $PORT"
fi
ok "Server running on port $PORT (PID $SERVER_PID)"

# ── Summary ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}+============================================================+${RESET}"
echo -e "${BOLD}|              Claude Mobile v${VERSION} -- Ready                  |${RESET}"
echo -e "${BOLD}+============================================================+${RESET}"
echo -e "${BOLD}|${RESET}                                                            ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}  ${BOLD}Step 1: Set up TOTP (on your laptop)${RESET}                      ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    Open ${GREEN}http://localhost:$PORT/setup${RESET}                       ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    Scan QR code with Apple Passwords (or any TOTP app)     ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    Enter the 6-digit code to verify                        ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}                                                            ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}  ${BOLD}Step 2: Connect from your iPhone${RESET}                          ${BOLD}|${RESET}"
if [ -n "$TS_HOSTNAME" ]; then
echo -e "${BOLD}|${RESET}    Open ${GREEN}https://$TS_HOSTNAME${RESET}"
else
echo -e "${BOLD}|${RESET}    Open ${GREEN}https://<your-tailscale-hostname>${RESET}                  ${BOLD}|${RESET}"
fi
echo -e "${BOLD}|${RESET}    Enter TOTP code to log in                               ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    Register Face ID when prompted (optional)               ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}                                                            ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}  ${BOLD}Step 3: Run in background${RESET}                                 ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    Press Ctrl+C to stop this foreground server              ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    Then: ${GREEN}pm2 start server.js --name claude-mobile${RESET}          ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}          ${GREEN}pm2 save${RESET}                                          ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}                                                            ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}  ${DIM}Update anytime: bash update.sh${RESET}                            ${BOLD}|${RESET}"
echo -e "${BOLD}+============================================================+${RESET}"
echo ""

# Server is running in background for TOTP setup.
# Press Ctrl+C when done, then use: pm2 start server.js --name claude-mobile
wait $SERVER_PID 2>/dev/null || true
