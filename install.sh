#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Claude Mobile -- Single-file installer
# Installs dependencies, configures Tailscale, sets up auth.
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

PORT=3456

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║       Claude Mobile Installer        ║${RESET}"
echo -e "${BOLD}║  Mobile terminal gateway for Claude  ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${DIM}Before you start, make sure you have:${RESET}"
echo -e "  ${DIM}  1. Tailscale installed on this computer${RESET}"
echo -e "  ${DIM}  2. Tailscale installed on your iPhone (App Store)${RESET}"
echo -e "  ${DIM}  3. Both devices signed into the same Tailscale account${RESET}"
echo ""

# ── Step 1: Check prerequisites ──────────────────────────
say "Step 1/6: Checking prerequisites..."

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

# ── Step 2: Tailscale ────────────────────────────────────
say "Step 2/6: Setting up Tailscale..."

TS_CMD=""
if command -v tailscale &>/dev/null; then
  TS_CMD="tailscale"
elif [ -f "/c/Program Files/Tailscale/tailscale.exe" ]; then
  TS_CMD="/c/Program Files/Tailscale/tailscale.exe"
elif [ -f "C:\\Program Files\\Tailscale\\tailscale.exe" ]; then
  TS_CMD="C:\\Program Files\\Tailscale\\tailscale.exe"
fi

if [ -n "$TS_CMD" ]; then
  ok "Tailscale CLI found"
else
  echo ""
  echo -e "  ${RED}Tailscale is required for Claude Mobile v2.${RESET}"
  echo ""
  echo -e "  Install it now:"
  echo -e "    Windows: ${DIM}winget install Tailscale.Tailscale${RESET}"
  echo -e "    macOS:   ${DIM}brew install tailscale${RESET}"
  echo -e "    Linux:   ${DIM}curl -fsSL https://tailscale.com/install.sh | sh${RESET}"
  echo ""
  echo -e "  Then install Tailscale on your iPhone from the App Store."
  echo -e "  Sign into the same account on both devices."
  echo ""
  fail "Install Tailscale and run this installer again."
fi

TS_HOSTNAME=""
if ! "$TS_CMD" status &>/dev/null 2>&1; then
  echo ""
  warn "Tailscale is installed but not connected."
  echo -e "  ${DIM}Run: ${BOLD}tailscale up${RESET}"
  echo -e "  ${DIM}Then run this installer again.${RESET}"
  echo ""
  fail "Connect Tailscale first (tailscale up)."
fi

ok "Tailscale connected"
TS_HOSTNAME=$("$TS_CMD" status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/\.$//' | sed 's/"$//')
if [ -z "$TS_HOSTNAME" ]; then
  echo ""
  echo -e "  ${DIM}Could not auto-detect your Tailscale hostname.${RESET}"
  echo -e "  ${DIM}Find it at: Settings > Machines in the Tailscale app.${RESET}"
  ask "Tailscale hostname (e.g., your-machine.tail12345.ts.net)"
  TS_HOSTNAME="$REPLY"
  if [ -z "$TS_HOSTNAME" ]; then
    fail "Hostname is required for HTTPS and passkey support."
  fi
fi
ok "Hostname: $TS_HOSTNAME"

# Configure tailscale serve (HTTPS -> localhost)
echo ""
say "Configuring HTTPS proxy..."
echo -e "  ${DIM}This makes https://$TS_HOSTNAME route to localhost:$PORT${RESET}"
SERVE_OUTPUT=$("$TS_CMD" serve --bg http://localhost:$PORT 2>&1) && ok "tailscale serve configured" || {
  if echo "$SERVE_OUTPUT" | grep -qi "not enabled"; then
    echo ""
    echo -e "  ${YELLOW}Tailscale Serve needs to be enabled on your tailnet.${RESET}"
    echo -e "  ${DIM}A browser window should open. Click 'Enable' and re-run this step.${RESET}"
    # Extract the enable URL if present
    ENABLE_URL=$(echo "$SERVE_OUTPUT" | grep -o 'https://login.tailscale.com/[^ ]*' | head -1)
    if [ -n "$ENABLE_URL" ]; then
      echo -e "  ${GREEN}$ENABLE_URL${RESET}"
    fi
    echo ""
    ask "Press Enter after enabling Tailscale Serve, then we'll retry"
    "$TS_CMD" serve --bg http://localhost:$PORT 2>/dev/null && ok "tailscale serve configured" || {
      warn "tailscale serve still failed. Configure manually after install:"
      echo -e "  ${DIM}tailscale serve --bg http://localhost:$PORT${RESET}"
    }
  else
    warn "tailscale serve failed. Configure manually after install:"
    echo -e "  ${DIM}tailscale serve --bg http://localhost:$PORT${RESET}"
  fi
}

