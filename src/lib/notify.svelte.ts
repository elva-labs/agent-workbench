/**
 * What reaches the user from a session that starts waiting for them while
 * the window is in the background: a notification from the system, and a
 * chime when they have asked for one.
 *
 * Both follow the moment a session's row goes unread, and only while the
 * window does not have focus: in a focused window the row, the status bar
 * and the agent pane already say it. A session another session started
 * goes unread only for a permission, so only that reaches the user this
 * way. A question an integrated session or the workbench puts to the user
 * is told of by itself, one notification each, through the same two. Whether
 * either is on is the user's to say, in the settings, and not an agent's.
 *
 * Each notification is named, and remembers the row it is about: a click
 * on it goes there, where the system tells of clicks, and it is taken away
 * once it is over: a session's once the session is looked at, a question's
 * once it is answered or gone.
 */

import { attention } from "$lib/attention.svelte";
import { core, type Settings } from "$lib/core";
import { focusPane } from "$lib/layout.svelte";
import { persist } from "$lib/persist";
import { label, type Session } from "$lib/sessions.svelte";
import { goTo, projectLabel } from "$lib/workspace.svelte";

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
  if (typeof settings.notifications === "boolean")
    notify.notifications = settings.notifications;
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
  const project = projectLabel(session.project);
  return `${project} · ${label(session)}`;
}

/** The notification's body: what the session is waiting on. */
export function bodyFor(session: Session): string {
  if (session.needs === "permission") return "Needs permission";
  if (session.status === "exited") return "Ended";
  if (session.status === "crashed") return "Stopped";
  return session.note ?? "Waiting for you";
}

/** A session has just started waiting for the user. An integrated
    session asking is told of by its questions, each by itself. */
export function announce(session: Session) {
  if (attention.focused) return;
  if (session.kind === "integrated" && session.needs === "permission") return;
  tell(waitingName(session.key), titleFor(session), bodyFor(session), session.key);
}

/** The name of the notification that a session waits. One sent again for
    the same session takes the place of the last, where the system allows. */
function waitingName(key: string): string {
  return JSON.stringify(["waiting", key]);
}

/** The notifications sent and not yet over, by name, with the row a click
    on each goes to, or null for a question put over the whole window. */
const sent = new Map<string, string | null>();

/** Says something through the system, as the settings allow: the
    notification under its name, and the chime. */
export function tell(name: string, title: string, body: string, at: string | null) {
  if (notify.notifications) {
    sent.set(name, at);
    attempt(() => core().notify(title, body, name));
  }
  if (notify.chime) ring();
}

/** What a notification said is over: it is taken away, where it was sent. */
export function untell(name: string) {
  if (!sent.delete(name)) return;
  attempt(() => core().unnotify(name));
}

/** The session is on screen in a focused window: that it waits is read. */
export function seen(key: string) {
  untell(waitingName(key));
}

/** A notification was clicked, with the window brought forward: the
    window goes to the row it was about, with the keyboard in its agent
    pane. The system has taken the notification away. */
export function clicked(name: string) {
  const at = sent.get(name) ?? null;
  sent.delete(name);
  if (at !== null && goTo(at)) focusPane("agent");
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
  sent.clear();
}
