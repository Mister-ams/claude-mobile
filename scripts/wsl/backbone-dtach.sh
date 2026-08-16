#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# Claude Mobile -- W0 session backbone (dtach)
#
# WSL terminates a distro once nothing is running inside it. Session dtach
# daemons are started through Windows interop and do not reliably hold the
# distro open by themselves, so when the Node server exits the whole distro
# can go down and take every session with it. This process is the thing that
# stays running.
#
# It deliberately does NOT own the sessions: server.js creates them on demand
# via `wsl -u root -- dtach -n`, so they are not children of this unit. That
# is what lets the backbone restart without disturbing live sessions.
#
# Wave 5 (T33) retires this script by repointing the unit's ExecStart at the
# herdr daemon. Keep anything herdr would also need in the unit file, not here.
# ─────────────────────────────────────────────────────────
set -euo pipefail

SOCKET_DIR="${CM_SOCKET_DIR:-/tmp}"
PREFIX="${CM_DTACH_PREFIX:-cm}"
POLL_SECONDS="${CM_POLL_SECONDS:-60}"

if ! command -v dtach >/dev/null 2>&1; then
  echo "FATAL: dtach is not installed -- sessions cannot persist" >&2
  exit 1
fi

mkdir -p "$SOCKET_DIR"
echo "backbone up (dtach); watching ${SOCKET_DIR}/${PREFIX}-*.dtach"

# A socket file left behind by a dead daemon still passes server.js's
# `test -S` liveness check, so count live and stale separately and say so.
# Nothing is deleted here: removing a socket whose daemon is still running
# would orphan a live session, which is worse than reporting a stale one.
count_sockets() {
  local live=0 stale=0 s listening
  listening="$(ss -lxH 2>/dev/null || true)"
  shopt -s nullglob
  for s in "${SOCKET_DIR}/${PREFIX}"-*.dtach; do
    if printf '%s' "$listening" | grep -qF "$s"; then
      live=$((live + 1))
    else
      stale=$((stale + 1))
    fi
  done
  shopt -u nullglob
  printf '%s %s' "$live" "$stale"
}

# Log on change only -- a 60s heartbeat would bury the journal.
prev=""
while :; do
  cur="$(count_sockets)"
  if [ "$cur" != "$prev" ]; then
    read -r live stale <<<"$cur"
    if [ "$stale" -gt 0 ]; then
      echo "sessions: ${live} live, ${stale} stale socket(s) in ${SOCKET_DIR}"
    else
      echo "sessions: ${live} live"
    fi
    prev="$cur"
  fi
  sleep "$POLL_SECONDS"
done
