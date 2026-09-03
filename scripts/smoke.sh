#!/usr/bin/env bash
#
# Boot the real app and photograph it.
#
# The Playwright suite drives the frontend in Chromium; this drives the actual
# Tauri binary under WebKitGTK, which is the renderer that will differ. On a
# headless machine it runs against Xvfb; on a desktop it uses the display you
# already have. Either way it fails loudly if the window never appears.
#
#   scripts/smoke.sh [output.png]
#
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${1:-smoke.png}"
BIN="src-tauri/target/debug/agent-workbench"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

if [[ ! -x "$BIN" ]]; then
  echo "building the core first..."
  cargo build --manifest-path src-tauri/Cargo.toml
fi

HEADLESS=0
if [[ -z "${DISPLAY:-}" ]]; then
  HEADLESS=1
  export DISPLAY=:99
  # WebKitGTK's compositor has no GPU to talk to under Xvfb.
  export WEBKIT_DISABLE_COMPOSITING_MODE=1
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
  Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
  PIDS+=($!)
  sleep 2
  # A window manager, so the window can take focus and receive keystrokes.
  openbox >/dev/null 2>&1 &
  PIDS+=($!)
  sleep 1
fi

npm run dev >/dev/null 2>&1 &
PIDS+=($!)

for _ in $(seq 1 60); do
  curl -sf http://localhost:1420 >/dev/null && break
  sleep 1
done
curl -sf http://localhost:1420 >/dev/null || { echo "dev server never came up"; exit 1; }

"./$BIN" >/dev/null 2>&1 &
APP=$!
PIDS+=("$APP")

for _ in $(seq 1 30); do
  xdotool search --name "Agent Workbench" >/dev/null 2>&1 && break
  sleep 1
done

if ! xdotool search --name "Agent Workbench" >/dev/null 2>&1; then
  echo "the window never appeared"
  exit 1
fi

kill -0 "$APP" 2>/dev/null || { echo "the app exited on startup"; exit 1; }

sleep 6
import -window root "$OUT"
echo "window is up; wrote $OUT"

if [[ "$HEADLESS" == "1" ]]; then
  echo "(headless: rendered by Xvfb, so treat colour and font as indicative)"
fi
