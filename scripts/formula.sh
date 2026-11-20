#!/bin/sh
#
# Prints the Homebrew formula for the daemon of a published release,
# checksums included, to put in the organisation's tap. The channel is
# stable, which is Formula/chord-remote.rb, or beta, which is
# Formula/chord-remote-beta.rb: a formula's name cannot carry
# the @beta a cask's can. Both install the same binary, so each names the
# other as a conflict. The beta channel takes any version, a stable one
# too; the stable channel refuses a pre-release. A machine gets the daemon
# with `brew install elva-labs/elva/chord-remote`.
#
#   scripts/formula.sh 0.1.1 > ../homebrew-elva/Formula/chord-remote.rb
#   scripts/formula.sh 1.0.0-beta.1 beta > ../homebrew-elva/Formula/chord-remote-beta.rb
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
    class="ChordRemote"
    other="chord-remote-beta"
    ;;
  beta)
    class="ChordRemoteBeta"
    other="chord-remote"
    ;;
  *)
    echo "a channel is stable or beta, not $channel" >&2
    exit 1
    ;;
esac

base="https://github.com/elva-labs/chord/releases/download/v$version"

sum() {
  curl -fsSL "$base/chord-remote-$1" | shasum -a 256 | cut -d' ' -f1
}

darwin_arm=$(sum darwin-aarch64)
darwin_intel=$(sum darwin-x86_64)
linux_arm=$(sum linux-aarch64)
linux_intel=$(sum linux-x86_64)

cat <<FORMULA
# typed: false
# frozen_string_literal: true

class $class < Formula
  desc "Chord on another machine: the daemon a desktop reaches over ssh"
  homepage "https://github.com/elva-labs/chord"
  version "$version"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/elva-labs/chord/releases/download/v#{version}/chord-remote-darwin-aarch64"
      sha256 "$darwin_arm"
    end
    on_intel do
      url "https://github.com/elva-labs/chord/releases/download/v#{version}/chord-remote-darwin-x86_64"
      sha256 "$darwin_intel"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/elva-labs/chord/releases/download/v#{version}/chord-remote-linux-aarch64"
      sha256 "$linux_arm"
    end
    on_intel do
      url "https://github.com/elva-labs/chord/releases/download/v#{version}/chord-remote-linux-x86_64"
      sha256 "$linux_intel"
    end
  end

  conflicts_with "elva-labs/elva/$other", because: "both install chord-remote"

  def install
    binary = Dir["chord-remote-*"].first
    bin.install binary => "chord-remote"
    chmod 0755, bin/"chord-remote"
  end

  def caveats
    <<~EOS
      A machine paired with Chord before the daemon took this name runs
      the daemon under its earlier name. Run this once to move it over:
        chord-remote migrate
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/chord-remote version").strip
  end
end
FORMULA
