#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Claude Mobile -- Installer
# Clones from GitHub, installs deps, configures Tailscale,
# sets up WSL/tmux for session persistence, and runs setup.
# ─────────────────────────────────────────────────────────
set -e

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
ok()   { echo -e "${GREEN}  OK${RESET} $1"; }
warn() { echo -e "${YELLOW}  !!${RESET} $1"; }
fail() { echo -e "${RED}  ERROR${RESET} $1"; exit 1; }
ask()  { echo -en "${BOLD}${BLUE}>>>${RESET} $1: "; read -r REPLY; }

echo ""
echo -e "${BOLD}+======================================+${RESET}"
echo -e "${BOLD}|       Claude Mobile Installer        |${RESET}"
echo -e "${BOLD}|  Mobile terminal gateway for Claude  |${RESET}"
echo -e "${BOLD}+======================================+${RESET}"
echo ""
echo -e "  ${DIM}Prerequisites:${RESET}"
echo -e "  ${DIM}  1. Node.js 18+ installed${RESET}"
echo -e "  ${DIM}  2. Tailscale on this computer + your iPhone${RESET}"
echo -e "  ${DIM}  3. Both devices on the same Tailscale account${RESET}"
echo ""

# ── Step 1: Prerequisites ────────────────────────────────
say "Step 1/7: Checking prerequisites..."

if ! command -v git &>/dev/null; then
  fail "git not found. Install git first."
fi
ok "git $(git --version | cut -d' ' -f3)"

if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install from https://nodejs.org (v18+)"
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js v$NODE_VER found, v18+ required"
fi
ok "Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
  fail "npm not found"
fi
ok "npm $(npm -v)"

if ! command -v claude &>/dev/null; then
  warn "Claude Code CLI not found in PATH"
  warn "Install before running: https://claude.ai/claude-code"
else
  ok "Claude Code CLI found"
fi

# ── Step 2: Clone repo ───────────────────────────────────
say "Step 2/7: Getting claude-mobile..."

ask "Install directory (default: $DEFAULT_DIR)"
INSTALL_DIR="${REPLY:-$DEFAULT_DIR}"

if [ -f "$INSTALL_DIR/server.js" ]; then
  ok "Already installed at $INSTALL_DIR -- pulling latest"
  cd "$INSTALL_DIR"
  git pull origin master --ff-only || git pull origin master --rebase
else
  PARENT_DIR="$(dirname "$INSTALL_DIR")"
  mkdir -p "$PARENT_DIR"
  say "Cloning from GitHub..."
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

# ── Step 3: Tailscale ────────────────────────────────────
say "Step 3/7: Setting up Tailscale..."

TS_CMD=""
if command -v tailscale &>/dev/null; then
  TS_CMD="tailscale"
elif [ -f "/c/Program Files/Tailscale/tailscale.exe" ]; then
  TS_CMD="/c/Program Files/Tailscale/tailscale.exe"
elif [ -f "/mnt/c/Program Files/Tailscale/tailscale.exe" ]; then
  TS_CMD="/mnt/c/Program Files/Tailscale/tailscale.exe"
fi

if [ -z "$TS_CMD" ]; then
  echo ""
  echo -e "  ${RED}Tailscale is required.${RESET}"
  echo -e "    Windows: ${DIM}winget install Tailscale.Tailscale${RESET}"
  echo -e "    macOS:   ${DIM}brew install tailscale${RESET}"
  echo -e "    Linux:   ${DIM}curl -fsSL https://tailscale.com/install.sh | sh${RESET}"
  echo ""
  fail "Install Tailscale and run this installer again."
fi
ok "Tailscale CLI found"

if ! "$TS_CMD" status &>/dev/null 2>&1; then
  warn "Tailscale is installed but not connected."
  echo -e "  ${DIM}Run: ${BOLD}tailscale up${RESET}${DIM} then re-run this installer.${RESET}"
  fail "Connect Tailscale first."
fi
ok "Tailscale connected"

