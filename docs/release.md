# CI and releases

## What CI runs

Every push and pull request runs on Linux: the frontend checks with the unit
and browser tiers, the core's format, lint and tests, and the real app
through the driver tier, with a screenshot of the window kept as an
artifact. The core's tests on Windows and macOS and the driver tier on
Windows run before every release, where a failure on any of them stops the
build, or on request from the Actions tab; those runners cost two and ten
Linux minutes a minute, so a push does not run them.
[Testing](testing.md) says what each tier covers.

## Cutting a release

Releases are GitHub Releases with the bundles attached: `.dmg` for both Mac
architectures, `.AppImage`, `.deb` and `.rpm` for Linux, `.msi` and an NSIS
installer for Windows. Every bundle carries the remote daemon for each
machine kind it can put one on.

1. Set the version in `tauri.conf.json` and `package.json`, commit.
2. Tag it: `git tag v0.2.0 && git push origin v0.2.0`.
3. The release workflow builds the daemons, then the bundles on all four
   targets, and opens a draft release for the tag with everything attached.
   It refuses a tag that does not match the version in the configuration.
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

## Signing

The bundles are unsigned until the repository has the secrets for it.
Unsigned still works: macOS asks the user to clear the quarantine flag or
right-click and open the first time, and Windows shows a SmartScreen warning.

- **macOS**: `MACOS_CERTIFICATE` (the Developer ID Application certificate
  as a base64 `.p12`), `MACOS_CERTIFICATE_PASSWORD` and `MACOS_SIGN_IDENTITY`
  sign the app; `NOTARY_KEY` (an App Store Connect API key, base64),
  `NOTARY_KEY_ID` and `NOTARY_ISSUER_ID` notarize it. These are the
  organisation's secrets, shared with its other apps. With the certificate
  alone the app is signed but not notarized.
- **Windows**: a code-signing certificate through the Tauri bundle
  configuration or Azure Trusted Signing. Not wired yet.
