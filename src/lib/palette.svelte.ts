import { tick } from "svelte";
import { ACTIONS, chordFor, describe, type ActionKey } from "$lib/keys.svelte";
import { actionFor, type Action } from "$lib/keymap";
import { matches } from "$lib/files.svelte";
import { openRemote } from "$lib/remote.svelte";
import {
  focusPane,
  layout,
  peekSessions,
  returnFocus,
  sessionsShown,
} from "$lib/layout.svelte";
import {
  accountLabel,
  accountOf,
  hasAccounts,
  names,
} from "$lib/accounts.svelte";
import { agentLabel, installed, isReady } from "$lib/agent.svelte";
import type { AgentId } from "$lib/core";
import {
  defaultAgent,
  label,
  liveCount,
  sessions,
  waitingOnYou,
  type Session,
} from "$lib/sessions.svelte";
import {
  activate,
  goTo,
  pick,
  projectLabel,
  startSession,
  workspace,
} from "$lib/workspace.svelte";
import { unfoldSessions } from "$lib/viewers.svelte";
import { reduced } from "$lib/motion";

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
 *
 * A new session is asked for in steps in the same field: the project, then
 * the account when accounts are named, then how it runs, which is the agent
 * when more than one is installed. Each answer becomes a chip, and a step
 * with nothing to choose is not asked. The session starts on the last
 * answer.
 */

export type Mode = "goto" | "commands" | "new";

export type CommandId = "new" | "newHere" | "open" | "remote";

/** An answer to one of the questions a new session asks. */
export type Step =
  | { kind: "project"; path: string }
  | { kind: "account"; account: string | null }
  | { kind: "agent"; agent: AgentId };

export type StepKind = Step["kind"];

export type PaletteItem =
  | {
      kind: "attention";
      id: "attention";
      label: string;
      detail: string;
      waiting: number;
      chord: string;
      group: null;
    }
  | {
      kind: "session";
      id: string;
      label: string;
      group: string;
      session: Session;
      project: string;
      when: string;
    }
  | {
      kind: "project";
      id: string;
      label: string;
      group: string;
      path: string;
      end: string;
    }
  | {
      kind: "command";
      id: string;
      label: string;
      group: null;
      command: CommandId;
      chord: string;
    }
  | {
      kind: "choice";
      id: string;
      label: string;
      group: string;
      step: Step;
      end: string;
    }
  | {
      kind: "action";
      id: string;
      label: string;
      group: null;
      action: ActionKey;
      chord: string;
    };

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

export const palette = $state({
  open: false,
  mode: "goto" as Mode,
  query: "",
  /** The answers given so far to a new session's questions. */
  steps: [] as Step[],
  /** What was typed in the commands when a new session was asked for from
      there, which stepping back to them puts in the field again. */
  came: "",
  /** Counts every time a list is opened, so a palette still fading out from
      the last close takes the keyboard again. */
  opened: 0,
  /** The palette is closed and fading out, which it stays drawn for. */
  leaving: false,
});

/** How long the palette takes to fade out, in milliseconds. */
export const FADE = 110;

let leaveTimer: ReturnType<typeof setTimeout> | null = null;

function stopLeaving() {
  if (leaveTimer !== null) clearTimeout(leaveTimer);
  leaveTimer = null;
  palette.leaving = false;
}

export function openGoTo() {
  palette.mode = "goto";
  palette.query = "";
  palette.steps = [];
  palette.came = "";
  palette.opened += 1;
  stopLeaving();
  palette.open = true;
}

export function openCommands() {
  palette.mode = "commands";
  palette.query = "";
  palette.steps = [];
  palette.came = "";
  palette.opened += 1;
  stopLeaving();
  palette.open = true;
}

/** The commands palette, for callers that only know there is one. */
export const openPalette = openCommands;

/** Puts the palette away and hands the keyboard back to the pane that had
    it. The palette stays drawn for the length of its fade, so the keyboard
    is not left to its removal. */
