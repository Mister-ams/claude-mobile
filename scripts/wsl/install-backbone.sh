#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Claude Mobile -- install the WSL session backbone (T08)
#
# Runs INSIDE the WSL distro as root:
#   wsl -d Ubuntu-24.04 -u root -- bash scripts/wsl/install-backbone.sh
#
# 1. pins systemd=true in /etc/wsl.conf
# 2. installs the backbone script into the distro's own filesystem
# 3. installs + enables the systemd unit
#
# Idempotent: safe to re-run on every install/update.
#
# The backbone script is COPIED into /usr/local/lib rather than run from
# /mnt/c, because the Windows drive is not mounted early in boot and is slow.
# ─────────────────────────────────────────────────────────
set -euo pipefail

# Source dir may be passed in ($1) because the caller can pipe this script
# through sed to strip CR, which makes $0 unreliable.
SRC_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
LIB_DIR=/usr/local/lib/claude-mobile
UNIT_NAME=claude-mobile-backbone.service
UNIT_DST=/etc/systemd/system/"$UNIT_NAME"
WSL_CONF=/etc/wsl.conf

[ "$(id -u)" -eq 0 ] || { echo "FATAL: must run as root (use wsl -u root)" >&2; exit 1; }

# ── 1. Pin systemd ───────────────────────────────────────
# Recent WSL releases start systemd for Ubuntu-24.04 without /etc/wsl.conf.
# That is an undocumented default, not a guarantee, and the backbone unit
# depends on it -- so state it explicitly.
if [ ! -f "$WSL_CONF" ]; then
  printf '[boot]\nsystemd=true\n' > "$WSL_CONF"
  echo "  created $WSL_CONF with systemd=true"
elif grep -Eq '^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true' "$WSL_CONF"; then
  echo "  $WSL_CONF already sets systemd=true"
elif grep -Eq '^[[:space:]]*systemd[[:space:]]*=' "$WSL_CONF"; then
  sed -i -E 's/^[[:space:]]*systemd[[:space:]]*=.*/systemd=true/' "$WSL_CONF"
  echo "  $WSL_CONF: flipped systemd to true"
elif grep -Eq '^[[:space:]]*\[boot\]' "$WSL_CONF"; then
  sed -i -E '0,/^[[:space:]]*\[boot\]/s//[boot]\nsystemd=true/' "$WSL_CONF"
  echo "  $WSL_CONF: added systemd=true under the existing [boot] section"
else
  printf '\n[boot]\nsystemd=true\n' >> "$WSL_CONF"
  echo "  $WSL_CONF: appended [boot] systemd=true"
fi

# ── 2. Install the backbone script ───────────────────────
# CR is stripped on the way in: the repo is checked out on Windows with
# core.autocrlf=true, and a CRLF script fails under bash with
# `\r: command not found`.
install -d -m 0755 "$LIB_DIR"
sed 's/\r$//' "$SRC_DIR/backbone-dtach.sh" > "$LIB_DIR/backbone-dtach.sh"
chmod 0755 "$LIB_DIR/backbone-dtach.sh"
echo "  installed $LIB_DIR/backbone-dtach.sh"

# ── 3. Install + enable the unit ─────────────────────────
sed 's/\r$//' "$SRC_DIR/$UNIT_NAME" > "$UNIT_DST"
chmod 0644 "$UNIT_DST"
echo "  installed $UNIT_DST"

if [ "$(ps -p 1 -o comm=)" != "systemd" ]; then
  echo "  !! systemd is not PID 1 yet -- run 'wsl --shutdown' on Windows, then"
  echo "     re-run this script to enable the unit."
  exit 0
fi

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
systemctl --no-pager --lines=0 status "$UNIT_NAME" | head -3
echo "  backbone enabled"
