import { tick } from "svelte";
import { core, type IntegratedPreview } from "$lib/core";
import { goBack, joined, linkOf, shortNames, type BackWay } from "$lib/integrated.svelte";
import { senderOf } from "$lib/senders.svelte";
import { byKey } from "$lib/sessions.svelte";
import { spoken } from "$lib/instructions";

/**
 * Going back to an earlier message, as the window offers it.
 *
 * Esc Esc in an empty composer, the palette, or "Go back to here" on a
 * message of the user's own opens a list over the composer of every
 * message of the user's own the agent keeps, oldest first, the newest
 * marked. The core says of each whether the conversation and the files
 * can go back to before it, and for an agent that puts files back a dry
 * run says what would change, read row by row as the list stands open.
 * Enter turns the list into the choices for the marked message: the
 * conversation alone, the conversation and the files, or only the files,
 * each where the agent can. Picking one goes back through the core.
 *
 * The list opens only while the session is at rest: no turn, compaction
 * or subagent at work, nothing waiting for a turn or for the user, and
 * the session not starting again. It closes once that is no longer so.
 */

/** A message of the user's own the list offers, with what going back to
    before it takes. */
export interface BackRow {
  message: string;
  /** The first line of what it said. */
  line: string;
  at: number | null;
  conversation: boolean;
  files: boolean;
  why: string | null;
}

/** What putting the files back would change, while it is read, once read,
    or why it could not be. */
export type Preview = IntegratedPreview | "reading" | { error: string };

/** One of the choices for the marked message. */
export interface BackChoice {
  way: BackWay;
  label: string;
  /** What it does, every file it puts back named. */
  detail: string;
  /** Where it puts files back, the words around their names and the
      names, so all but the first can wait behind "n more". */
  files: { before: string; names: string[]; after: string } | null;
  /** Going back this way can be undone from the thread. */
  undoable: boolean;
}

/** How many of a choice's files are named before the rest wait behind
    "n more". */
export const NAMED = 3;

/** The list over one session's composer. */
export class Back {
  /** Shut, the list of messages, or the choices for the marked one. */
  phase = $state<"list" | "choices" | null>(null);
  rows = $state<BackRow[]>([]);
  /** The marked row. */
  marked = $state(0);
  /** The marked choice, in the choices. */
  choice = $state(0);
  /** The choices whose files are all named, past the first few. */
  named = $state<BackWay[]>([]);
  /** The core is asked where the conversation can go back to. */
  reading = $state(false);
  /** Why nothing can be gone back to, said in place of the rows. */
  why = $state<string | null>(null);
  /** What putting the files back would change, by message. */
  previews = $state<Record<string, Preview>>({});
  /** Counts each opening, so what an earlier one asked lands nowhere. */
  opened = 0;
}

/** The lists by session; each holds its own state, so the map needs
    none. */
const backs = new Map<string, Back>();

/** The list over a session's composer, made the first time it is asked
    for. */
export function backOf(key: string): Back {
  let back = backs.get(key);
  if (back === undefined) {
    back = new Back();
    backs.set(key, back);
  }
  return back;
}

/** The message the list marks, while it is open: the one the thread
    draws as the place it would go back to. */
export function markedOf(key: string): string | null {
  const back = backOf(key);
  if (back.phase === null) return null;
  return back.rows[back.marked]?.message ?? null;
}

/** Why a session is not at rest for going back, or null when it is. */
export function unrested(key: string): string | null {
  const link = linkOf(key);
  if (link === null || link.handle === null || link.restarting) return "it is starting";
  if (link.goingBack !== null) return "it is going back";
  const conversation = link.conversation;
  if (conversation.current !== null || conversation.compacting) return "a turn runs";
  if (conversation.open.length > 0) return "it waits for an answer";
  if (conversation.waiting.some((message) => message.state !== "failed")) return "a message waits";
  if (conversation.state !== null && conversation.state !== "idle") return "it is at work";
  return null;
}

/** Whether a session's list can open: it is at rest, and its thread holds
    a message of the user's own. */
export function canGoBack(key: string): boolean {
  const link = linkOf(key);
  if (link === null || unrested(key) !== null) return false;
  return link.conversation.entries.some(
    (entry) => entry.kind === "user" && senderOf({ id: entry.message }) === null,
  );
}