export function closePalette() {
  if (!palette.open) return;
  palette.open = false;
  returnFocus();
  if (reduced()) return;
  palette.leaving = true;
  leaveTimer = setTimeout(stopLeaving, FADE);
}

/** Test seam. */
export function resetPalette() {
  stopLeaving();
  palette.open = false;
  palette.mode = "goto";
  palette.query = "";
  palette.steps = [];
  palette.came = "";
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
    ...sessions.all
      .filter((session) => session.project === path)
      .map((session) => session.changedAt),
    ...(sessions.history[path] ?? []).map(
      (transcript) => transcript.modified * 1000,
    ),
  ];
  return times.length === 0 ? null : Math.max(...times);
}

/** A time as a row's end spells it: "now", or a count of minutes, hours,
    days, weeks or months since. */
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
    .map((project, order) => ({
      path: project.path,
      order,
      used: lastUsed(project.path) ?? 0,
    }))
    .sort((a, b) => b.used - a.used || a.order - b.order)
    .map((project) => project.path);
}

/** How a project stands at a row's end: its live sessions, else how long
    since it was last used. */
function standing(path: string): string {
  const live = liveCount(path);
  if (live > 0) return `${live} live`;
  const used = lastUsed(path);
  return used === null ? "" : since(used);
}

/** The sessions and the projects a query leaves, in that order. */
export function goToItems(query: string): PaletteItem[] {
  const now = Date.now();
  const rows = [...sessions.all]
    .sort((a, b) => b.changedAt - a.changedAt)
    .map((session): PaletteItem => ({
      kind: "session",
      id: `session:${session.key}`,
      label: label(session),
      group: SESSIONS,
      session,
      project: projectLabel(session.project),
      when: since(session.changedAt, now),
    }))
    .filter(
      (item) =>
        item.kind === "session" &&
        matches(`${item.label} ${item.project}`, query),
    );
  const projects = projectsByUse()
    .map((path): PaletteItem => ({
      kind: "project",
      id: `project:${path}`,
      label: projectLabel(path),
      group: PROJECTS,
      path,
      end: standing(path),
    }))
    .filter((item) => matches(item.label, query));
  if (sessions.all.length === 0 && workspace.open.length === 0) {
    const open: PaletteItem = {
      kind: "command",
      id: "command:open",
      label: "Open project",
      group: null,
      command: "open",
      chord: "",
    };
    return matches(open.label, query) ? [open] : [];
  }
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
    waiting: waitingOnYou().filter((session) => session.key !== sessions.active)
      .length,
    chord: describe(chordFor("session.attention")),
  };
  const command = (id: CommandId, label: string): PaletteItem => ({
    kind: "command",
    id: `command:${id}`,
    label,
    group: null,
    command: id,
    chord: "",
  });
  const commands: PaletteItem[] = [
    ...(workspace.open.length === 0 ? [] : [command("new", "New session")]),
    ...(workspace.active === null
      ? []
      : [
          command(
            "newHere",
            `New session in ${projectLabel(workspace.active)}`,
          ),
        ]),
    command("open", "Open project"),
    command("remote", "Open remote project"),
  ];
  const actions = ACTIONS.filter(
    ({ key }) => key !== "palette" && key !== "session.attention",
  ).map(({ key, label }): PaletteItem => ({
    kind: "action",
    id: `action:${key}`,
    label,
    group: null,
    action: key,
    chord: describe(chordFor(key)),
  }));
  return [attention, ...commands, ...actions].filter((item) =>
    matches(
      `${item.label} ${item.kind === "attention" ? item.detail : ""}`,
      query,
    ),
  );
}

/** The question a new session asks next given the answers so far, or null
    when it has all it needs. */
export function nextStep(steps: Step[]): StepKind | null {
  const has = (kind: StepKind) => steps.some((step) => step.kind === kind);
  if (!has("project")) return "project";
  if (hasAccounts() && !has("account")) return "account";
  if (installed().length > 1 && !has("agent")) return "agent";
  return null;
}

