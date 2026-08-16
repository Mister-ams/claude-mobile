#!/usr/bin/env bash
# spike-herdr-setup.sh -- Wave 1 / S1 environment setup.
#
# Installs herdr PINNED at v0.8.0 (pre-1.0 protocol bumps strand clients --
# the herdr.dev install.sh always takes "latest", so we fetch the release
# asset directly), and writes the minimal config the spike needs.
#
# Run inside WSL Ubuntu-24.04:
#   wsl -d Ubuntu-24.04 -- bash /mnt/c/.../.planning/spike-herdr-setup.sh
set -euo pipefail

HERDR_VERSION="v0.8.0"
BIN="$HOME/.local/bin/herdr"
CFG_DIR="$HOME/.config/herdr"
CFG="$CFG_DIR/config.toml"

mkdir -p "$HOME/.local/bin" "$CFG_DIR" /tmp/herdr-spike

if [ ! -x "$BIN" ] || ! "$BIN" --version 2>/dev/null | grep -q "0.8.0"; then
  echo "== downloading herdr $HERDR_VERSION (pinned) =="
  curl -fsSL -o "$BIN" \
    "https://github.com/herdrdev/herdr/releases/download/${HERDR_VERSION}/herdr-linux-x86_64"
  chmod +x "$BIN"
fi

echo "== version =="
"$BIN" --version
echo "== sha256 =="
sha256sum "$BIN"

# pane_history is OFF by default (secret-safety). We need it for scrollback
# replay across a server restart -- that is question 3 of the spike.
# resume_agents_on_restore defaults true but we set it explicitly so the
# spike is testing a known state, not a default we assumed.
cat > "$CFG" <<'TOML'
# herdr config -- claude-mobile S1 spike
[session]
resume_agents_on_restore = true

[experimental]
pane_history = true

[update]
# never auto-jump off the pinned protocol during the spike
version_check = false
manifest_check = false
TOML

echo "== config written =="
cat "$CFG"

echo "== config check =="
"$BIN" config check 2>&1 || true
