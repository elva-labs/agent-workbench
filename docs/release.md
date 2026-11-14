# CI and releases

## What CI runs

Every push and pull request runs on Linux: the frontend checks with the unit
and browser tiers, the core's format, lint and tests, and the real app
through the driver tier, with a screenshot of the window kept as an
artifact. The core's tests on Windows and macOS and the driver tier on
Windows run before every release, where a failure on any of them stops the
build, or on request from the Actions tab; those runners cost two and ten
Linux minutes a minute, so a push does not run them. Every push to main
also checks that the organisation's signing secrets reach this repository,
so a grant lost on the organisation side fails the next push and not the
next release; pull requests skip that check, since a fork never sees
secrets.
[Testing](testing.md) says what each tier covers.

## Cutting a release

Releases are GitHub Releases with the bundles attached: `.dmg` for both Mac
architectures, `.AppImage`, `.deb` and `.rpm` for Linux, `.msi` and an NSIS
installer for Windows. Every bundle carries the remote daemon for each
machine kind it can put one on.

1. Set the version in `package.json`, `tauri.conf.json` and the Cargo
   manifests of the app and the core, let the lock files follow, commit.
2. Tag it: `git tag v0.2.0 && git push origin v0.2.0`.
3. The release workflow builds the daemons, then the bundles on all four
   targets, and opens a draft release for the tag with everything attached.
   It refuses a tag that does not match the version in each of those
   places.
   Attaching is a step of its own that retries and replaces what is already
   there, so a run that fell over while uploading can be run again from the
   Actions tab; the jobs that succeeded keep what they attached.
4. Read the draft, then publish it.
5. Put the release in the organisation's Homebrew tap. `scripts/cask.sh`
   with the version prints the cask for the app, and `scripts/formula.sh`
   the formula for the daemon, checksums included; they go in the tap as
   `Casks/agent-workbench.rb` and `Formula/agent-workbench-remote.rb`. Users
   then get the app with `brew tap elva-labs/elva` and
   `brew install --cask agent-workbench`, a remote machine gets the daemon
   with `brew install elva-labs/elva/agent-workbench-remote`, and both
   update with `brew upgrade`.

Running the workflow by hand from the Actions tab builds the same bundles
without touching releases; they are kept as workflow artifacts for a
fortnight.

## Pre-releases

A pre-release is a version with a suffix, `1.0.0-beta.1`, tagged
`v1.0.0-beta.1`. It is cut from main by the steps above, checked, built and
signed as any release is, and differs in three ways:

- Its draft is a GitHub pre-release. The latest release stays the last
  stable one, which is what the daemon's install script and the stable
  cask and formula serve.
- Two formats are left out, since neither can carry the suffix as the
  bundler writes it: the `.msi`, which takes numeric versions only, and the
  `.rpm`, whose version may hold no hyphen. Windows gets the NSIS installer
  and Linux the `.AppImage` and the `.deb`.
- The `.deb` carries the suffix, and dpkg orders it after the release with
  the same number. Going from `1.0.0-beta.1` to `1.0.0` with the package
  is a downgrade to it and has to be asked for as one.

The tap has a beta channel beside the stable one: the cask
`agent-workbench@beta` and the formula `agent-workbench-remote-beta`, a
formula's name having no room for `@beta`. The scripts print them when
given the channel, `scripts/cask.sh 1.0.0-beta.1 beta` for
`Casks/agent-workbench@beta.rb` and `scripts/formula.sh 1.0.0-beta.1 beta`
for `Formula/agent-workbench-remote-beta.rb`. A pre-release goes on the
beta channel only, and the scripts refuse to print it for the stable one.
A stable release goes on both, so nobody on the beta channel is left on a
pre-release of a version that has since been released.

`brew install --cask agent-workbench@beta` installs the pre-release and
`brew upgrade` follows the channel from there. It is the same app as the
stable one, with the same name, settings and stored state, so the two
casks cannot be installed together and each names the other as a conflict.
Moving between them is `brew uninstall --cask` of one and
`brew install --cask` of the other, which leaves settings and state where
they are. The same holds for the two daemon formulas.

The suffix is part of the version wherever versions are compared: the
desktop refuses a daemon at `1.0.0` when it is at `1.0.0-beta.1`. The app
carries its own daemons, so this only matters on a machine where the
daemon was installed by hand, which follows the beta through the beta
formula or through the install script with
`AGENT_WORKBENCH_VERSION=v1.0.0-beta.1`.

A pre-release runs on the settings and state of the stable version and
hands them back to it, so a change to either follows three rules. Settings
and stored state only grow. A version ignores what it does not know in a
file it reads and does not reject the file. A change to the shape of
something stored says how the version before it reads the result.

Pre-releases are cut from main. A fix that stable needs while main holds
work that is not ready for everyone goes on a branch from the last stable
tag and is tagged there.

A manual run of the workflow from a branch whose version carries a suffix
builds the pre-release bundles as artifacts, which is how a change to this
is tried out without a tag.

## Signing

A release is signed or it is not made: a tag whose build finds no
certificate stops before any bundle is attached, since an unsigned build
costs every user. macOS asks them to right-click and open the app the
first time, and asks again for the daemon the app puts in the home
directory, every time a new version puts a new one there, since the copy
keeps the quarantine flag the app came with; Windows shows a SmartScreen
warning. A manual run of the workflow builds unsigned when the secrets are
missing, as workflow artifacts, for trying the workflow out.

- **macOS**: `MACOS_CERTIFICATE` (the Developer ID Application certificate
  as a base64 `.p12`) and `MACOS_CERTIFICATE_PASSWORD` sign the app and
  the daemons it carries, with `MACOS_SIGN_IDENTITY` naming the identity or,
  left empty, the one Developer ID Application identity in the certificate;
  `NOTARY_KEY` (an App Store Connect API key, as the PEM or base64 of it),
  `NOTARY_KEY_ID` and `NOTARY_ISSUER_ID` notarize it. These are the
  organisation's secrets, shared with its other apps: an organisation owner
  grants them to this repository under the organisation's Actions secrets;
  CI fails on the next push when they stop reaching it, and a tag build
  fails before building if they are missing on the day. With the
  certificate alone the app is signed but not notarized. A manual run of
  the release workflow from the Actions tab builds signed bundles as
  workflow artifacts without touching releases, which is how a change to
  the secrets is tried out.
- **Windows**: a code-signing certificate through the Tauri bundle
  configuration or Azure Trusted Signing. Not wired yet.