TS_HOSTNAME=$("$TS_CMD" status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/\.$//' | sed 's/"$//')
if [ -z "$TS_HOSTNAME" ]; then
  echo -e "  ${DIM}Could not auto-detect hostname. Find it in Tailscale > Machines.${RESET}"
  ask "Tailscale hostname (e.g., my-laptop.tail12345.ts.net)"
  TS_HOSTNAME="$REPLY"
  [ -z "$TS_HOSTNAME" ] && fail "Hostname required for HTTPS + passkeys."
fi
ok "Hostname: $TS_HOSTNAME"

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

# ── Step 4: Dependencies ─────────────────────────────────
say "Step 4/7: Installing dependencies..."
npm install --production 2>&1 | tail -3
ok "Dependencies installed"

# ── Step 5: WSL + tmux (Windows only) ────────────────────
IS_WINDOWS=false
[[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "$WINDIR" ]] && IS_WINDOWS=true

if $IS_WINDOWS; then
  say "Step 5/7: Setting up WSL + tmux for session persistence..."

  # Create .wslconfig with memory cap
  WSLCONFIG="$HOME/.wslconfig"
  if [ ! -f "$WSLCONFIG" ]; then
    cat > "$WSLCONFIG" << WSLEOF
[wsl2]
memory=1GB
swap=256MB
WSLEOF
    ok ".wslconfig created (1GB memory cap, 256MB swap)"
  else
    ok ".wslconfig already exists"
  fi

  # Check if Ubuntu-24.04 is already installed
  WSL_INSTALLED=false
  if wsl --list --quiet 2>/dev/null | grep -qi "Ubuntu-24.04"; then
    WSL_INSTALLED=true
    ok "WSL Ubuntu-24.04 already installed"
  fi

  if ! $WSL_INSTALLED; then
    say "Installing WSL Ubuntu-24.04 (this may take a few minutes)..."
    wsl --install Ubuntu-24.04 --no-launch 2>&1 | tail -3
    ok "Ubuntu-24.04 installed"
  fi

  # Install tmux only (no Node, PM2, or Claude -- they run on Windows)
  say "Installing tmux in WSL..."
  wsl -d Ubuntu-24.04 -u root -- bash -c "
    apt-get update -qq && apt-get install -y -qq tmux > /dev/null 2>&1
    echo \"tmux \$(tmux -V | cut -d' ' -f2)\"
  " 2>/dev/null && ok "tmux installed in WSL" || warn "tmux install had issues"

  # Register Task Scheduler jobs
  say "Registering auto-start task..."
  PM2_PATH="$(cygpath -w "$(dirname "$(which pm2)")")"
  cat > "$INSTALL_DIR/pm2-resurrect.cmd" << CMDEOF
@echo off
set PATH=$PM2_PATH;%PATH%
pm2 resurrect
CMDEOF
  schtasks //Create //TN "ClaudeMobile" //TR "$(cygpath -w "$INSTALL_DIR/pm2-resurrect.cmd")" //SC ONLOGON //RL HIGHEST //F > /dev/null 2>&1 \
    && ok "ClaudeMobile auto-start registered" \
    || warn "Could not register auto-start task"

  say "Registering watchdog task..."
  WATCHDOG_CMD="powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File $(cygpath -w "$INSTALL_DIR/watchdog.ps1")"
  schtasks //Create //TN "ClaudeMobileWatchdog" //TR "$WATCHDOG_CMD" //SC MINUTE //MO 5 //RL HIGHEST //F > /dev/null 2>&1 \
    && ok "Watchdog registered (every 5 min)" \
    || warn "Could not register watchdog task"

else
  say "Step 5/7: tmux setup..."
  if command -v tmux &>/dev/null; then
    ok "tmux $(tmux -V | cut -d' ' -f2) found"
  else
    warn "tmux not found. Install it for session persistence:"
    echo -e "    macOS: ${DIM}brew install tmux${RESET}"
    echo -e "    Linux: ${DIM}sudo apt install tmux${RESET}"
  fi
fi

# ── Step 6: Configure projects ───────────────────────────
say "Step 6/7: Configure project directories..."

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

  cat > config.json << JSONEOF
{
  "port": $PORT,
  "tailscaleHostname": "$TS_HOSTNAME",
  "inactivityTimeout": 15,
  "autoStart": ["$MAIN_NAME"],
  "defaultDir": "$(echo "$MAIN_DIR" | sed 's/\\/\\\\/g')",
  "projects": $PROJECTS
}
JSONEOF
  ok "config.json created"
fi

# PM2 setup
if ! command -v pm2 &>/dev/null; then
  ask "Install PM2 for background running? (recommended) (y/n)"
  if [[ "$REPLY" =~ ^[Yy] ]]; then
    npm install -g pm2 2>&1 | tail -3
    ok "PM2 installed"
  fi
else
  ok "PM2 $(pm2 -v 2>/dev/null | tail -1)"
fi

# ── Step 7: Start + TOTP setup ───────────────────────────
echo ""
say "Step 7/7: Starting server for TOTP setup..."
node server.js &
SERVER_PID=$!
sleep 4

if ! kill -0 $SERVER_PID 2>/dev/null; then
  fail "Server failed to start. Check for port conflicts on $PORT"
fi
ok "Server running on port $PORT"

echo ""
echo -e "${BOLD}+========================================================+${RESET}"
echo -e "${BOLD}|                 FINAL SETUP (2 minutes)                |${RESET}"
echo -e "${BOLD}+========================================================+${RESET}"
echo -e "${BOLD}|${RESET}                                                        ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}  ${BOLD}On your laptop:${RESET}                                       ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    1. Open ${GREEN}http://localhost:$PORT/setup${RESET}                 ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    2. Scan QR code with iPhone camera                  ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    3. Enter 6-digit code to verify                     ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}                                                        ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}  ${BOLD}On your iPhone:${RESET}                                       ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    4. Open ${GREEN}https://$TS_HOSTNAME${RESET}"
echo -e "${BOLD}|${RESET}    5. Enter TOTP code to log in                        ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}    6. Register Face ID when prompted (optional)        ${BOLD}|${RESET}"
echo -e "${BOLD}|${RESET}                                                        ${BOLD}|${RESET}"
echo -e "${BOLD}+========================================================+${RESET}"
echo ""
echo -e "  ${DIM}After setup, run in background:${RESET}"
echo -e "    ${BOLD}pm2 start server.js --name claude-mobile && pm2 save${RESET}"
echo ""
echo -e "  ${DIM}Update anytime:${RESET}"
echo -e "    ${BOLD}bash update.sh${RESET}"
echo ""
echo -e "  ${DIM}Press Ctrl+C to stop the server when done with setup.${RESET}"
echo ""

wait $SERVER_PID 2>/dev/null
