/**
 * Whether the settings are open. Reached from the native menu, from its
 * accelerator, or from the app's own chord; all three land here, and opening
 * what is open is nothing, so a menu accelerator the webview also saw does
 * not open it twice.
 */
export const settings = $state({
  open: false,
  /** A section to bring into view and light when the dialog opens. */
  highlight: null as "hooks" | null,
});

export function openSettings(highlight: "hooks" | null = null) {
  settings.open = true;
  settings.highlight = highlight;
}

export function closeSettings() {
  settings.open = false;
  settings.highlight = null;
}