/** The first line of a message's words, as the user wrote them. */
function lineOf(text: string): string {
  const words = spoken(text, true).text.trim();
  return words.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/**
 * Opens the list over a session's composer, marking `at` where given and
 * the newest message otherwise; with `choices`, at the choices for the
 * marked message. Asks the core where the conversation can go back to,
 * then, for an agent that puts files back, what each message's files
 * would come to. False where the session is not at rest.
 */
export async function openBack(key: string, at: string | null = null, choices = false): Promise<boolean> {
  const link = linkOf(key);
  if (link === null || link.handle === null || unrested(key) !== null) return false;
  const back = backOf(key);
  const opening = ++back.opened;
  back.phase = "list";
  back.rows = [];
  back.marked = 0;
  back.choice = 0;
  back.named = [];
  back.why = null;
  back.previews = {};
  back.reading = true;
  let points;
  try {
    points = await core().integratedRewindPoints(link.handle);
  } catch (error) {
    if (back.opened !== opening) return false;
    back.reading = false;
    back.why = `The messages could not be read: ${error instanceof Error ? error.message : String(error)}.`;
    return true;
  }
  if (back.opened !== opening || back.phase === null) return false;
  back.reading = false;
  back.why = points.why;
  const conversation = link.conversation;
  back.rows = points.points.flatMap((point) => {
    const said = conversation.messages[point.message];
    if (said === undefined || senderOf(said) !== null) return [];
    return [{ ...point, line: lineOf(said.text), at: said.at }];
  });
  if (back.rows.length === 0 && back.why === null) back.why = "There is no message of yours to go back to.";
  const found = at === null ? -1 : back.rows.findIndex((row) => row.message === at);
  back.marked = found >= 0 ? found : Math.max(0, back.rows.length - 1);
  if (choices && found >= 0) toChoices(key);
  void readPreviews(key, opening);
  return true;
}

/** Reads, row by row from the newest, what putting each message's files
    back would change, while the list this opening made stands open. */
async function readPreviews(key: string, opening: number) {
  const back = backOf(key);
  const rows = [...back.rows].reverse().filter((row) => row.files);
  for (const row of rows) {
    const link = linkOf(key);
    if (back.opened !== opening || back.phase === null || link === null || link.handle === null) return;
    back.previews[row.message] = "reading";
    try {
      back.previews[row.message] = await core().integratedRewindPreview(link.handle, row.message);
    } catch (error) {
      back.previews[row.message] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Shuts the list. */
export function closeBack(key: string) {
  const back = backs.get(key);
  if (back === undefined) return;
  back.phase = null;
  back.opened += 1;
}

/** Moves the list's mark by `step`, or to its first or last row. A
    choice marked by a key names all its files. */
export function moveBack(key: string, step: number | "first" | "last") {
  const back = backOf(key);
  const count = back.phase === "choices" ? choicesOf(key).length : back.rows.length;
  if (count === 0) return;
  const now = back.phase === "choices" ? back.choice : back.marked;
  const next = step === "first" ? 0 : step === "last" ? count - 1 : Math.min(count - 1, Math.max(0, now + step));
  if (back.phase === "choices") {
    back.choice = next;
    nameAll(key, next);
  } else back.marked = next;
}

/** Names all the files of the choice at `index`, past the first few. */
export function nameAll(key: string, index: number) {
  const back = backOf(key);
  const way = choicesOf(key)[index]?.way;
  if (way !== undefined && !back.named.includes(way)) back.named = [...back.named, way];
}

/** Whether every file the choice at `index` puts back is named. */
export function allNamed(key: string, index: number): boolean {
  const choice = choicesOf(key)[index];
  if (choice === undefined) return false;
  return choice.files === null || choice.files.names.length <= NAMED || backOf(key).named.includes(choice.way);
}

/** Marks a row of the list, or a choice, by its place. */
export function markBack(key: string, index: number) {
  const back = backOf(key);
  if (back.phase === "choices") back.choice = index;
  else back.marked = index;
}

/** The files a preview names, where it was read and names any. */
export function previewFiles(preview: Preview | undefined): string[] {
  return preview === undefined || preview === "reading" || "error" in preview ? [] : preview.files;
}

/** The choices for the marked message, in order: the conversation alone
    first, where it can go back, then with the files, then the files
    alone, where the agent's dry run named files to put back. */
export function choicesOf(key: string): BackChoice[] {
  const back = backOf(key);
  const row = back.rows[back.marked];
  if (row === undefined) return [];
  const preview = back.previews[row.message];
  const files = previewFiles(preview);
  const counts =
    preview !== undefined && preview !== "reading" && !("error" in preview)
      ? `, +${preview.insertions}\u00a0−${preview.deletions}`
      : "";
  const codex = byKey(key)?.agent === "codex";
  const names = shortNames(files);
  const as = `back as ${files.length === 1 ? "it was" : "they were"}${counts}.`;
  const putting = (before: string, after: string) => ({
    detail: `${before}${joined(names)}${after}`,
    files: { before, names, after },
    undoable: false,
  });
  const out: BackChoice[] = [];
  if (row.conversation)
    out.push({
      way: "conversation",
      label: "The conversation",
      detail: codex
        ? "Your message comes back to edit."
        : "Your message comes back to edit. Files stay as they are.",
      files: null,
      undoable: !codex,
    });
  if (row.conversation && files.length > 0)
    out.push({
      way: "both",
      label: "The conversation and the files",
      ...putting("Also puts ", ` ${as} What commands changed stays. It cannot be undone.`),
    });
  if (files.length > 0)
    out.push({
      way: "files",
      label: "Only the files",
      // Only Claude Code puts files back.
      ...putting("Puts ", ` ${as} The conversation stays as it is, and Claude Code is told of it. It cannot be undone.`),
    });
  return out;
}

/** Turns the list into the choices for the marked message, where it has
    any; false where it has none. */
export function toChoices(key: string): boolean {
  const back = backOf(key);
  if (choicesOf(key).length === 0) return false;
  back.phase = "choices";
  back.choice = 0;
  back.named = [];
  nameAll(key, 0);
  return true;
}

/** Back from the choices to the list. */
export function toList(key: string) {
  const back = backOf(key);
  if (back.phase === "choices") back.phase = "list";
}

/**
 * Takes the choice at `index` for the marked message: the list shuts and
 * the session goes back. Resolves to why it did not, or null.
 */
export async function pickBack(key: string, index: number): Promise<string | null> {
  const back = backOf(key);
  const row = back.rows[back.marked];
  const choice = choicesOf(key)[index];
  if (row === undefined || choice === undefined) return "There is nothing to go back to.";
  const shown = previewFiles(back.previews[row.message]);
  closeBack(key);
  const why = await goBack(key, row.message, choice.way, shown);
  const link = linkOf(key);
  if (why !== null && link !== null && link.backSaid === null) link.backSaid = `It did not go back: ${why}`;
  await tick();
  return why;
}

/** What the list says under its rows of the marked message: what leaves,
    or why it cannot go back there. */
export function backSaidOf(key: string, agent: string): string {
  const back = backOf(key);
  const row = back.rows[back.marked];
  if (row === undefined) return "";
  const codex = byKey(key)?.agent === "codex";
  if (!row.conversation) {
    const files = previewFiles(back.previews[row.message]).length > 0;
    return `${row.why ?? "The conversation cannot go back to before this message."}${files ? " Its files can." : ""}`;
  }
  const after = back.rows.length - back.marked - 1;
  const leaves =
    after === 0
      ? `This message and what ${agent} did for it leave the conversation.`
      : `This message and the ${after} after it leave the conversation, with what ${agent} did for them.`;
  return !codex && !row.files ? `${leaves} Files cannot go back to here.` : leaves;
}

/** What taking a choice costs, under the choices: Claude Code starting
    again and the commands it left running that stop with it, or for Codex
    that files stay and it cannot be undone. */
export function backCostOf(key: string): string {
  const session = byKey(key);
  const link = linkOf(key);
  if (session === null || link === null) return "";
  if (session.agent === "codex")
    return "Codex cannot put files back: they stay as they are now. Going back cannot be undone.";
  const running = link.conversation.tasks
    .filter((task) => task.kind === "shell" && task.background && task.status === "running")
    .map((task) => task.description ?? "a command")
    .filter((name, at, all) => all.indexOf(name) === at);
  if (running.length === 0) return "Claude Code starts again for this.";
  return `Claude Code starts again for this, so ${joined(running)}, which it left running, ${running.length === 1 ? "stops" : "stop"}.`;
}

/** Test seam. */
export function resetBack() {
  backs.clear();
}
