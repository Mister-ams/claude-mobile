#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Claude Mobile -- Single-file installer
# Installs dependencies, configures projects, sets up ngrok,
# and runs the initial TOTP setup.
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
ask()  { echo -en "${BOLD}${BLUE}>>>${RESET} $1: "; read -r REPLY; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║       Claude Mobile Installer        ║${RESET}"
echo -e "${BOLD}║  Mobile terminal gateway for Claude  ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""

# ── Step 1: Check prerequisites ──────────────────────────
say "Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install from https://nodejs.org (v18+)"
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js $NODE_VER found, v18+ required"
fi
ok "Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm not found"
fi
ok "npm $(npm -v)"

# Claude Code
if ! command -v claude &>/dev/null; then
  warn "Claude Code CLI not found in PATH"
  warn "Install it before running the server: https://claude.ai/claude-code"
else
  ok "Claude Code CLI found"
fi

# ── Step 2: Install npm dependencies ─────────────────────
say "Installing dependencies..."
npm install --production 2>&1 | tail -3
ok "Dependencies installed"

# ── Step 3: Configure projects ───────────────────────────
say "Setting up your project configuration..."
echo ""
echo -e "  ${DIM}Claude Mobile opens Claude Code in a project directory."
echo -e "  Tell me your main project folder (where you run Claude Code).${RESET}"
echo ""

ask "Main project path (e.g., /home/user/my-project or C:\\Users\\me\\Projects\\my-project)"
MAIN_DIR="$REPLY"

if [ -z "$MAIN_DIR" ]; then
  fail "No project path provided"
fi

MAIN_NAME=""
ask "Short name for this project (e.g., 'My Project')"
MAIN_NAME="$REPLY"
if [ -z "$MAIN_NAME" ]; then
  MAIN_NAME="Main Project"
fi

# Ask for additional projects
PROJECTS="[{\"name\":\"$MAIN_NAME\",\"dir\":\"$MAIN_DIR\"}"
echo ""
echo -e "  ${DIM}You can add more project directories (up to 4 total).${RESET}"
for i in 2 3 4; do
  ask "Additional project path #$i (or press Enter to skip)"
  if [ -z "$REPLY" ]; then
    break
  fi
  EXTRA_DIR="$REPLY"
  ask "Short name for this project"
  EXTRA_NAME="${REPLY:-Project $i}"
  PROJECTS="$PROJECTS,{\"name\":\"$EXTRA_NAME\",\"dir\":\"$EXTRA_DIR\"}"
done
PROJECTS="$PROJECTS]"

# ── Step 4: ngrok setup ──────────────────────────────────
say "Setting up ngrok for remote access..."
echo ""

NGROK_CMD=""
if command -v ngrok &>/dev/null; then
  NGROK_CMD="ngrok"
  ok "ngrok found in PATH"
else
  # Check common install locations (Windows)
  for candidate in \
    "$LOCALAPPDATA/Microsoft/WinGet/Packages/Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe/ngrok.exe" \
    "$LOCALAPPDATA/ngrok/ngrok.exe" \
    "/usr/local/bin/ngrok" \
    "/opt/homebrew/bin/ngrok"; do
    if [ -f "$candidate" ]; then
      NGROK_CMD="$candidate"
      ok "ngrok found at $candidate"
      break
    fi
  done
fi

if [ -z "$NGROK_CMD" ]; then
  echo ""
  echo -e "  ${DIM}ngrok provides a permanent URL for phone access from any network."
  echo -e "  Without it, you can only use Claude Mobile on the same WiFi.${RESET}"
  echo ""
  echo -e "  ${BOLD}Install ngrok:${RESET}"
  echo -e "    Windows: ${DIM}winget install ngrok.ngrok${RESET}"
  echo -e "    macOS:   ${DIM}brew install ngrok${RESET}"
  echo -e "    Linux:   ${DIM}snap install ngrok${RESET}"
  echo ""
  ask "Install ngrok now? (y/n)"
  if [[ "$REPLY" =~ ^[Yy] ]]; then
    if command -v winget &>/dev/null; then
      winget install ngrok.ngrok --accept-source-agreements --accept-package-agreements 2>&1 | tail -3
    elif command -v brew &>/dev/null; then
      brew install ngrok 2>&1 | tail -3
    elif command -v snap &>/dev/null; then
      sudo snap install ngrok 2>&1 | tail -3
    else
      fail "No package manager found. Install ngrok manually: https://ngrok.com/download"
    fi
    NGROK_CMD="ngrok"
    ok "ngrok installed"
  else
    warn "Skipping ngrok -- local-only access"
  fi
fi

NGROK_DOMAIN=""
if [ -n "$NGROK_CMD" ]; then
  echo ""
  echo -e "  ${DIM}You need a free ngrok account with a static domain."
  echo -e "  1. Sign up at https://dashboard.ngrok.com/signup (free)"
  echo -e "  2. Copy your authtoken from the dashboard"
  echo -e "  3. Get your free static domain from Domains page${RESET}"
  echo ""

  # Check if already authenticated
  if ! "$NGROK_CMD" config check &>/dev/null 2>&1; then
    ask "ngrok authtoken (from dashboard.ngrok.com)"
    if [ -n "$REPLY" ]; then
      "$NGROK_CMD" config add-authtoken "$REPLY" 2>&1
      ok "ngrok authenticated"
    fi
  else
    ok "ngrok already authenticated"
  fi

  ask "ngrok static domain (e.g., your-name.ngrok-free.dev)"
  NGROK_DOMAIN="$REPLY"
  if [ -n "$NGROK_DOMAIN" ]; then
    ok "Domain: $NGROK_DOMAIN"
  else
    warn "No domain provided -- tunnel will use random URLs (passkeys won't persist)"
  fi
fi

# ── Step 5: Write config.json ────────────────────────────
say "Writing configuration..."

# Escape backslashes for JSON on Windows paths
MAIN_DIR_ESC=$(echo "$MAIN_DIR" | sed 's/\\/\\\\/g')

PORT=3456
cat > config.json << JSONEOF
{
  "port": $PORT,
  "ngrokDomain": "$NGROK_DOMAIN",
  "autoStart": ["$MAIN_NAME"],
  "defaultDir": "$MAIN_DIR_ESC",
  "projects": $PROJECTS
}
JSONEOF

ok "config.json created"

# ── Step 6: Install PM2 ─────────────────────────────────
say "Setting up PM2 (background daemon)..."

if ! command -v pm2 &>/dev/null; then
  ask "Install PM2 for background running? (recommended) (y/n)"
  if [[ "$REPLY" =~ ^[Yy] ]]; then
    npm install -g pm2 2>&1 | tail -3
    ok "PM2 installed"
  else
    warn "Skipping PM2 -- run manually with 'node server.js'"
  fi
else
  ok "PM2 already installed"
fi

# ── Step 7: Windows firewall ─────────────────────────────
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "$WINDIR" ]]; then
  say "Windows detected -- checking firewall..."
  echo -e "  ${DIM}For local network access (same WiFi), a firewall rule is needed.${RESET}"
  ask "Add firewall rule for port $PORT? Requires admin (y/n)"
  if [[ "$REPLY" =~ ^[Yy] ]]; then
    powershell.exe -Command "Start-Process powershell -Verb RunAs -ArgumentList '-Command New-NetFirewallRule -DisplayName \"Claude Mobile\" -Direction Inbound -Protocol TCP -LocalPort $PORT -Action Allow -Profile Private'" 2>/dev/null
    ok "Firewall rule added (or admin prompt shown)"
  fi