/** The questions still to ask, the next first. */
export function stepsLeft(steps: Step[]): StepKind[] {
  const left: StepKind[] = [];
  const taken = [...steps];
  for (let kind = nextStep(taken); kind !== null; kind = nextStep(taken)) {
    left.push(kind);
    taken.push(
      kind === "project"
        ? { kind, path: "" }
        : kind === "account"
          ? { kind, account: null }
          : { kind, agent: "claude-code" },
    );
  }
  return left;
}

/** The project the answers so far name. */
export function projectOfSteps(steps: Step[]): string | null {
  const step = steps.find((candidate) => candidate.kind === "project");
  return step === undefined ? null : step.path;
}

/** An answer as its chip spells it. */
export function chipOf(step: Step): string {
  switch (step.kind) {
    case "project":
      return projectLabel(step.path);
    case "account":
      return accountLabel(step.account);
    case "agent":
      return agentLabel(step.agent);
  }
}

/** What the last question offers, as titled lists drawn in order: the
    agents to run, one model with no workflow. */
function runSections(
  project: string,
): { title: string; items: PaletteItem[] }[] {
  const title = "Agent";
  return [
    {
      title,
      items: installed().map((agent): PaletteItem => ({
        kind: "choice",
        id: `agent:${agent}`,
        label: agentLabel(agent),
        group: title,
        step: { kind: "agent", agent },
        end: sessions.preferred[project] === agent ? "last used" : "",
      })),
    },
  ];
}

/** The projects a new session can go in: the one on screen first, then
    by when they were last used. */
function projectChoices(): PaletteItem[] {
  const group = "In which project";
  const order = projectsByUse();
  const active = workspace.active;
  const paths =
    active !== null && order.includes(active)
      ? [active, ...order.filter((path) => path !== active)]
      : order;
  return paths.map((path): PaletteItem => ({
    kind: "choice",
    id: `project:${path}`,
    label: projectLabel(path),
    group,
    step: { kind: "project", path },
    end: standing(path),
  }));
}

/** The accounts a new session can run under, the agents' own first. */
function accountChoices(project: string): PaletteItem[] {
  if (!isOpen(project)) return [];
  const group = "Under which account";
  const own = accountOf(project);
  return [null, ...names()].map((account): PaletteItem => ({
    kind: "choice",
    id: `account:${account ?? ""}`,
    label: accountLabel(account),
    group,
    step: { kind: "account", account },
    end: account === own ? "this project's" : "",
  }));
}

/** What the question being asked offers, narrowed by what is typed. */
export function stepItems(
  query: string,
  steps: Step[] = palette.steps,
): PaletteItem[] {
  const asking = nextStep(steps);
  const project = projectOfSteps(steps);
  if (asking !== "project" && (project === null || !isOpen(project)))
    return [];
  const all =
    asking === "project"
      ? projectChoices()
      : asking === "account" && project !== null
        ? accountChoices(project)
        : asking === "agent" && project !== null
          ? runSections(project).flatMap((section) => section.items)
          : [];
  return all.filter((item) => matches(item.label, query));
}

/** What the palette lists now, in the order it draws them. */
export function paletteItems(): PaletteItem[] {
  if (palette.mode === "new") return stepItems(palette.query);
  return palette.mode === "goto"
    ? goToItems(palette.query)
    : commandItems(palette.query);
}

/** Whether picking an item does anything: the jump with nothing waiting
    does not, and neither does a new session while no agent is ready. */
export function pickable(item: PaletteItem): boolean {
  if (item.kind === "attention") return item.waiting > 0;
  if (item.kind === "command")
    return isReady() || (item.command !== "new" && item.command !== "newHere");
  return true;
}

/** The entry the cursor starts on when the list is not narrowed: in go to,
    the first session that is not the one on screen; in a new session, the
    account the project runs under or the agent it used last. Null leaves it
    to the first entry that does something. */
