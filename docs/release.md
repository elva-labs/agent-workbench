# CI and releases

## What CI runs

Every push and pull request runs on Linux: the frontend checks with the unit
and browser tiers, the core's format, lint and tests, and the real app
through the driver tier, with a screenshot of the window kept as an
artifact. The core's tests on Windows and macOS and the driver tier on
Windows run nightly, only on a day main moved, or on request from the
Actions tab, because those runners cost two and ten Linux minutes a minute.
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
