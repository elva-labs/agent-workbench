#!/bin/sh
#
# Prints the Homebrew cask for a published release, checksums included, to
# put in the organisation's tap. The channel is stable, which is
# Casks/agent-workbench.rb, or beta, which is Casks/agent-workbench@beta.rb.
# Both install the same app, so each names the other as a conflict. The
# beta channel takes any version, a stable one too; the stable channel
# refuses a pre-release.
#
#   scripts/cask.sh 0.1.0 > ../homebrew-elva/Casks/agent-workbench.rb
#   scripts/cask.sh 1.0.0-beta.1 beta > ../homebrew-elva/Casks/agent-workbench@beta.rb
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
    token="agent-workbench"
    other="agent-workbench@beta"
    livecheck=$(cat <<'RUBY'
  livecheck do
    url :url
    strategy :github_latest
  end
RUBY
)
    ;;
  beta)
    token="agent-workbench@beta"
    other="agent-workbench"
    # Pre-releases count here, which the latest release never is.
    livecheck=$(cat <<'RUBY'
  livecheck do
    url :url
    regex(/^v?(\d+(?:\.\d+)+(?:-beta\.\d+)?)$/i)
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

arm=$(sum "Agent.Workbench_${version}_aarch64.dmg")
intel=$(sum "Agent.Workbench_${version}_x64.dmg")

cat <<CASK
cask "$token" do
  version "$version"

  on_arm do
    sha256 "$arm"

    url "https://github.com/elva-labs/agent-workbench/releases/download/v#{version}/Agent.Workbench_#{version}_aarch64.dmg"
  end
  on_intel do
    sha256 "$intel"

    url "https://github.com/elva-labs/agent-workbench/releases/download/v#{version}/Agent.Workbench_#{version}_x64.dmg"
  end

  name "Agent Workbench"
  desc "Desktop for terminal coding agents: sessions, live changes, remote projects"
  homepage "https://github.com/elva-labs/agent-workbench"

$livecheck

  conflicts_with cask: "$other"
  depends_on macos: :ventura

  app "Agent Workbench.app"
  binary "#{appdir}/Agent Workbench.app/Contents/Resources/bin/awb"

  zap trash: [
    "~/Library/Application Support/com.elva-labs.agent-workbench",
    "~/Library/Caches/com.elva-labs.agent-workbench",
    "~/Library/Preferences/com.elva-labs.agent-workbench.plist",
    "~/Library/WebKit/com.elva-labs.agent-workbench",
  ]
end
CASK