fi

# ── Step 8: Start server and run setup ───────────────────
echo ""
say "Starting Claude Mobile server..."
node server.js &
SERVER_PID=$!
sleep 4

# Check if server started
if ! kill -0 $SERVER_PID 2>/dev/null; then
  fail "Server failed to start. Check for port conflicts on $PORT"
fi
ok "Server running on port $PORT (PID $SERVER_PID)"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║                    SETUP REQUIRED                       ║${RESET}"
echo -e "${BOLD}╠══════════════════════════════════════════════════════════╣${RESET}"
echo -e "${BOLD}║                                                        ║${RESET}"
echo -e "${BOLD}║${RESET}  Open this URL in your laptop browser:                 ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}                                                        ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}  ${GREEN}http://localhost:$PORT/setup${RESET}                          ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}                                                        ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}  This page sets up authentication:                     ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}  1. Scan the QR code with your iPhone camera           ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}  2. Apple Passwords saves the verification code        ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}  3. Enter the 6-digit code to verify                   ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}                                                        ${BOLD}║${RESET}"
if [ -n "$NGROK_DOMAIN" ]; then
echo -e "${BOLD}║${RESET}  Then open on your phone:                              ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}  ${GREEN}https://$NGROK_DOMAIN${RESET}"
echo -e "${BOLD}║${RESET}                                                        ${BOLD}║${RESET}"
fi
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""

if [ -n "$NGROK_DOMAIN" ]; then
  echo -e "  ${DIM}After setup, use PM2 for background running:${RESET}"
  echo -e "    ${DIM}pm2 start server.js --name claude-mobile${RESET}"
  echo -e "    ${DIM}pm2 save${RESET}"
fi

echo ""
echo -e "  ${DIM}Press Ctrl+C to stop the server when done with setup.${RESET}"
echo ""

# Wait for server
wait $SERVER_PID 2>/dev/null
