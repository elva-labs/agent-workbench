import { ACTIONS, chordFor, describe, type ActionKey } from "$lib/keys.svelte";
import { actionFor, type Action } from "$lib/keymap";
import { matches } from "$lib/files.svelte";
import { openRemote } from "$lib/remote.svelte";
import { focusPane } from "$lib/layout.svelte";
import { ago, label, liveCount, sessions, waitingOnYou, type Session } from "$lib/sessions.svelte";
import { activate, goTo, pick, projectLabel, workspace } from "$lib/workspace.svelte";

/**
 * The palette: one field over the workbench in two lists. Go to narrows the
 * sessions and the projects by what is typed, and commands narrows every
 * action the keys can do and the few that have no chord. A `>` typed first
 * in go to switches to commands.
 *
 * A session is listed by when it last changed, with its state, its project
 * and the time. A project is listed with how many sessions are live in it,
 * or when it was last used. An action is listed with its chord. Going to
 * the next session that needs you leads the commands, since it is what the
 * palette is opened for most.
 */

export type Mode = "goto" | "commands";

export type CommandId = "open" | "remote";

export type PaletteItem =
  | { kind: "attention"; id: "attention"; label: string; detail: string; waiting: number; chord: string; group: null }
  | {
      kind: "session";
      id: string;
      label: string;
      group: string;
      session: Session;
      project: string;
      when: string;
    }
  | { kind: "project"; id: string; label: string; group: string; path: string; end: string }
  | { kind: "command"; id: string; label: string; group: null; command: CommandId; chord: string }
  | { kind: "action"; id: string; label: string; group: null; action: ActionKey; chord: string };

/** What picking an item leads to. The palette stays up on a step; it goes
    away before a command or a session is reached, so where the keyboard
    ends up is where it stays; and an action is the page's to perform. */
export type Outcome =
  | { type: "stay" }
  | { type: "close"; then: () => void }
  | { type: "perform"; action: Action };

const JUMP = ACTIONS.find(({ key }) => key === "session.attention")!;

export const ATTENTION_LABEL = JUMP.label;

export const SESSIONS = "Sessions";
export const PROJECTS = "Projects";

export const palette = $state({ open: false, mode: "goto" as Mode, query: "" });

export function openGoTo() {
  palette.mode = "goto";
  palette.query = "";
  palette.open = true;
}

export function openCommands() {
  palette.mode = "commands";
  palette.query = "";
  palette.open = true;
}

/** The commands palette, for callers that only know there is one. */
export const openPalette = openCommands;

export function closePalette() {
  palette.open = false;
}

/** Test seam. */
export function resetPalette() {
  palette.open = false;
  palette.mode = "goto";
  palette.query = "";
}

/** The field changed. A `>` first in go to leaves it for commands, with
    the rest of what was typed. */
export function setQuery(text: string) {
  if (palette.mode === "goto" && text.startsWith(">")) {
    palette.mode = "commands";
    palette.query = text.slice(1);
    return;
  }
  palette.query = text;
}

/** When a project was last used: the latest of its sessions' changes and
    its past sessions, in milliseconds, or null when it has had none. */
export function lastUsed(path: string): number | null {
  const times = [
    ...sessions.all.filter((session) => session.project === path).map((session) => session.changedAt),
    ...(sessions.history[path] ?? []).map((transcript) => transcript.modified * 1000),
  ];
  return times.length === 0 ? null : Math.max(...times);
}

/** A time as a row's end spells it: a count of minutes, hours, days or
    weeks since. */
export function since(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 604_800)}w`;
  return `${Math.floor(seconds / 2_592_000)}mo`;
}

/** The open projects, the latest used first and the rest in the order they
    were opened. */
export function projectsByUse(): string[] {
  return workspace.open
    .map((project, order) => ({ path: project.path, order, used: lastUsed(project.path) ?? 0 }))
    .sort((a, b) => b.used - a.used || a.order - b.order)
    .map((project) => project.path);
}

/** How a project stands at a row's end: its live sessions, else when it
    was last used. */
function standing(path: string): string {
  const live = liveCount(path);
  if (live > 0) return `${live} live`;
  const used = lastUsed(path);
  return used === null ? "" : `last used ${ago(used / 1000)}`;
}

/** The sessions and the projects a query leaves, in that order. */
export function goToItems(query: string): PaletteItem[] {
  const now = Date.now();
  const rows = [...sessions.all]
    .sort((a, b) => b.changedAt - a.changedAt)
    .map(
      (session): PaletteItem => ({
        kind: "session",
        id: `session:${session.key}`,
        label: label(session),
        group: SESSIONS,
        session,
        project: projectLabel(session.project),
        when: since(session.changedAt, now),
      }),
    )
    .filter((item) => item.kind === "session" && matches(`${item.label} ${item.project}`, query));
  const projects = projectsByUse()
    .map(
      (path): PaletteItem => ({
        kind: "project",
        id: `project:${path}`,
        label: projectLabel(path),
        group: PROJECTS,
        path,
        end: standing(path),
      }),
    )
    .filter((item) => matches(item.label, query));
  return [...rows, ...projects];
}

/** The commands a query leaves: the jump to who needs you, then the ones
    with no chord, then every action the keys can do. */
export function commandItems(query: string): PaletteItem[] {
  const attention: PaletteItem = {
    kind: "attention",
    id: "attention",
    label: ATTENTION_LABEL,
    detail: JUMP.group,
    group: null,
    // The jump goes to sessions other than the one on screen, so those are
    // what it counts.
    waiting: waitingOnYou().filter((session) => session.key !== sessions.active).length,
    chord: describe(chordFor("session.attention")),
  };
  const commands: PaletteItem[] = [
    { kind: "command", id: "command:open", label: "Open project", group: null, command: "open", chord: "" },
    { kind: "command", id: "command:remote", label: "Open remote project", group: null, command: "remote", chord: "" },
  ];
  const actions = ACTIONS.filter(({ key }) => key !== "palette" && key !== "session.attention").map(
    ({ key, label }): PaletteItem => ({
      kind: "action",
      id: `action:${key}`,
      label,
      group: null,
      action: key,
      chord: describe(chordFor(key)),
    }),
  );
  return [attention, ...commands, ...actions].filter((item) =>
    matches(`${item.label} ${item.kind === "attention" ? item.detail : ""}`, query),
  );
}

/** What the palette lists now, in the order it draws them. */
export function paletteItems(): PaletteItem[] {
  return palette.mode === "goto" ? goToItems(palette.query) : commandItems(palette.query);
}

/** Whether picking an item does anything: the jump with nothing waiting
    does not. */
export function pickable(item: PaletteItem): boolean {
  return !(item.kind === "attention" && item.waiting === 0);
}

/** Picks an item. */
export function pickItem(item: PaletteItem): Outcome {
  if (!pickable(item)) return { type: "stay" };
  switch (item.kind) {
    case "session":
      return { type: "close", then: () => void (goTo(item.session.key) && focusPane("agent")) };
    case "project":
      return {
        type: "close",
        then: () => {
          activate(item.path);
          if (sessions.active !== null) focusPane("agent");
        },
      };
    case "attention":
      return { type: "perform", action: { type: "attention" } };
    case "command":
      return { type: "close", then: () => void (item.command === "open" ? pick() : openRemote()) };
    case "action":
      return { type: "perform", action: actionFor(item.action) };
  }
}
