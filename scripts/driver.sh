#!/usr/bin/env bash
#
# Run the WebDriver tier against the real binary.
#
# Needs the platform's WebView driver: on Linux `cargo install tauri-driver`
# and the webkit2gtk-driver package. On Windows only Edge WebDriver, matching
# the WebView2 runtime, in TAURI_NATIVE_DRIVER -- the harness starts the app
# and attaches, so tauri-driver is not in the picture there. On a headless
# machine it brings up Xvfb and a window manager first. The debug binary
# loads the dev server, which is started here if it is not up.
#
#   scripts/driver.sh [vitest args]
#
set -euo pipefail

cd "$(dirname "$0")/.."

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

BIN="src-tauri/target/debug/agent-workbench"
[[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]] && BIN="$BIN.exe"
if [[ ! -x "$BIN" ]]; then
  echo "building the core first..."
  cargo build --workspace --manifest-path src-tauri/Cargo.toml
fi

# A display is only something to arrange on Linux.
if [[ "$(uname -s)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  export DISPLAY=:99
  Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
  PIDS+=($!)
  sleep 2
  openbox >/dev/null 2>&1 &
  PIDS+=($!)
  sleep 1
fi

# The debug binary loads the frontend from the dev URL. What answers there
# is the built frontend, served static: the dev server compiles on demand and
# a first request racing that compile gets raw source served as CSS.
if ! curl -sf http://localhost:1420 >/dev/null; then
  npm run build >/dev/null 2>&1 || { echo "the frontend did not build"; exit 1; }
  # vite itself, not npx: the pid kept is then the server's, and the trap
  # ends it rather than leaving a child on the port for the next run.
  node node_modules/vite/bin/vite.js preview --port 1420 --strictPort >/dev/null 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 60); do
    curl -sf http://localhost:1420 >/dev/null && break
    sleep 1
  done
  curl -sf http://localhost:1420 >/dev/null || { echo "the preview server never came up"; exit 1; }
fi

npx vitest run --config vitest.driver.config.ts "$@"
