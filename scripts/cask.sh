#!/bin/sh
#
# Prints the Homebrew cask for a published release, checksums included, to
# put in the organisation's tap. The channel is stable, which is
# Casks/chord.rb, or beta, which is Casks/chord@beta.rb. Both install the
# same app, so each names the other as a conflict, and both name the casks
# the app had under its earlier name, agent-workbench and
# agent-workbench@beta, which install it under the same bundle identifier.
# The beta channel takes any version, a stable one too; the stable channel
# refuses a pre-release. docs/release.md says what else the tap holds.
#
#   scripts/cask.sh 1.0.0 > ../homebrew-elva/Casks/chord.rb
#   scripts/cask.sh 1.0.0-beta.4 beta > ../homebrew-elva/Casks/chord@beta.rb
set -eu

version="${1:?a version, as 0.1.0}"
channel="${2:-stable}"

case "$channel" in
  stable)
    case "$version" in
      *-*)
        echo "$version is a pre-release, which goes on the beta channel: scripts/cask.sh $version beta" >&2
        exit 1
        ;;
    esac
    token="chord"
    other="chord@beta"
    livecheck=$(cat <<'RUBY'
  livecheck do
    url :url
    strategy :github_latest
  end
RUBY
)
    ;;
  beta)
    token="chord@beta"
    other="chord"
    # Pre-releases count here, which the latest release never is.
    livecheck=$(cat <<'RUBY'
  livecheck do
    url :url
    regex(/^v?(\d+(?:\.\d+)+(?:-[0-9a-z.]+)?)$/i)
    strategy :github_releases do |json, regex|
      json.map do |release|
        next if release["draft"]

        match = release["tag_name"]&.match(regex)
        next if match.blank?

        match[1]
      end
    end
  end
RUBY
)
    ;;
  *)
    echo "a channel is stable or beta, not $channel" >&2
    exit 1
    ;;
esac

base="https://github.com/elva-labs/agent-workbench/releases/download/v$version"

sum() {
  curl -fsSL "$base/$1" | shasum -a 256 | cut -d' ' -f1
}

arm=$(sum "Chord_${version}_aarch64.dmg")
intel=$(sum "Chord_${version}_x64.dmg")

cat <<CASK
cask "$token" do
  version "$version"

  on_arm do
    sha256 "$arm"

    url "https://github.com/elva-labs/agent-workbench/releases/download/v#{version}/Chord_#{version}_aarch64.dmg"
  end
  on_intel do
    sha256 "$intel"

    url "https://github.com/elva-labs/agent-workbench/releases/download/v#{version}/Chord_#{version}_x64.dmg"
  end

  name "Chord"
  desc "Desktop for terminal coding agents: sessions, live changes, remote projects"
  homepage "https://github.com/elva-labs/agent-workbench"

$livecheck

  conflicts_with cask: ["$other", "agent-workbench", "agent-workbench@beta"]
  depends_on macos: :ventura

  app "Chord.app"
  binary "#{appdir}/Chord.app/Contents/Resources/bin/awb"

  zap trash: [
    "~/Library/Application Support/com.elva-labs.agent-workbench",
    "~/Library/Caches/com.elva-labs.agent-workbench",
    "~/Library/Preferences/com.elva-labs.agent-workbench.plist",
    "~/Library/WebKit/com.elva-labs.agent-workbench",
  ]
end
CASK
