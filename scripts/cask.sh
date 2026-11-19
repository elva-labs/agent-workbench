#!/bin/sh
#
# Prints the Homebrew cask for a published release, checksums included, to
# put in the organisation's tap. The channel is stable, which is
# Casks/chord.rb, or beta, which is Casks/chord@beta.rb. Both install the
# same app, so each names the other as a conflict, and the cask the app had
# under its earlier name on the other channel, which installs it under the
# same bundle identifier: chord names agent-workbench@beta and chord@beta
# names agent-workbench. Neither names the old cask the tap renames to it,
# which Homebrew would load as itself and refuse every upgrade over; an
# installed old cask is moved onto the new token before anything is
# checked.
# The beta channel takes any version, a stable one too; the stable channel
# refuses a pre-release.
#
# The channel earlier prints Casks/agent-workbench.rb, the last stable
# release under the app's earlier name, for the tap to keep until Chord has
# a stable release of its own: the same cask as it was published, naming
# the Chord casks as conflicts as well, since Homebrew checks a conflict
# only from the cask being installed. docs/release.md says what else the
# tap holds.
#
#   scripts/cask.sh 1.0.0 > ../homebrew-elva/Casks/chord.rb
#   scripts/cask.sh 1.0.0-beta.5 beta > ../homebrew-elva/Casks/chord@beta.rb
#   scripts/cask.sh 0.9.0 earlier > ../homebrew-elva/Casks/agent-workbench.rb
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
    conflicts='"chord@beta", "agent-workbench@beta"'
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
    conflicts='"chord", "agent-workbench"'
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
  earlier)
    case "$version" in
      *-*)
        echo "$version is a pre-release; the cask under the earlier name holds the last stable release under it" >&2
        exit 1
        ;;
    esac
    token="agent-workbench"
    conflicts='"agent-workbench@beta", "chord", "chord@beta"'
    product="Agent Workbench" # the app's earlier name
    asset="Agent.Workbench" # the app's earlier name, in its release's assets
    # It stays at the version it holds: the latest release is Chord's.
    livecheck=""
    ;;
  *)
    echo "a channel is stable, beta or earlier, not $channel" >&2
    exit 1
    ;;
esac

product="${product:-Chord}"
asset="${asset:-Chord}"
base="https://github.com/elva-labs/chord/releases/download/v$version"

sum() {
  curl -fsSL "$base/$1" | shasum -a 256 | cut -d' ' -f1
}

arm=$(sum "${asset}_${version}_aarch64.dmg")
intel=$(sum "${asset}_${version}_x64.dmg")

cat <<CASK
cask "$token" do
  version "$version"

  on_arm do
    sha256 "$arm"

    url "https://github.com/elva-labs/chord/releases/download/v#{version}/${asset}_#{version}_aarch64.dmg"
  end
  on_intel do
    sha256 "$intel"

    url "https://github.com/elva-labs/chord/releases/download/v#{version}/${asset}_#{version}_x64.dmg"
  end

  name "$product"
  desc "Desktop for terminal coding agents: sessions, live changes, remote projects"
  homepage "https://github.com/elva-labs/chord"
${livecheck:+
$livecheck
}
  conflicts_with cask: [$conflicts]
  depends_on macos: :ventura

  app "$product.app"
  binary "#{appdir}/$product.app/Contents/Resources/bin/awb"

  zap trash: [
    "~/Library/Application Support/com.elva-labs.agent-workbench",
    "~/Library/Caches/com.elva-labs.agent-workbench",
    "~/Library/Preferences/com.elva-labs.agent-workbench.plist",
    "~/Library/WebKit/com.elva-labs.agent-workbench",
  ]
end
CASK