# ── Step 3: Install npm dependencies ─────────────────────
say "Step 3/6: Installing dependencies..."
npm install --production 2>&1 | tail -3
ok "Dependencies installed"

# ── Step 4: Configure projects ───────────────────────────
say "Step 4/6: Configure project directories..."
echo ""
echo -e "  ${DIM}Claude Mobile opens Claude Code in a project directory."
echo -e "  Tell me your main project folder.${RESET}"
echo ""

ask "Main project path (e.g., C:\\Users\\me\\Projects\\my-project)"
MAIN_DIR="$REPLY"
if [ -z "$MAIN_DIR" ]; then
  fail "No project path provided"
fi

ask "Short name for this project (e.g., 'My Project')"
MAIN_NAME="${REPLY:-Main Project}"

# Ask for additional projects
PROJECTS="[{\"name\":\"$MAIN_NAME\",\"dir\":\"$MAIN_DIR\"}"
echo ""
echo -e "  ${DIM}You can add more project directories (up to 4 total).${RESET}"
for i in 2 3 4; do
  ask "Additional project path #$i (or Enter to skip)"
  if [ -z "$REPLY" ]; then
    break
  fi
  EXTRA_DIR="$REPLY"
  ask "Short name for this project"
  EXTRA_NAME="${REPLY:-Project $i}"
  PROJECTS="$PROJECTS,{\"name\":\"$EXTRA_NAME\",\"dir\":\"$EXTRA_DIR\"}"
done
PROJECTS="$PROJECTS]"

# Write config.json
MAIN_DIR_ESC=$(echo "$MAIN_DIR" | sed 's/\\/\\\\/g')
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

# ── Step 5: PM2 + launcher scripts ───────────────────────
say "Step 5/6: Setting up PM2 and launchers..."

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

INSTALL_DIR="$(pwd)"

# Bash launcher
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

# ── Step 6: Start server + TOTP setup ────────────────────
echo ""
say "Step 6/6: Starting server for TOTP setup..."
node server.js &
SERVER_PID=$!
sleep 4

if ! kill -0 $SERVER_PID 2>/dev/null; then
  fail "Server failed to start. Check for port conflicts on $PORT"
fi
ok "Server running on port $PORT"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║                 FINAL SETUP (2 minutes)                 ║${RESET}"
echo -e "${BOLD}╠══════════════════════════════════════════════════════════╣${RESET}"
echo -e "${BOLD}║                                                        ║${RESET}"
echo -e "${BOLD}║${RESET}  ${BOLD}On your laptop:${RESET}                                       ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}                                                        ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}    1. Open ${GREEN}http://localhost:$PORT/setup${RESET}                 ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}    2. Scan the QR code with your iPhone camera         ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}       (saves to Apple Passwords automatically)         ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}    3. Enter the 6-digit code to verify                 ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}                                                        ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}  ${BOLD}On your iPhone:${RESET}                                       ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}                                                        ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}    4. Open ${GREEN}https://$TS_HOSTNAME${RESET}"
echo -e "${BOLD}║${RESET}    5. Enter your TOTP code to log in                   ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}    6. (Optional) Register Face ID when prompted        ${BOLD}║${RESET}"
echo -e "${BOLD}║${RESET}                                                        ${BOLD}║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${DIM}After setup, run Claude Mobile in the background:${RESET}"
echo -e "    ${BOLD}pm2 start server.js --name claude-mobile && pm2 save${RESET}"
echo ""
echo -e "  ${DIM}Press Ctrl+C to stop the server when done with setup.${RESET}"
echo ""

# Wait for server
wait $SERVER_PID 2>/dev/null
