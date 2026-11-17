import { attention } from "$lib/attention.svelte";
import { conductor, startedFor, type Ask as ConductAsk } from "$lib/conductor.svelte";
import type { Conversation, Request } from "$lib/conversation.svelte";
import { linkOf } from "$lib/integrated.svelte";
import { tell, titleFor, untell } from "$lib/notify.svelte";
import { byToken, runningByToken, sessions, type Session } from "$lib/sessions.svelte";
import { settingsAsk, type Ask as SettingsAsk } from "$lib/settingsTools.svelte";
import { asks, phraseText } from "$lib/thread";
import { shown } from "$lib/unseen";
import { projectLabel } from "$lib/workspace.svelte";

/**
 * The questions that wait on the user, as the system's notifications say
 * them.
 *
 * Every question an integrated session's agent puts, a permission or a
 * question of its own, those of the sessions another started included; the
 * workbench's question when a session wants to start another, or another
 * round of a review; and an agent's change to the settings. A question
 * answered without the user, by a standing answer or the agent's own
 * rules, never waits here, so it is never told of.
 *
 * Each is told of once, when it comes while the window is in the
 * background, by which session asks and what for, and a click on it goes
 * to where it is answered. One that came while the window had focus is not
 * told of later. Once a question is answered, or goes, its notification is
 * taken away.
 */

/** A question waiting on the user, as a notification says it. */
export interface Waiting {
  /** Its name, unique to the question. */
  name: string;
  title: string;
  body: string;
  /** The row a click goes to, where it is answered; null for one put over
      the whole window. */
  at: string | null;
}

/** How long a notification's line may run before it is cut. */
const LINE = 100;

/** Every question waiting on the user now. */
export function openAsks(): Waiting[] {
  const out: Waiting[] = [];
  for (const row of sessions.all) {
    if (row.kind !== "integrated") continue;
    // Read so a row whose link is made after it was last looked at is
    // looked at again: a link is made as its run starts.
    void row.status;
    const conversation = linkOf(row.key)?.conversation ?? null;
    if (conversation === null) continue;
    for (const request of conversation.open) out.push(fromRequest(row, request, conversation));
  }
  if (conductor.asking !== null) out.push(fromConduct(conductor.asking));
  if (settingsAsk.asking !== null) out.push(fromSettings(settingsAsk.asking));
  return out;
}

/** The questions open as last looked at, by name. */
let open = new Set<string>();

/** Looks at the questions again: each new one is told of while the window
    is in the background, and each one gone is taken away. */
export function heedAsks(now: Waiting[]) {
  const names = new Set(now.map((waiting) => waiting.name));
  for (const waiting of now) {
    if (open.has(waiting.name) || attention.focused) continue;
    tell(waiting.name, waiting.title, waiting.body, waiting.at);
  }
  for (const name of open) if (!names.has(name)) untell(name);
  open = names;
}

function fromRequest(row: Session, request: Request, conversation: Conversation): Waiting {
  const asked = request.asked;
  let body: string;
  if (asked.type === "permissionAsked") {
    const what = asks(asked, asked.call === null ? null : conversation.call(asked.call));
    // A command names its program and no more: its arguments are where a
    // token or a password would be.
    const phrase = what.shape === "command" && what.object !== null ? { ...what, object: program(what.object) } : what;
    body = `Asks to ${phraseText(phrase)}`;
  } else body = `Asks: ${asked.questions[0]?.question ?? "a question"}`;
  return {
    name: JSON.stringify(["ask", row.key, request.request]),
    title: titleFor(row),
    body: line(body),
    at: answeredIn(row),
  };
}

/** The row a session's question is answered in: the dock of the
    integrated session that started it, while that runs, else its own. */
function answeredIn(row: Session): string {
  const starter = byToken(startedFor(row.key));
  return starter !== null && starter.kind === "integrated" && starter.status === "running" ? starter.key : row.key;
}

/** The program a command runs, without the settings put before it or the
    arguments after it. */
export function program(command: string): string {
  const words = (command.split("\n")[0] ?? "").trim().split(/\s+/);
  const first = words.find((word) => word !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? words[0] ?? command;
  return first.split("/").filter(Boolean).pop() ?? first;
}

function fromConduct(ask: ConductAsk): Waiting {
  // The session by the name it would have, not by its prompt, which says
  // more than a notification should.
  const given = ask.request.arguments?.name;
  const body =
    ask.round !== null
      ? `Wants another round of ${ask.round.step} on “${ask.round.name}”`
      : typeof given === "string" && given.trim() !== ""
        ? `Wants to start “${given.trim()}”`
        : "Wants to start a session";
  return {
    name: JSON.stringify(["conduct", ask.request.id]),
    title: `${projectLabel(ask.project)} · ${ask.caller}`,
    body: line(body),
    at: null,
  };
}

function fromSettings(ask: SettingsAsk): Waiting {
  const row = runningByToken(ask.request.session);
  return {
    name: JSON.stringify(["settings", ask.request.id]),
    title: row === null ? ask.caller : titleFor(row),
    body: line(`Wants to change ${kinds(ask)}`),
    at: null,
  };
}

/** What kind of settings a change touches, in the app's words, and not
    the agent's reason or the values. */
function kinds(ask: SettingsAsk): string {
  if (ask.request.tool === "theme_save") return "the look, with a theme of its own";
  if (ask.request.tool === "styles_write") return "the stylesheet";
  const touched = new Set(ask.changes.map((change) => kindOf(change.field)));
  const said = [...touched];
  if (said.length === 0) return "the settings";
  return said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}`;
}

function kindOf(field: string): string {
  if (field === "keyPreset" || field.startsWith("keys")) return "the key chords";
  if (field.startsWith("workflow") || field === "defaultWorkflow") return "the workflows";
  if (field === "userStyles" || field === "css") return "the stylesheet";
  return "the look";
}

/** One line of what may be an agent's text, as the user may safely read
    it, cut where it runs long. */
function line(text: string): string {
  const first =
    shown(text)
      .split("\n")
      .find((candidate) => candidate.trim() !== "")
      ?.trim() ?? "";
  const chars = Array.from(first);
  return chars.length > LINE ? `${chars.slice(0, LINE - 1).join("")}…` : first;
}

/** Test seam. */
export function resetAskNotices() {
  open = new Set();
}