export function startingId(): string | null {
  if (palette.query.trim() !== "") return null;
  if (palette.mode === "goto")
    return (
      goToItems("").find(
        (item) => item.kind === "session" && item.session.key !== sessions.active,
      )?.id ?? null
    );
  if (palette.mode !== "new") return null;
  const project = projectOfSteps(palette.steps);
  if (project === null) return null;
  const asking = nextStep(palette.steps);
  if (asking === "account") return `account:${accountOf(project) ?? ""}`;
  if (asking === "agent") return `agent:${defaultAgent(project)}`;
  return null;
}

/** Whether a project is still open. */
function isOpen(path: string): boolean {
  return workspace.open.some((project) => project.path === path);
}

/** Starts a session on the answers given: the project's account and the
    agent it used last stand in for a question that was not asked. A project
    that has closed meanwhile gets none. */
function startOn(steps: Step[]) {
  const path = projectOfSteps(steps);
  if (path === null || !isOpen(path)) return;
  const account = steps.find((step) => step.kind === "account");
  const agent = steps.find((step) => step.kind === "agent");
  startSession(
    path,
    agent?.agent,
    account === undefined ? undefined : account.account,
  );
}

/** Takes an answer, and starts the session when it was the last one asked. */
function answer(steps: Step[]): Outcome {
  if (nextStep(steps) === null)
    return { type: "close", then: () => startOn(steps) };
  palette.mode = "new";
  palette.steps = steps;
  palette.query = "";
  return { type: "stay" };
}

/** Starts asking for a new session, in a project when it is known. With
    one project open the project is known, and is not asked. */
export function beginNew(path: string | null): Outcome {
  if (!isReady()) return { type: "stay" };
  const only = workspace.open.length === 1 ? workspace.open[0].path : null;
  const project = path ?? only;
  if (palette.mode !== "new")
    palette.came = palette.mode === "commands" ? palette.query : "";
  return answer(project === null ? [] : [{ kind: "project", path: project }]);
}

/** Goes back a step: the last answer is taken back, and with none given
    the commands list is where the question came from. */
export function stepBack() {
  palette.query = "";
  const only = workspace.open.length === 1;
  if (palette.steps.length > (only ? 1 : 0)) {
    palette.steps = palette.steps.slice(0, -1);
    return;
  }
  palette.steps = [];
  palette.mode = "commands";
  palette.query = palette.came;
}

/** Gives the keyboard to the sessions pane, which a project with no session
    has instead of a terminal. Called once the page has reacted to the
    project coming forward, which puts a peeked pane back. A folded pane is
    opened first, or while reviewing peeked over the agent so the viewer
    stays. A window too narrow for the pane leaves it folded, as the user
    set it, and the keyboard goes to the agent pane, which has no session to
    give it to and takes it itself. */
function keyboardToSessions() {
  if (!sessionsShown()) {
    if (layout.mode === "reviewing") peekSessions(true);
    else if (!layout.sessionsForced) unfoldSessions();
  }
  focusPane(sessionsShown() ? "sessions" : "agent");
}

/** Picks an item. With `alone` held, a session or project starts a new
    session in its project instead of going to it. */
export function pickItem(item: PaletteItem, alone = false): Outcome {
  if (!pickable(item)) return { type: "stay" };
  switch (item.kind) {
    case "session":
      if (alone) return beginNew(item.session.project);
      return {
        type: "close",
        then: () => void (goTo(item.session.key) && focusPane("agent")),
      };
    case "project":
      if (alone) return beginNew(item.path);
      return {
        type: "close",
        then: () => {
          if (workspace.active !== item.path) activate(item.path);
          if (sessions.active !== null) focusPane("agent");
          else void tick().then(keyboardToSessions);
        },
      };
    case "choice":
      return answer([...palette.steps, item.step]);
    case "attention":
      return { type: "perform", action: { type: "attention" } };
    case "command":
      switch (item.command) {
        case "new":
          return beginNew(null);
        case "newHere":
          return beginNew(workspace.active);
        case "open":
          return { type: "close", then: () => void pick() };
        case "remote":
          return { type: "close", then: () => void openRemote() };
      }
    case "action":
      return { type: "perform", action: actionFor(item.action) };
  }
}
