/** Which desktop this is, from what the browser reports. Decides the app
    modifier, how paths look, and how a shell quotes them. */

/** macOS, where Cmd rather than Ctrl is the app key. */
export function isMac(nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator): boolean {
  if (nav === undefined) return false;
  return /Mac|iPhone|iPad/.test(nav.platform ?? nav.userAgent ?? "");
}

/** Windows, where paths have backslashes and a drive, and a shell quotes
    rather than escapes. */
export function isWindows(nav: { platform?: string } | undefined = globalThis.navigator): boolean {
  return /Win/.test(nav?.platform ?? "");
}
