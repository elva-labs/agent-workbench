#!/bin/sh
#
# Puts the Agent Workbench daemon on this machine, for a desktop to reach
# over ssh: the build for this machine from the latest release, under
# ~/.agent-workbench/bin. Then `agent-workbench-remote connect` prints the
# token to paste into the desktop.
#
#   curl -fsSL https://raw.githubusercontent.com/elva-labs/agent-workbench/main/scripts/install-remote.sh | sh
#
# AGENT_WORKBENCH_VERSION picks a release other than the latest, as v0.2.0.
set -eu

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "no daemon build for $(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) echo "no daemon build for $(uname -m)"; exit 1 ;;
esac

repo="elva-labs/agent-workbench"
if [ -n "${AGENT_WORKBENCH_VERSION:-}" ]; then
  url="https://github.com/$repo/releases/download/$AGENT_WORKBENCH_VERSION/agent-workbench-remote-$os-$arch"
else
  url="https://github.com/$repo/releases/latest/download/agent-workbench-remote-$os-$arch"
fi

dir="$HOME/.agent-workbench/bin"
umask 077
mkdir -p "$dir"
echo "fetching $url"
curl -fsSL "$url" -o "$dir/agent-workbench-remote.new"
chmod +x "$dir/agent-workbench-remote.new"
mv "$dir/agent-workbench-remote.new" "$dir/agent-workbench-remote"
echo "installed $("$dir/agent-workbench-remote" version) at $dir/agent-workbench-remote"
echo "now run: $dir/agent-workbench-remote connect"
