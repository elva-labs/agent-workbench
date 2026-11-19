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
   `Casks/chord.rb` and `Formula/chord-remote.rb`. Users
   then get the app with `brew tap elva-labs/elva` and
   `brew install --cask chord`, a remote machine gets the daemon
   with `brew install elva-labs/elva/chord-remote`, and both
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
`chord@beta` and the formula `chord-remote-beta`, a
formula's name having no room for `@beta`. The scripts print them when
given the channel, `scripts/cask.sh 1.0.0-beta.1 beta` for
`Casks/chord@beta.rb` and `scripts/formula.sh 1.0.0-beta.1 beta`
for `Formula/chord-remote-beta.rb`. A pre-release goes on the
beta channel only, and the scripts refuse to print it for the stable one.
A stable release goes on both, so nobody on the beta channel is left on a
pre-release of a version that has since been released.

`brew install --cask chord@beta` installs the pre-release and
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
`CHORD_VERSION=v1.0.0-beta.1`.

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

## The casks and formulas under the app's earlier name

The app was called Agent Workbench, and its casks were `agent-workbench`
and `agent-workbench@beta`. Chord keeps the bundle identifier, so either of
those installs the same app under its old name, sharing Chord's settings
and stored state. Each Chord cask names the other Chord cask as a conflict,
and the old cask that the tap does not rename to it: `chord@beta` names
`chord` and `agent-workbench`, and `chord` names `chord@beta` and
`agent-workbench@beta`. Neither names the old cask renamed to it, since
Homebrew follows the rename and would load that cask as the Chord cask
itself, refusing every upgrade of it as a conflict with itself. Nothing is
lost by it: installing over the old cask moves it onto the new token
first. The tap moves
a user from an old cask to the new one with a rename, which Homebrew
follows by itself: `cask_renames.json` at the top of the tap maps the old
token to the new, and the old cask's file is gone. `brew update` then moves
the installed cask to the new token, and `brew upgrade` takes `Agent
Workbench.app` out and puts `Chord.app` in, leaving settings and state
where they are.

The first Chord pre-release does this for the beta channel. Its version
is newer than the last pre-release under the earlier name, 1.0.0-beta.4,
so that `brew upgrade` takes the renamed cask forward. After it the tap
holds:

- `Casks/chord@beta.rb`, printed by `scripts/cask.sh <version> beta`;
- `Casks/agent-workbench.rb`, the last stable release under the old name,
  printed again by `scripts/cask.sh <its version> earlier`: the same cask,
  naming `chord` and `chord@beta` as conflicts as well, since Homebrew
  checks a conflict only from the cask being installed, and without it
  the old app would install beside Chord;
- no `Casks/agent-workbench@beta.rb`;
- `cask_renames.json` with `{ "agent-workbench@beta": "chord@beta" }`;
- `Formula/agent-workbench-remote.rb` under its name, the daemon of that
  last stable release.

The daemon was called `agent-workbench-remote`, and its formulas were
`agent-workbench-remote` and `agent-workbench-remote-beta`. They move the
same way, through `formula_renames.json` at the top of the tap, which
Homebrew reads as it reads the casks' map: `brew update` sees the old
formula's file gone, the new one added and the map naming one for the
other, and moves the installed formula onto the new name, Cellar, links
and all. The daemon's binary is then `chord-remote`. A machine that was
paired runs the old binary through its line in `authorized_keys`, so
`chord-remote migrate` is run there once, which the formula's caveats
say. The release assets are named `chord-remote-<os>-<arch>`, and an
install script or formula from before fetches the old name, which only
releases from before carry.

The beta channel's move is one commit and one push, so that `brew update`
sees the rename and the removal together:

- add `Casks/chord@beta.rb`, printed by `scripts/cask.sh <version> beta`,
  when it is not there yet;
- add `Formula/chord-remote-beta.rb`, printed by
  `scripts/formula.sh <version> beta`;
- delete `Formula/agent-workbench-remote-beta.rb`;
- add `formula_renames.json` at the top of the tap:
  `{ "agent-workbench-remote-beta": "chord-remote-beta" }`;
- leave `Formula/agent-workbench-remote.rb` and the casks' map as they are.

The first stable Chord release does the same for the stable channel, in
one commit: it adds `Casks/chord.rb` and `Formula/chord-remote.rb`,
removes `Casks/agent-workbench.rb` and `Formula/agent-workbench-remote.rb`,
and adds `"agent-workbench": "chord"` to `cask_renames.json` and
`"agent-workbench-remote": "chord-remote"` to `formula_renames.json`. It
prints `chord@beta` and `chord-remote-beta` at the stable version too. A Homebrew older than
4.1 does not read the renames, and its `brew upgrade` says the old cask is
no longer available; `brew install --cask chord@beta`, or `chord`, after
`brew uninstall --cask` of the old one, does it by hand.

Each platform loses what pointed at the app by its earlier name, which the
release notes of the first Chord release say:

- On macOS the app's tile in the Dock points at the app it was pinned
  from, so after the move it is pinned again. A Mac that has the app from
  a disk image keeps the copy under the earlier name beside the new one;
  quit it and delete it before opening Chord, since the two are the same
  app to macOS and the first one open is the one both open into.
- On Windows the setup installer runs the old install's uninstaller, which
  takes its shortcuts away and unpins them from the taskbar and Start, so
  Chord's shortcut is pinned again.
- On Linux the package is `chord` where it was `agent-workbench`: the
  bundler names it after the product. Chord's package conflicts with,
  replaces and provides `agent-workbench`, and its rpm obsoletes it, so
  installing it takes the old package out. The desktop entry takes the
  new name too, and GNOME's and KDE's favourites name the entry, so a
  favourite of the app is added again.

## The repository's earlier address

The repository is `elva-labs/chord`, which it moved to with the app's name.
The earlier address, `elva-labs/agent-workbench`, still works: GitHub sends
every request for it to the new one, the pages, `git` over either
transport, the API, release downloads and raw files. Copies already
installed rely on that. The casks and formulas published before the move
download their bundles and daemons from it, an install script of
1.0.0-beta.4 or older fetches the daemon from it, and the line in the docs
of those versions that pipes the install script into a shell names it too.

The redirect lasts only while no repository takes that name. Never give
the earlier address, `agent-workbench`, to a new repository in the
organisation, nor rename another repository to it, not even for a moment:
GitHub then serves that repository there, and every copy above breaks, or
fetches from whatever the new repository holds. The plugins repository,
`elva-labs/agent-workbench-plugins`, is a repository of its own and keeps
its name.
