#!/bin/sh
#
# Prints the Homebrew formula for the daemon of a published release,
# checksums included, to put in the organisation's tap as
# Formula/agent-workbench-remote.rb. A machine then gets the daemon with
# `brew install elva-labs/elva/agent-workbench-remote`.
#
#   scripts/formula.sh 0.1.1 > ../homebrew-elva/Formula/agent-workbench-remote.rb
set -eu

version="${1:?a version, as 0.1.1}"
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

class AgentWorkbenchRemote < Formula
  desc "Agent Workbench on another machine: the daemon a desktop reaches over ssh"
  homepage "https://github.com/elva-labs/agent-workbench"
  license "MIT"
  version "$version"

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
