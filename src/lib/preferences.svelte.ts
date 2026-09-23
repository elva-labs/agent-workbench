/**
 * The window's side of the settings the core keeps for the machine.
 *
 * On start the window asks the core for them and takes them. A machine
 * with no settings file yet is one the window's own copy is the only record
 * of, from before the core kept them: the window hands that over once, and
 * from then on the core's file is what every window follows. The core's
 * news of a change, from this window, another one, or an edit to the file,
 * is taken the same way.
 */

import { core, type Settings } from "$lib/core";
import { adoptHooks, hooksSettings } from "$lib/hook.svelte";
import { adoptKeys, keys } from "$lib/keys.svelte";
import { onSettled, sending } from "$lib/persist";
import { adoptTheme, themeSettings } from "$lib/theme.svelte";
import { adoptUserStylesSetting, followStyles, userStyles } from "$lib/userStyles.svelte";
import { workspace } from "$lib/workspace.svelte";

/** The settings as the window has them now. */
export function currentSettings(): Settings {
  return {
    ...themeSettings(),
    keys: { ...keys.bindings },
    hooks: hooksSettings(),
    userStyles: userStyles.on,
  };
}

/** Takes the core's settings into every store that holds a part of them. */
export function adopt(settings: Settings) {
  adoptTheme(settings);
  adoptKeys(settings.keys ?? {});
  adoptUserStylesSetting(settings.userStyles);
  adoptHooks(
    settings.hooks ?? { everywhere: false, overrides: {} },
    workspace.open.map((project) => project.path),
  );
}

/**
 * Follows the core's settings for as long as the window is open. Answers
 * with what stops following. A core that keeps no settings leaves the
 * window on its own copy.
 */
export async function followSettings(): Promise<() => void> {
  onSettled(adopt);
  let stop = () => {};
  const stopStyles = await followStyles();
  try {
    stop = await core().onSettingsChanged((settings) => {
      if (!sending()) adopt(settings);
    });
    const found = await core().settingsGet();
    if (found.stored) adopt(found.settings);
    else adopt(await core().settingsSet(currentSettings()));
  } catch {
    // No core to keep them: the window's copy holds for this run.
  }
  return () => {
    stop();
    stopStyles();
    onSettled(null);
  };
}
