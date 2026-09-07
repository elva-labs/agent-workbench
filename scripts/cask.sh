#!/bin/sh
#
# Prints the Homebrew cask for a published release, checksums included, to
# put in the organisation's tap as Casks/agent-workbench.rb.
#
#   scripts/cask.sh 0.1.0 > ../homebrew-elva/Casks/agent-workbench.rb
set -eu

version="${1:?a version, as 0.1.0}"
base="https://github.com/elva-labs/agent-workbench/releases/download/v$version"

sum() {
  curl -fsSL "$base/$1" | shasum -a 256 | cut -d' ' -f1
}

arm=$(sum "Agent.Workbench_${version}_aarch64.dmg")
intel=$(sum "Agent.Workbench_${version}_x64.dmg")

cat <<CASK
cask "agent-workbench" do
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

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :catalina

  app "Agent Workbench.app"

  zap trash: [
    "~/Library/Application Support/com.elva-labs.agent-workbench",
    "~/Library/Caches/com.elva-labs.agent-workbench",
    "~/Library/Preferences/com.elva-labs.agent-workbench.plist",
    "~/Library/WebKit/com.elva-labs.agent-workbench",
  ]
end
CASK
