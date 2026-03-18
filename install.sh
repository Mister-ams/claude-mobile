#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Claude Mobile -- Single-file installer
# Installs dependencies, configures projects, sets up Tailscale,
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

# ── Step 4: Tailscale setup ────────────────────────────────
say "Setting up Tailscale for secure remote access..."
echo ""
echo -e "  ${DIM}Tailscale creates a private VPN between your devices."
echo -e "  No public URLs. WireGuard encryption. Zero config networking.${RESET}"
echo ""

TS_CMD=""
if command -v tailscale &>/dev/null; then
  TS_CMD="tailscale"
  ok "Tailscale CLI found"
else
  echo -e "  ${BOLD}Install Tailscale:${RESET}"
  echo -e "    Windows: ${DIM}winget install Tailscale.Tailscale${RESET}"
  echo -e "    macOS:   ${DIM}brew install tailscale${RESET}"
  echo -e "    Linux:   ${DIM}curl -fsSL https://tailscale.com/install.sh | sh${RESET}"
  echo ""
  warn "Install Tailscale, then run this installer again."
  warn "Also install Tailscale on your iPhone from the App Store."
  echo ""
fi

TS_HOSTNAME=""
if [ -n "$TS_CMD" ]; then
  # Check if logged in
  if ! "$TS_CMD" status &>/dev/null 2>&1; then
    warn "Tailscale not connected. Run: tailscale up"
  else
    ok "Tailscale connected"
    # Try to extract MagicDNS hostname
    TS_HOSTNAME=$("$TS_CMD" status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/\.$//' | sed 's/"$//')
    if [ -n "$TS_HOSTNAME" ]; then
      ok "MagicDNS hostname: $TS_HOSTNAME"
    else
      ask "Tailscale MagicDNS hostname (e.g., your-machine.tail12345.ts.net)"
      TS_HOSTNAME="$REPLY"
    fi
  fi

  if [ -n "$TS_HOSTNAME" ]; then
    # Set up tailscale serve for HTTPS
    echo ""
    say "Configuring tailscale serve (HTTPS proxy)..."
    echo -e "  ${DIM}This proxies https://$TS_HOSTNAME -> localhost:$PORT${RESET}"
    "$TS_CMD" serve https / http://localhost:$PORT 2>/dev/null && ok "tailscale serve configured" || warn "tailscale serve failed -- configure manually"
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
  "tailscaleHostname": "$TS_HOSTNAME",
  "inactivityTimeout": 15,
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

# ── Step 8: Create launcher scripts ──────────────────────
say "Creating launcher scripts..."

INSTALL_DIR="$(pwd)"

# Bash launcher (macOS / Linux / Git Bash on Windows)
cat > claude-mobile << 'LAUNCHEOF'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if command -v pm2 &>/dev/null; then
  PM_LIST=$(pm2 list --no-color 2>/dev/null)
  if echo "$PM_LIST" | grep -q "claude-mobile.*online"; then
    echo ""
    echo "  Claude Mobile is running."
  else
    pm2 start "$SCRIPT_DIR/server.js" --name claude-mobile --silent
    echo ""
    echo "  Claude Mobile started."
  fi
  sleep 3
  LOGS=$(pm2 logs claude-mobile --lines 30 --nostream 2>&1)
  echo ""
  echo "  ============================================"
  echo "  Local: http://localhost:3456"
  echo "  ============================================"
  echo ""
  echo "  Commands:"
  echo "    pm2 logs claude-mobile     # view logs"
  echo "    pm2 restart claude-mobile  # restart"
  echo "    pm2 stop claude-mobile     # stop"
  echo ""
else
  echo "  Starting Claude Mobile (foreground)..."
  echo "  Press Ctrl+C to stop."
  echo ""
  node "$SCRIPT_DIR/server.js"
fi
LAUNCHEOF
chmod +x claude-mobile
ok "Created: ./claude-mobile (bash launcher)"

# Windows batch launcher
cat > claude-mobile.bat << BATEOF
@echo off
title Claude Mobile
cd /d "%~dp0"
where pm2 >nul 2>&1
if %errorlevel%==0 (
    pm2 list --no-color 2>nul | findstr /C:"claude-mobile" | findstr /C:"online" >nul 2>&1
    if %errorlevel%==0 (
        echo.
        echo   Claude Mobile is running.
    ) else (
        pm2 start server.js --name claude-mobile --silent
        echo.
        echo   Claude Mobile started.
    )
    timeout /t 3 /nobreak >nul
    echo.
    echo   Local: http://localhost:3456
    echo.
    pm2 logs claude-mobile --lines 10 --nostream 2>&1 | findstr /C:"Tailscale:" /C:"Local:"
    echo.
    echo   Commands:
    echo     pm2 logs claude-mobile
    echo     pm2 restart claude-mobile
    echo     pm2 stop claude-mobile
    echo.
    pause
) else (
    echo   Starting Claude Mobile...
    echo   Press Ctrl+C to stop.
    echo.
    node server.js
)
BATEOF
ok "Created: claude-mobile.bat (Windows launcher)"

# Create desktop shortcut on Windows
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "$WINDIR" ]]; then
  DESKTOP_PATH="$(cmd.exe /C 'echo %USERPROFILE%\Desktop' 2>/dev/null | tr -d '\r')"
  if [ -n "$DESKTOP_PATH" ]; then
    INSTALL_DIR_WIN=$(cygpath -w "$INSTALL_DIR" 2>/dev/null || echo "$INSTALL_DIR")
    powershell.exe -Command "
      \$ws = New-Object -ComObject WScript.Shell
      \$s = \$ws.CreateShortcut('$DESKTOP_PATH\\Claude Mobile.lnk')
      \$s.TargetPath = '$INSTALL_DIR_WIN\\claude-mobile.bat'
      \$s.WorkingDirectory = '$INSTALL_DIR_WIN'
      \$s.Description = 'Launch Claude Mobile Bridge'
      \$s.Save()
    " 2>/dev/null
    ok "Desktop shortcut created: Claude Mobile"
  fi
fi

# Create symlink in PATH on macOS/Linux
if [[ "$OSTYPE" != "msys" && "$OSTYPE" != "cygwin" && -z "$WINDIR" ]]; then
  if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
    ln -sf "$INSTALL_DIR/claude-mobile" /usr/local/bin/claude-mobile 2>/dev/null
    ok "Symlinked to /usr/local/bin/claude-mobile (run from anywhere)"
  elif [ -d "$HOME/.local/bin" ]; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$INSTALL_DIR/claude-mobile" "$HOME/.local/bin/claude-mobile" 2>/dev/null
    ok "Symlinked to ~/.local/bin/claude-mobile"
  fi
fi

# ── Step 9: Start server and run setup ───────────────────
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
if [ -n "$TS_HOSTNAME" ]; then
echo -e "${BOLD}║${RESET}  Then open on your phone (via Tailscale):               ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}  ${GREEN}https://$TS_HOSTNAME${RESET}"
echo -e "${BOLD}║${RESET}                                                        ${BOLD}║${RESET}"
fi
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""

echo -e "  ${DIM}After setup, use PM2 for background running:${RESET}"
echo -e "    ${DIM}pm2 start server.js --name claude-mobile${RESET}"
echo -e "    ${DIM}pm2 save${RESET}"

echo ""
echo -e "  ${DIM}Press Ctrl+C to stop the server when done with setup.${RESET}"
echo ""

# Wait for server
wait $SERVER_PID 2>/dev/null
