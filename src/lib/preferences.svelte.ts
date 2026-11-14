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

import { adoptAccounts, accountsSettings } from "$lib/accounts.svelte";
import { core, type Settings } from "$lib/core";
import { adoptWorkflows, workflowsSettings } from "$lib/workflows.svelte";
import { adoptHooks, hooksSettings } from "$lib/hook.svelte";
import { adoptPastSessions, pastSessionsSettings } from "$lib/sessions.svelte";
import { adoptKeys, keysSettings } from "$lib/keys.svelte";
import { adoptNotify, notifySettings } from "$lib/notify.svelte";
import { onRefused, onSettled, persist, sending } from "$lib/persist";
import { adoptTheme, themeSettings } from "$lib/theme.svelte";
import { adoptUserStylesSetting, followStyles, userStyles } from "$lib/userStyles.svelte";
import { adoptUnread } from "$lib/unread.svelte";
import { workspace } from "$lib/workspace.svelte";

/** The settings as the window has them now. */
export function currentSettings(): Settings {
  return {
    ...themeSettings(),
    keys: keysSettings(),
    hooks: hooksSettings(),
    accounts: accountsSettings(),
    workflows: workflowsSettings(),
    ...pastSessionsSettings(),
    userStyles: userStyles.on,
    ...notifySettings(),
  };
}

/** The settings last taken from the core, and the news that was let pass
    because a change of the window's own was on its way. */
let known: Settings | null = null;
let passed: Settings | null = null;

/** Takes the core's settings into every store that holds a part of them. */
export function adopt(settings: Settings) {
  known = settings;
  passed = null;
  adoptUnread(settings.unreadEntries);
  adoptTheme(settings);
  adoptKeys(settings.keys ?? {});
  adoptUserStylesSetting(settings.userStyles);
  adoptNotify(settings);
  adoptPastSessions(settings.pastSessions);
  // The accounts before the hooks: bringing a project to the hooks answer
  // writes into every account's agent state.
  adoptAccounts(settings.accounts);
  adoptWorkflows(settings.workflows);
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
  // The core announces every change to the file from the moment the window
  // listens, so settings taken by the time the first read answers are as
  // new as that answer or newer: the file may have changed after it was
  // read, with the news of it arriving first. The read is then passed over.
  // Only settings the window took count: news let pass because a write is
  // in flight is not taken, and the answer to that write is.
  let heard = false;
  known = null;
  passed = null;
  onSettled((settings) => {
    heard = true;
    adopt(settings);
  });
  // A refused change takes the window back to what is stored: the file when
  // it can be read whole, otherwise the news that was let pass, otherwise
  // what the window last took.
  onRefused(async () => {
    heard = true;
    let found: Awaited<ReturnType<ReturnType<typeof core>["settingsGet"]>> | null = null;
    try {
      found = await core().settingsGet();
    } catch {
      found = null;
    }
    if (found !== null && found.stored && !found.unreadable) adopt(found.settings);
    else if (passed !== null) adopt(passed);
    else if (known !== null) adopt(known);
  });
  let stop = () => {};
  let stopMissing = () => {};
  const stopStyles = await followStyles();
  try {
    stop = await core().onSettingsChanged((settings) => {
      if (sending()) {
        passed = settings;
        return;
      }
      heard = true;
      adopt(settings);
    });
    // A file that was there and is gone: what the window holds is handed
    // over, as at the start of a machine with no file, so the next change is
    // laid over it and not over the defaults.
    stopMissing =
      (await core().onSettingsMissing?.(() => {
        void persist(currentSettings());
      })) ?? stopMissing;
    const found = await core().settingsGet();
    // A file that could not be read whole says nothing about the settings:
    // the window keeps what it has, and takes the file when the core
    // announces a whole one.
    if (!heard && !found.unreadable) {
      if (found.stored) adopt(found.settings);
      else adopt(await core().settingsSet(currentSettings()));
    }
  } catch {
    // No core to keep them: the window's copy holds for this run.
  }
  return () => {
    stop();
    stopMissing();
    stopStyles();
    onSettled(null);
    onRefused(null);
  };
}
