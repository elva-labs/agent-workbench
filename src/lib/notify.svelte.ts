/**
 * What reaches the user from a session that starts waiting for them while
 * the window is in the background: a notification from the system, and a
 * chime when they have asked for one.
 *
 * Both follow the moment a session's row goes unread, and only while the
 * window does not have focus: in a focused window the row, the status bar
 * and the agent pane already say it. A session an orchestrator started
 * answers to the orchestrator, so only its asking for a permission reaches
 * the user this way. Whether either is on is the user's to say, in the
 * settings, and not an agent's.
 */

import { attention } from "$lib/attention.svelte";
import { startedFor } from "$lib/conductor.svelte";
import { core, type Settings } from "$lib/core";
import { isConductor, LABEL } from "$lib/orchestrator.svelte";
import { persist } from "$lib/persist";
import { label, type Session } from "$lib/sessions.svelte";
import { projectLabel } from "$lib/workspace.svelte";

export const notify = $state({
  notifications: true,
  chime: false,
});

type NotifyFields = "notifications" | "chime";

/** The notifications' part of the settings. */
export function notifySettings(): Pick<Settings, NotifyFields> {
  return { notifications: notify.notifications, chime: notify.chime };
}

/** Takes the core's word for the machine. Nothing is sent back. */
export function adoptNotify(settings: Partial<Pick<Settings, NotifyFields>>) {
  if (typeof settings.notifications === "boolean") notify.notifications = settings.notifications;
  if (typeof settings.chime === "boolean") notify.chime = settings.chime;
}

export function setNotifications(on: boolean) {
  notify.notifications = on;
  persist({ notifications: on });
}

/** Turning the chime on plays it, so the user hears what they chose. */
export function setChime(on: boolean) {
  notify.chime = on;
  persist({ chime: on });
  if (on) ring();
}

/** The notification's title: the project, then the session's name. */
export function titleFor(session: Session): string {
  const project = isConductor(session) ? LABEL : projectLabel(session.project);
  return `${project} · ${label(session)}`;
}

/** The notification's body: what the session is waiting on. */
export function bodyFor(session: Session): string {
  if (session.needs === "permission") return "Needs permission";
  if (session.status === "exited") return "Ended";
  if (session.status === "crashed") return "Stopped";
  return session.note ?? "Waiting for you";
}

/** A session has just started waiting for the user. */
export function announce(session: Session) {
  if (attention.focused) return;
  if (startedFor(session.key) !== null && session.needs !== "permission") return;
  if (notify.notifications) {
    const title = titleFor(session);
    const body = bodyFor(session);
    attempt(() => core().notify(title, body));
  }
  if (notify.chime) ring();
}

function ring() {
  attempt(() => core().chime());
}

/** A core that cannot notify or chime is one where neither happens. */
function attempt(call: () => Promise<void>) {
  try {
    void call().catch(() => {});
  } catch {
    // The core has no such call.
  }
}

/** Test seam. */
export function resetNotify() {
  notify.notifications = true;
  notify.chime = false;
}
