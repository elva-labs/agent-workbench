#!/usr/bin/env bash
#
# Run the WebDriver tier against the real binary.
#
# Needs tauri-driver and the platform's WebView driver on PATH: on Linux
# `cargo install tauri-driver` and the webkit2gtk-driver package. On a
# headless machine it brings up Xvfb and a window manager first. The debug
# binary loads the dev server, which is started here if it is not up.
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

if [[ ! -x "src-tauri/target/debug/agent-workbench" ]]; then
  echo "building the core first..."
  cargo build --manifest-path src-tauri/Cargo.toml
fi

if [[ -z "${DISPLAY:-}" ]]; then
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
  npx vite preview --port 1420 --strictPort >/dev/null 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 60); do
    curl -sf http://localhost:1420 >/dev/null && break
    sleep 1
  done
  curl -sf http://localhost:1420 >/dev/null || { echo "the preview server never came up"; exit 1; }
fi

npx vitest run --config vitest.driver.config.ts "$@"
