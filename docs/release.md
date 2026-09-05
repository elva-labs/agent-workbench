# CI and releases

## What runs on every push and pull request

`.github/workflows/ci.yml`, in parallel:

- **Frontend** on Linux: `svelte-check`, the Vitest suite, and the Playwright
  suite in Chromium against a fake core. The frontend is the same on every
  platform, so one runner covers it.
- **Core** on Linux, Windows and macOS: `cargo fmt --check`, `cargo clippy`
  with warnings as errors, and `cargo test`. This is where a platform-specific
  path in the core breaks first.
- **Real app** on Linux: the driver tier, `tests/driver`, against the actual
  binary through `tauri-driver`. See [testing.md](testing.md). The job also
  photographs the window and keeps the picture as an artifact. The same job on
  Windows runs but does not block yet; testing.md says where it stands.

There is no driver for macOS, so the macOS window is the one thing checked by
hand.

## Cutting a release

Releases are GitHub Releases with the bundles attached: `.dmg` for both Mac
architectures, `.AppImage` and `.deb` for Linux, `.msi` and an NSIS installer
for Windows. GitHub Packages is for registries, not for app binaries.

1. Set the version in `src-tauri/tauri.conf.json` and `package.json`, commit.
2. Tag it: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` builds on all four targets and opens a
   **draft** release for the tag with everything attached. It refuses a tag
   that does not match the version in `tauri.conf.json`.
4. Read the draft, then publish it.

Running the workflow by hand from the Actions tab builds the same bundles
without touching releases; they are kept as workflow artifacts for a fortnight.

## Signing

The bundles are unsigned until the repository has the secrets for it. Unsigned
still works: macOS asks the user to right-click and open the first time, and
Windows shows a SmartScreen warning. To sign:

- **macOS**: `APPLE_CERTIFICATE` (the Developer ID Application certificate,
  base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for
  notarization `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and
  `APPLE_TEAM_ID`. The workflow already passes them through.
- **Windows**: a code-signing certificate, wired through
  `bundle.windows.certificateThumbprint` in `tauri.conf.json` or Azure
  Trusted Signing. Not wired yet.
