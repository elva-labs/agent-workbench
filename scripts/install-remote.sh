#!/bin/sh
#
# Puts the Chord daemon on this machine, for a desktop to reach
# over ssh: the build for this machine from the latest release, under
# ~/.chord/bin, and has it move over an install made under the app's
# earlier name, a pairing included. Then `chord-remote connect` prints the
# token to paste into the desktop.
#
#   curl -fsSL https://raw.githubusercontent.com/elva-labs/chord/main/scripts/install-remote.sh | sh
#
# CHORD_VERSION picks a release other than the latest, as v0.2.0.
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

repo="elva-labs/chord"
if [ -n "${CHORD_VERSION:-}" ]; then
  url="https://github.com/$repo/releases/download/$CHORD_VERSION/chord-remote-$os-$arch"
else
  url="https://github.com/$repo/releases/latest/download/chord-remote-$os-$arch"
fi

dir="$HOME/.chord/bin"
umask 077
mkdir -p "$dir"
echo "fetching $url"
curl -fsSL "$url" -o "$dir/chord-remote.new"
chmod +x "$dir/chord-remote.new"
mv "$dir/chord-remote.new" "$dir/chord-remote"
echo "installed $("$dir/chord-remote" version) at $dir/chord-remote"
"$dir/chord-remote" migrate
echo "to pair this machine with a desktop, run: $dir/chord-remote connect"
