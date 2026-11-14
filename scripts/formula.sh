#!/bin/sh
#
# Prints the Homebrew formula for the daemon of a published release,
# checksums included, to put in the organisation's tap. The channel is
# stable, which is Formula/agent-workbench-remote.rb, or beta, which is
# Formula/agent-workbench-remote-beta.rb: a formula's name cannot carry
# the @beta a cask's can. Both install the same binary, so each names the
# other as a conflict. The beta channel takes any version, a stable one
# too; the stable channel refuses a pre-release. A machine gets the daemon
# with `brew install elva-labs/elva/agent-workbench-remote`.
#
#   scripts/formula.sh 0.1.1 > ../homebrew-elva/Formula/agent-workbench-remote.rb
#   scripts/formula.sh 1.0.0-beta.1 beta > ../homebrew-elva/Formula/agent-workbench-remote-beta.rb
set -eu

version="${1:?a version, as 0.1.1}"
channel="${2:-stable}"

case "$channel" in
  stable)
    case "$version" in
      *-*)
        echo "$version is a pre-release, which goes on the beta channel: scripts/formula.sh $version beta" >&2
        exit 1
        ;;
    esac
    class="AgentWorkbenchRemote"
    other="agent-workbench-remote-beta"
    ;;
  beta)
    class="AgentWorkbenchRemoteBeta"
    other="agent-workbench-remote"
    ;;
  *)
    echo "a channel is stable or beta, not $channel" >&2
    exit 1
    ;;
esac

base="https://github.com/elva-labs/agent-workbench/releases/download/v$version"

sum() {
  curl -fsSL "$base/agent-workbench-remote-$1" | shasum -a 256 | cut -d' ' -f1
}

darwin_arm=$(sum darwin-aarch64)
darwin_intel=$(sum darwin-x86_64)
linux_arm=$(sum linux-aarch64)
linux_intel=$(sum linux-x86_64)

cat <<FORMULA
# typed: false
# frozen_string_literal: true

class $class < Formula
  desc "Agent Workbench on another machine: the daemon a desktop reaches over ssh"
  homepage "https://github.com/elva-labs/agent-workbench"
  version "$version"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/elva-labs/agent-workbench/releases/download/v#{version}/agent-workbench-remote-darwin-aarch64"
      sha256 "$darwin_arm"
    end
    on_intel do
      url "https://github.com/elva-labs/agent-workbench/releases/download/v#{version}/agent-workbench-remote-darwin-x86_64"
      sha256 "$darwin_intel"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/elva-labs/agent-workbench/releases/download/v#{version}/agent-workbench-remote-linux-aarch64"
      sha256 "$linux_arm"
    end
    on_intel do
      url "https://github.com/elva-labs/agent-workbench/releases/download/v#{version}/agent-workbench-remote-linux-x86_64"
      sha256 "$linux_intel"
    end
  end

  conflicts_with "elva-labs/elva/$other", because: "both install agent-workbench-remote"

  def install
    binary = Dir["agent-workbench-remote-*"].first
    bin.install binary => "agent-workbench-remote"
    chmod 0755, bin/"agent-workbench-remote"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/agent-workbench-remote version").strip
  end
end
FORMULA
