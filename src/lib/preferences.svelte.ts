/**
 * The window's side of the settings the core keeps for the machine.
 *
 * On start the window asks the core for them and takes them. A machine
 * with no settings file yet is one the window's own copy is the only record
 * of, from before the core kept them: the window hands that over, and from
 * then on the core's file is what every window follows. A file that goes
 * missing while the window is open is handed the window's copy the same way. The core's
 * news of a change, from this window, another one, or an edit to the file,
 * is taken the same way.
 */

import { adoptAccounts, accountsSettings } from "$lib/accounts.svelte";
import { core, type Settings, type StoredSettings } from "$lib/core";
import { adoptWorkflows, knowWorkflows, workflowsSettings } from "$lib/workflows.svelte";
import { adoptHooks, hooksSettings } from "$lib/hook.svelte";
import { adoptPastSessions, pastSessionsSettings } from "$lib/sessions.svelte";
import { adoptInactiveAfter, inactiveAfterSettings } from "$lib/projects.svelte";
import { adoptKeys, keysSettings } from "$lib/keys.svelte";
import { adoptNotify, notifySettings } from "$lib/notify.svelte";
import { flush, holdUntil, onRefused, onSettled, sending } from "$lib/persist";
import { showRefusal } from "$lib/refusal.svelte";
import { adoptTheme, themeSettings } from "$lib/theme.svelte";
import { adoptUserStylesSetting, followStyles, userStyles } from "$lib/userStyles.svelte";
import { adoptUnread, unread } from "$lib/unread.svelte";
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
    ...inactiveAfterSettings(),
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
  adoptInactiveAfter(settings.inactiveAfter);
  // The accounts before the hooks: bringing a project to the hooks answer
  // writes into every account's agent state.
  adoptAccounts(settings.accounts);
  adoptWorkflows(settings.workflows);
  adoptHooks(
    settings.hooks ?? { everywhere: false, overrides: {} },
    workspace.open.map((project) => project.path),
  );
}

/** The settings the window holds, as it hands them over to a file that is
    not there: with the entries it knows the file held and did not use. */
function held(): Settings {
  return { ...currentSettings(), unreadEntries: unread.entries };
}

/**
 * Follows the core's settings for as long as the window is open. Answers
 * with what stops following. A core that keeps no settings leaves the
 * window on its own copy.
 */
export async function followSettings(): Promise<() => void> {
  try {
    return await follow();
  } finally {
    // Whatever the core said, a file it could not read included, the window
    // goes on with the workflows it has.
    knowWorkflows();
  }
}

async function follow(): Promise<() => void> {
  // The core announces every change to the file from the moment the window
  // listens, so settings taken by the time the first read answers are as
  // new as that answer or newer: the file may have changed after it was
  // read, with the news of it arriving first. The read is then passed over.
  // Only settings the window took count: news let pass because a write is
  // in flight is not taken, and the answer to that write is.
  let heard = false;
  known = null;
  passed = null;
  const hear = (settings: Settings) => {
    if (sending()) {
      passed = settings;
      return;
    }
    heard = true;
    adopt(settings);
  };
  // Hands what the window holds over to a file that is not there. The core
  // writes it only if the file is still not there; a file that is there by
  // then, such as one an editor saved by moving the old file aside, is what
  // the window takes. Changes made meanwhile wait, and are laid over what
  // the hand-over left.
  const handOver = async () => {
    let found: StoredSettings;
    try {
      found = await core().settingsHandOver(held());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      showRefusal(reason, null, "The settings file is gone, and the window could not write its settings back");
      return;
    }
    if (!found.unreadable) hear(found.settings);
  };
  onSettled((settings) => {
    heard = true;
    adopt(settings);
  });
  // A refused change takes the window back to what is stored: the file when
  // it can be read whole, otherwise the news that was let pass, otherwise
  // what the window last took. A file that is gone is handed what the
  // window then holds.
  onRefused(async () => {
    heard = true;
    let found: StoredSettings | null = null;
    try {
      found = await core().settingsGet();
    } catch {
      found = null;
    }
    if (found !== null && found.stored && !found.unreadable) {
      adopt(found.settings);
      return "stored";
    }
    const last = passed ?? known;
    if (last !== null) adopt(last);
    if (found !== null && !found.stored) await handOver();
    return last !== null ? "last" : null;
  });
  let stop = () => {};
  let stopMissing = () => {};
  const stopStyles = await followStyles();
  try {
    stop = await core().onSettingsChanged(hear);
    // A file that was there and is gone, and stayed gone a moment: once the
    // changes on their way are answered, what the window holds is handed
    // over, so the next change is laid over it and not over the defaults.
    stopMissing =
      (await core().onSettingsMissing?.(() => {
        void holdUntil(flush().then(handOver));
      })) ?? stopMissing;
    // Changes wait for the first read, and for a hand-over when there is
    // no file, so none is laid over the defaults before the window's copy
    // is handed over.
    await holdUntil(
      (async () => {
        const found = await core().settingsGet();
        // A file that could not be read whole says nothing about the
        // settings: the window keeps what it has, and takes the file when
        // the core announces a whole one.
        // A change made before it answered is waiting to be sent, so the
        // read is news to it, as news while a change is on its way is.
        if (heard || found.unreadable) return;
        if (!found.stored) await handOver();
        else if (sending()) passed = found.settings;
        else adopt(found.settings);
      })(),
    );
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
