/**
 * The tools an agent reads and changes the workbench's own settings with.
 *
 * Reading is answered at once. A change is checked whole first, and a
 * change that will not do is refused with the reason before the user sees
 * anything. One that will do is put to the user, as the settings it
 * changes from and to, with the agent's reason: nothing changes unless
 * they allow it. Once it is made, the user is offered an undo for a while.
 * Changes take their turn one after another, and each is checked again
 * against the settings as they are when its turn comes, so what the user
 * reads is what it would change then. Every call is answered exactly once:
 * the agent on the other side is blocked until it is.
 *
 * A theme of the user's own is saved the same way: checked against the
 * rules the core keeps it by and for being readable, then shown to the
 * user as swatches with the switch to it, and kept only if they allow it.
 *
 * So is the user's own stylesheet: checked against the rules the core
 * keeps it by, then shown to the user as the sheet itself, and written and
 * turned on only if they allow it. Undo puts back the sheet it replaced.
 *
 * The hooks and the plugins are not the agent's to change. They are
 * refused with a word saying they are the user's, in the settings.
 */

import { noteSent } from "$lib/persist";
import { core, type SettingsRequest, type UnreadWorkflow } from "$lib/core";
import {
  COLOUR_TOKENS,
  SHAPE_TOKENS,
  checkTheme,
  readability,
  type CustomTheme,
} from "$lib/customThemes";
import {
  ACTIONS,
  PRESETS,
  PRESET_LABELS,
  chordText,
  describe,
  keys,
  labelOf,
  parseChord,
  presetOf,
  sameChord,
  setBindings,
  tableProblem,
  type ActionKey,
  type Keymap,
  type PresetName,
} from "$lib/keys.svelte";
import { label, sessions } from "$lib/sessions.svelte";
import { AGENT_ORDER, CODEX_DEFAULT, modelsOf } from "$lib/models";
import {
  changed,
  describeWorkflow,
  readWorkflow,
  MOST_PARALLEL,
  MOST_ROUNDS,
  MOST_STEPS,
  takeWorkflowChange,
  workflowsSettings,
  type WorkflowChange,
} from "$lib/workflows.svelte";
import { projectLabel } from "$lib/workspace.svelte";
import { setUserStyles, styleProblem, userStyles } from "$lib/userStyles.svelte";
import {
  INTERFACE_FONTS,
  LOOKS,
  PALETTES,
  TERMINAL_FONTS,
  setLook,
  setMono,
  setPalette,
  setSans,
  setTheme,
  setThemes,
  theme,
  type LookName,
  type MonoName,
  type SansName,
  type ThemeChoice,
} from "$lib/theme.svelte";

/** One line of a change as the user reads it. */
export interface Change {
  /** What the tool calls it: `palette`, or `keys.review`. */
  field: string;
  label: string;
  from: string;
  to: string;
}

/** The settings a change leaves, for the parts it touches. */
interface Next {
  appearance?: ThemeChoice;
  look?: LookName;
  palette?: string;
  /** The whole set of the user's own themes, when a theme is saved. */
  themes?: Record<string, CustomTheme>;
  userStyles?: boolean;
  /** The user's stylesheet, whole, when one is written. */
  css?: string;
  terminalFont?: MonoName;
  interfaceFont?: SansName;
  keys?: Keymap;
  /** A workflow added or replaced, one deleted, or the default named. */
  workflows?: WorkflowChange;
}

export interface Ask {
  request: SettingsRequest;
  /** Who is asking, as the sessions pane names it. */
  caller: string;
  reason: string | null;
  changes: Change[];
  /** A theme being saved, to be shown as swatches. */
  theme: CustomTheme | null;
  /** A stylesheet being written, to be shown as it is. */
  css: string | null;
}

export interface Undo {
  caller: string;
  changes: Change[];
}

export const settingsAsk = $state({
  asking: null as Ask | null,
  /** The last change made, while it can still be undone. */
  undo: null as Undo | null,
});

/** How long a change can be undone from the word that says it was made. */
export const UNDO_FOR = 20_000;

const APPEARANCES: { name: ThemeChoice; label: string }[] = [
  { name: "system", label: "System" },
  { name: "light", label: "Light" },
  { name: "dark", label: "Dark" },
];

/** Names an agent might reach for that are the user's alone. */
const USERS_OWN = new Set([
  "hooks",
  "hooksEverywhere",
  "liveUpdates",
  "plugins",
  "plugin",
  "accounts",
  "account",
  "pastSessions",
  "inactiveAfter",
  "notifications",
  "chime",
  "workflowOverrides",
  "workflowOverride",
  "projectWorkflow",
  "projectWorkflows",
]);

/** The ids of the calls handled lately, so a call delivered twice is
    handled once. */
const seen = new Set<string>();
const SEEN = 500;

interface Answered {
  content: string | null;
  error: string | null;
}

const said = (content: string): Answered => ({ content, error: null });
const refused = (error: string): Answered => ({ content: null, error });

type Choice = "allow" | "decline";
/** The last change in line: the next one starts when it is done. */
let line: Promise<unknown> = Promise.resolve();
let pending: ((choice: Choice) => void) | null = null;
let restore: (() => void) | null = null;
let undoTimer: ReturnType<typeof setTimeout> | null = null;

/** Answers one call, exactly once. */
export async function handle(request: SettingsRequest): Promise<void> {
  if (seen.has(request.id)) return;
  seen.add(request.id);
  if (seen.size > SEEN) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  let answered: Answered;
  try {
    answered =
      request.tool === "settings"
        ? said(describeSettings())
        : await change(
            request,
            request.tool === "theme_save"
              ? planTheme
              : request.tool === "styles_write"
                ? planStyles
                : plan,
          );
  } catch (error) {
    answered = refused(error instanceof Error ? error.message : String(error));
  }
  await core()
    .settingsAnswer(request.id, request.cwd, answered.content, answered.error)
    .catch(() => {});
}

function nameOf<Name extends string>(
  list: { name: Name; label: string }[],
  value: string,
): string {
  return list.find((item) => item.name === value)?.label ?? value;
}

/** The palettes a palette may be: the app's, then the user's own themes. */
function palettes(): { name: string; label: string }[] {
  return [
    ...PALETTES,
    ...Object.entries(theme.themes).map(([name, custom]) => ({ name, label: custom.label })),
  ];
}

/** The settings as the agent reads them, each with what it takes. */
export function describeSettings(): string {
  const names = (list: { name: string }[]) => list.map((item) => item.name).join(", ");
  const own = Object.entries(theme.themes);
  const lines = [
    "Agent Workbench's settings, on the machine the user's window runs on.",
    "",
    `appearance: ${theme.choice} (one of ${names(APPEARANCES)})`,
    `look: ${theme.look} (one of ${names(LOOKS)})`,
    `palette: ${theme.palette} (one of ${names(palettes())})`,
    `terminalFont: ${theme.mono} (one of ${names(TERMINAL_FONTS)})`,
    `interfaceFont: ${theme.sans} (one of ${names(INTERFACE_FONTS)})`,
    `keyPreset: ${keys.preset} (one of ${Object.keys(PRESETS).join(", ")}; custom once a chord differs from both)`,
    "",
    "keys, by action: the chord, then what the action does. The platform modifier, Cmd on macOS and Ctrl elsewhere, is part of every chord and is not written. c and r without shift stay with the agent.",
    ...ACTIONS.map(
      ({ key, label }) => `  ${key}: ${chordText(keys.bindings[key])}  (${label})`,
    ),
    "",
    "",
    own.length === 0
      ? "The user has no themes of their own."
      : `The user's own themes: ${own.map(([name, custom]) => `${name} (${custom.label})`).join(", ")}.`,
    `A theme saved with theme_save sets colours for light and for dark, by token: ${COLOUR_TOKENS.join(", ")}; and measures of the chrome, whole pixels: ${Object.entries(
      SHAPE_TOKENS,
    )
      .map(([token, most]) => `${token} up to ${most}px`)
      .join(", ")}. A token left out keeps the default palette's value.`,
    "",
    ...describeWorkflows(),
    "",
    `userStyles: ${userStyles.on} (true or false): whether the user's own stylesheet is laid over the app's.`,
    userStyles.problem !== null
      ? `The user's stylesheet on disk is not used: ${userStyles.problem}.`
      : userStyles.css === ""
        ? "The user has no stylesheet of their own."
        : `The user's stylesheet, which styles_write replaces whole:\n\`\`\`css\n${sheetExcerpt(userStyles.css)}\n\`\`\``,
    "",
    "Change them with settings_change, naming only what should change. The agent hooks, the plugins, the accounts, how long past sessions stay listed, the notifications and the chime are the user's to change, in the settings.",
  ];
  return lines.join("\n");
}

/** The workflows as the agent reads them, with the shape it writes one in. */
function describeWorkflows(): string[] {
  const held = workflowsSettings();
  return [
    "",
    "workflows: a workflow says which model a session starts on, the orchestrator, and the steps it hands out in order. The user's:",
    held.list.length === 0
      ? "  none."
      : `\`\`\`json\n${JSON.stringify(held.list, null, 2)}\n\`\`\``,
    held.default === null
      ? "New sessions start with no workflow."
      : `New sessions start with the workflow ${held.default}.`,
    ...setAside(held.unread ?? []),
    `Change one with settings_change's workflow argument, a whole workflow that replaces the one of its name or adds one: {"name", "orchestrator": {"agent", "model"}, "steps": [...]}. startOnly, true when left out, takes away the orchestrator's own ways of handing work to agents the user cannot see, so it hands out work only through start; false leaves it its subagents. New sessions follow a workflow only once one is the default or a project's choice, or the user picks one when starting a session. A step is {"kind": "work", "name", "models", "parallel"} or {"kind": "review", "name", "models", "reviewerApproves", "orchestratorAgrees", "backTo", "limit"}. models is a list of {"agent", "model"}, each model one word and listed once, and empty means any model; the first is used unless there is a reason to pick another. parallel is how many sessions run at once, 1 to ${MOST_PARALLEL}. A review passes when the reviewer approves, the orchestrator agrees, or both, so one is true; backTo names an earlier work step and limit, 1 to ${MOST_ROUNDS}, is how many times it goes back before the user is asked. Names are unique, a workflow has 1 to ${MOST_STEPS} steps and the first does work. The agents are ${AGENT_ORDER.join(" and ")}: claude-code takes the models ${modelsOf("claude-code").map((option) => option.model).join(", ")}, and codex takes ${CODEX_DEFAULT}, its own default. deleteWorkflow takes a workflow's name away and defaultWorkflow names the one new sessions start with, or null for none. Which workflow a project follows is the user's to choose.`,
  ];
}

/** The workflows the settings file holds but cannot use, each with why and
    as written, so an agent asked to mend one can write it again whole. */
function setAside(unread: UnreadWorkflow[]): string[] {
  if (unread.length === 0) return [];
  return [
    "The settings file also holds workflows that are not used, because they do not keep the rules. Writing a workflow under one's name with the workflow argument mends it, and it takes back the default and the project choices that named it:",
    ...unread.map((entry) => {
      const named = [
        entry.default ? "the file names it for new sessions" : null,
        entry.projects.length === 1
          ? "a project's choice names it"
          : entry.projects.length > 1
            ? `${entry.projects.length} projects' choices name it`
            : null,
      ].filter((part) => part !== null);
      return `- ${entry.name ?? "A workflow without a name"}: ${entry.reason}${named.length > 0 ? `; ${named.join(", ")}` : ""}. As written:\n\`\`\`json\n${JSON.stringify(entry.entry, null, 2)}\n\`\`\``;
    }),
  ];
}

/** How much of the user's sheet the settings tool reads out. */
const EXCERPT = 8000;

function sheetExcerpt(css: string): string {
  return css.length <= EXCERPT
    ? css
    : `${css.slice(0, EXCERPT)}\n/* ${css.length - EXCERPT} more characters, left out here */`;
}

function oneOf<Name extends string>(
  field: string,
  value: unknown,
  list: { name: Name }[],
): Name {
  const found = list.find((item) => item.name === value);
  if (found === undefined) {
    throw new Error(
      `${field} is one of ${list.map((item) => item.name).join(", ")}, not ${JSON.stringify(value)}.`,
    );
  }
  return found.name;
}

/**
 * What a call's arguments would change, checked whole: every name is one
 * the settings have, every value one they take, and the chord table they
 * leave has no chord twice and none the agent needs. Throws the reason
 * when something will not do.
 */
export function plan(args: Record<string, unknown>): { next: Next; changes: Change[] } {
  const next: Next = {};
  for (const [field, value] of Object.entries(args)) {
    switch (field) {
      case "reason":
        break;
      case "appearance":
        next.appearance = oneOf(field, value, APPEARANCES);
        break;
      case "look":
        next.look = oneOf(field, value, LOOKS);
        break;
      case "palette":
        next.palette = oneOf(field, value, palettes());
        break;
      case "terminalFont":
        next.terminalFont = oneOf(field, value, TERMINAL_FONTS);
        break;
      case "interfaceFont":
        next.interfaceFont = oneOf(field, value, INTERFACE_FONTS);
        break;
      case "keyPreset":
      case "keys":
      case "workflow":
      case "deleteWorkflow":
      case "defaultWorkflow":
        break;
      case "userStyles":
        if (typeof value !== "boolean") throw new Error("userStyles is true or false.");
        next.userStyles = value;
        break;
      default:
        if (USERS_OWN.has(field)) {
          throw new Error(
            `${field} is the user's to change, in the settings, and not an agent's.`,
          );
        }
        throw new Error(
          `There is no setting called ${field}. The settings tool lists them.`,
        );
    }
  }

  const preset = args.keyPreset;
  const chords = args.keys;
  if (preset !== undefined || chords !== undefined) {
    let table: Keymap = { ...keys.bindings };
    if (preset !== undefined) {
      if (typeof preset !== "string" || !(preset in PRESETS)) {
        throw new Error(
          `keyPreset is one of ${Object.keys(PRESETS).join(", ")}, not ${JSON.stringify(preset)}.`,
        );
      }
      table = { ...PRESETS[preset as PresetName] };
    }
    if (chords !== undefined) {
      if (typeof chords !== "object" || chords === null || Array.isArray(chords)) {
        throw new Error("keys is an object of chords by action, such as {\"review\": \"shift+d\"}.");
      }
      for (const [action, text] of Object.entries(chords)) {
        if (!ACTIONS.some((info) => info.key === action)) {
          throw new Error(`There is no action called ${action}. The settings tool lists them.`);
        }
        const chord = typeof text === "string" ? parseChord(text) : null;
        if (chord === null) {
          throw new Error(
            `${JSON.stringify(text)} is not a chord for ${action}. A chord is its key, with shift and alt before it when wanted: k, shift+k, alt+shift+down.`,
          );
        }
        table[action as ActionKey] = chord;
      }
    }
    const problem = tableProblem(table);
    if (problem !== null) throw new Error(problem);
    next.keys = table;
  }

  const planned = planWorkflows(args);
  if (planned !== null) next.workflows = planned.change;

  return {
    next,
    changes: [...changesOf(next), ...(planned === null ? [] : planned.changes)],
  };
}

/** What the workflow arguments of a call would do to the workflows: one
    added or replaced by its name, one deleted, the default named. Checked
    whole against the workflows as they are, and shown as what moves,
    including each project that chose a workflow deleted and would follow
    the default again. Null when the call has none of them. */
function planWorkflows(
  args: Record<string, unknown>,
): { change: WorkflowChange; changes: Change[] } | null {
  const { workflow, deleteWorkflow, defaultWorkflow } = args;
  if (workflow === undefined && deleteWorkflow === undefined && defaultWorkflow === undefined) {
    return null;
  }
  const change: WorkflowChange = {};
  if (workflow !== undefined) change.write = readWorkflow(workflow);
  if (deleteWorkflow !== undefined) {
    if (typeof deleteWorkflow !== "string") {
      throw new Error("deleteWorkflow is the name of a workflow.");
    }
    change.remove = deleteWorkflow;
  }
  if (defaultWorkflow !== undefined) {
    if (defaultWorkflow !== null && typeof defaultWorkflow !== "string") {
      throw new Error("defaultWorkflow is the name of a workflow, or null for none.");
    }
    change.default = defaultWorkflow;
  }
  const before = workflowsSettings();
  const after = changed(before, change);
  const changes: Change[] = [];

  if (change.write !== undefined) {
    const written = change.write;
    const was = before.list.find((held) => held.name === written.name);
    const mended = was === undefined ? before.unread?.find((entry) => entry.name === written.name) : undefined;
    if (was === undefined || JSON.stringify(was) !== JSON.stringify(written)) {
      changes.push({
        field: `workflow.${written.name}`,
        label: `Workflow ${written.name}`,
        from:
          mended !== undefined
            ? `in the file but not used: ${mended.reason}`
            : was === undefined
              ? "none"
              : describeWorkflow(was),
        to: `${describeWorkflow(written)}${was === undefined && mended === undefined ? ", new" : ""}`,
      });
    }
  }
  if (change.remove !== undefined) {
    const name = change.remove;
    const was = before.list.find((held) => held.name === name)!;
    changes.push({
      field: `workflow.${name}`,
      label: `Workflow ${name}`,
      from: describeWorkflow(was),
      to: "deleted",
    });
  }
  const projects = new Set([...Object.keys(before.overrides), ...Object.keys(after.overrides)]);
  const said = (choice: string | null | undefined) =>
    choice === undefined ? "as for new sessions" : (choice ?? "none");
  for (const project of projects) {
    if (after.overrides[project] !== before.overrides[project]) {
      changes.push({
        field: `workflowOverride.${project}`,
        label: `Workflow for ${projectLabel(project)}`,
        from: said(before.overrides[project]),
        to: said(after.overrides[project]),
      });
    }
  }
  if (after.default !== before.default) {
    changes.push({
      field: "defaultWorkflow",
      label: "Workflow for new sessions",
      from: before.default ?? "none",
      to: after.default ?? "none",
    });
  }
  return { change, changes };
}

/** The lines a change shows the user: only what actually moves. */
function changesOf(next: Next): Change[] {
  const changes: Change[] = [];
  const line = (field: string, label: string, from: string, to: string) => {
    if (from !== to) changes.push({ field, label, from, to });
  };
  if (next.appearance !== undefined) {
    line("appearance", "Appearance", nameOf(APPEARANCES, theme.choice), nameOf(APPEARANCES, next.appearance));
  }
  if (next.look !== undefined) {
    line("look", "Look", nameOf(LOOKS, theme.look), nameOf(LOOKS, next.look));
  }
  if (next.palette !== undefined) {
    const known = [
      ...palettes(),
      ...Object.entries(next.themes ?? {}).map(([name, custom]) => ({ name, label: custom.label })),
    ];
    line("palette", "Palette", nameOf(known, theme.palette), nameOf(known, next.palette));
  }
  if (next.terminalFont !== undefined) {
    line(
      "terminalFont",
      "Terminal font",
      nameOf(TERMINAL_FONTS, theme.mono),
      nameOf(TERMINAL_FONTS, next.terminalFont),
    );
  }
  if (next.interfaceFont !== undefined) {
    line(
      "interfaceFont",
      "Interface font",
      nameOf(INTERFACE_FONTS, theme.sans),
      nameOf(INTERFACE_FONTS, next.interfaceFont),
    );
  }
  if (next.userStyles !== undefined) {
    const said = (on: boolean) => (on ? "On" : "Off");
    line("userStyles", "Custom styles", said(userStyles.on), said(next.userStyles));
  }
  if (next.keys !== undefined) {
    const table = next.keys;
    const preset = presetOf(table);
    if (preset !== "custom" && preset !== keys.preset) {
      const from = keys.preset === "custom" ? "Custom" : PRESET_LABELS[keys.preset];
      changes.push({ field: "keyPreset", label: "Keys", from, to: PRESET_LABELS[preset] });
    } else {
      for (const { key } of ACTIONS) {
        if (!sameChord(keys.bindings[key], table[key])) {
          changes.push({
            field: `keys.${key}`,
            label: labelOf(key),
            from: describe(keys.bindings[key]),
            to: describe(table[key]),
          });
        }
      }
    }
  }
  return changes;
}

function callerOf(request: SettingsRequest): string {
  const session =
    request.session === null
      ? undefined
      : sessions.all.find((candidate) => candidate.id === request.session);
  return session === undefined ? "An agent" : label(session);
}

/** Runs a change when the ones before it are done. */
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = line.then(work);
  line = run.catch(() => {});
  return run;
}

/**
 * What saving a theme would change: the theme itself, kept among the
 * user's own under its name, and the palette switched to it. Checked by
 * the rules the core keeps a theme by, and for being readable. Throws the
 * reason when something will not do.
 */
export function planTheme(args: Record<string, unknown>): {
  next: Next;
  changes: Change[];
  theme: CustomTheme;
} {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const fields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(args)) {
    if (field === "name" || field === "reason") continue;
    fields[field] = value;
  }
  const saved = checkTheme(name, fields);
  const unreadable = readability(saved);
  if (unreadable !== null) throw new Error(unreadable);
  const before = theme.themes[name];
  const same = before !== undefined && JSON.stringify(before) === JSON.stringify(saved);
  const next: Next = { themes: { ...theme.themes, [name]: saved }, palette: name };
  const changes: Change[] = [];
  if (!same) {
    changes.push({
      field: "theme",
      label: "Theme",
      from: before === undefined ? "none" : `${before.label} as it was`,
      to: before === undefined ? `${saved.label}, new` : `${saved.label}, changed`,
    });
  }
  if (theme.palette !== name) {
    const known = [...palettes(), { name, label: saved.label }];
    changes.push({
      field: "palette",
      label: "Palette",
      from: nameOf(known, theme.palette),
      to: saved.label,
    });
  }
  return { next, changes, theme: saved };
}

/**
 * What writing the user's stylesheet would change: the sheet, whole, and
 * the styles turned on if they are off. Checked by the rules the core keeps
 * a sheet by. Throws the reason when it will not do.
 */
export function planStyles(args: Record<string, unknown>): {
  next: Next;
  changes: Change[];
  css: string;
} {
  for (const field of Object.keys(args)) {
    if (field !== "css" && field !== "reason") {
      throw new Error(`styles_write takes the css and a reason, not ${field}.`);
    }
  }
  if (typeof args.css !== "string") throw new Error("styles_write needs the css, whole.");
  const css = args.css;
  const problem = styleProblem(css);
  if (problem !== null) throw new Error(`${problem[0].toUpperCase()}${problem.slice(1)}.`);
  const lines = (text: string) => {
    const count = text.trim() === "" ? 0 : text.trimEnd().split("\n").length;
    return count === 0 ? "none" : `${count} ${count === 1 ? "line" : "lines"}`;
  };
  const empty = css.trim() === "";
  const next: Next = { css };
  const changes: Change[] = [];
  if (css !== userStyles.css) {
    changes.push({
      field: "css",
      label: "Stylesheet",
      from: lines(userStyles.css),
      to: lines(css),
    });
  }
  if (!empty && !userStyles.on) {
    next.userStyles = true;
    changes.push({ field: "userStyles", label: "Custom styles", from: "Off", to: "On" });
  }
  return { next, changes, css };
}

async function change(
  request: SettingsRequest,
  planned: (args: Record<string, unknown>) => {
    next: Next;
    changes: Change[];
    theme?: CustomTheme;
    css?: string;
  },
): Promise<Answered> {
  // Checked now, so a change that will not do is refused without a wait.
  planned(request.arguments ?? {});
  return inTurn(async () => {
    const { next, changes, theme: shown, css } = planned(request.arguments ?? {});
    if (changes.length === 0) {
      return said("Nothing to change: the settings are already so.");
    }
    const reason =
      typeof request.arguments?.reason === "string" && request.arguments.reason.trim() !== ""
        ? request.arguments.reason.trim()
        : null;
    const caller = callerOf(request);
    let asked = { next, changes, theme: shown, css };
    // The change is planned again once it is allowed, against the settings
    // as they are by then; if what it would do has moved meanwhile, the user
    // is asked again about what it now does.
    for (;;) {
      const question = asked;
      const choice = await new Promise<Choice>((settle) => {
        settingsAsk.asking = {
          request,
          caller,
          reason,
          changes: question.changes,
          theme: question.theme ?? null,
          css: question.css ?? null,
        };
        pending = settle;
      });
      if (choice === "decline") {
        return refused("The user declined the change. Nothing changed.");
      }
      const now = planned(request.arguments ?? {});
      if (now.changes.length === 0) {
        return said("Nothing to change: the settings are already so.");
      }
      asked = { next: now.next, changes: now.changes, theme: now.theme, css: now.css };
      if (JSON.stringify(now.changes) === JSON.stringify(question.changes)) break;
    }
    const { undo, notSaved } = await take(asked.next);
    const kept = asked.changes.filter((change) => !notSaved.has(storedAs(change.field)));
    const lost = asked.changes.filter((change) => notSaved.has(storedAs(change.field)));
    if (kept.length === 0) {
      return refused(
        `The user allowed the change, but it could not be saved: ${reasonsOf(lost, notSaved)}. Nothing changed.`,
      );
    }
    offerUndo({ caller, changes: kept }, undo);
    const made = kept.map((change) => `${change.label} is now ${change.to}`).join("; ");
    if (lost.length === 0) {
      return said(`The user allowed the change. ${made}. They can undo it for a short while.`);
    }
    const unmade = lost.map((change) => `${change.label} to ${change.to}`).join("; ");
    return said(
      `The user allowed the change, and only part of it was saved. ${made}. Not saved: ${unmade}, because ${reasonsOf(lost, notSaved)}. They can undo what was saved for a short while.`,
    );
  });
}

/** The setting of the file a line of a change is kept in. */
function storedAs(field: string): string {
  if (field === "keyPreset" || field.startsWith("keys.")) return "keys";
  if (field === "theme") return "themes";
  return field;
}

/** The reasons the lines were not saved, each once. */
function reasonsOf(lines: Change[], notSaved: Map<string, string>): string {
  const reasons = new Set(lines.map((change) => notSaved.get(storedAs(change.field))!));
  return [...reasons].map((reason) => reason.replace(/\.$/, "")).join("; and ");
}

/** Makes a change, and answers with what puts back what it made, and the
    settings the core refused to save, each with its reason; those the
    window has gone back on. A stylesheet or workflows the core refuses are
    the change's reason for not being made, and nothing else is touched. */
async function take(next: Next): Promise<{ undo: () => void; notSaved: Map<string, string> }> {
  const sheet = userStyles.css;
  if (next.css !== undefined) await core().stylesSet(next.css);
  let workflowsBack: (() => void) | null = null;
  if (next.workflows !== undefined) {
    try {
      workflowsBack = await takeWorkflowChange(next.workflows);
    } catch (error) {
      if (next.css !== undefined) void core().stylesSet(sheet).catch(() => {});
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The user allowed the change, but it could not be made: ${reason.replace(/\.$/, "")}. Nothing changed.`,
      );
    }
  }
  const before = {
    appearance: theme.choice,
    look: theme.look,
    palette: theme.palette,
    terminalFont: theme.mono,
    interfaceFont: theme.sans,
    keys: { ...keys.bindings },
    themes: { ...theme.themes },
    userStyles: userStyles.on,
  };
  const answered = noteSent();
  if (next.appearance !== undefined) setTheme(next.appearance);
  if (next.look !== undefined) setLook(next.look);
  if (next.themes !== undefined) setThemes(next.themes, next.palette);
  else if (next.palette !== undefined) setPalette(next.palette);
  if (next.terminalFont !== undefined) setMono(next.terminalFont);
  if (next.interfaceFont !== undefined) setSans(next.interfaceFont);
  if (next.keys !== undefined) setBindings(next.keys);
  if (next.userStyles !== undefined) setUserStyles(next.userStyles);
  // The settings are changed in the window first and sent after. The agent
  // is told what the core did with each, not what the window shows.
  const notSaved = new Map<string, string>();
  for (const { fields, reason } of await answered()) {
    if (reason !== null) for (const field of fields) notSaved.set(field, reason);
  }
  const made = (field: string) => !notSaved.has(field);
  const undo = () => {
    if (next.css !== undefined) void core().stylesSet(sheet).catch(() => {});
    if (next.userStyles !== undefined && made("userStyles")) setUserStyles(before.userStyles);
    if (next.appearance !== undefined && made("appearance")) setTheme(before.appearance);
    if (next.look !== undefined && made("look")) setLook(before.look);
    if (next.themes !== undefined) {
      if (made("themes")) setThemes(before.themes, before.palette);
    } else if (next.palette !== undefined && made("palette")) setPalette(before.palette);
    if (next.terminalFont !== undefined && made("terminalFont")) setMono(before.terminalFont);
    if (next.interfaceFont !== undefined && made("interfaceFont")) setSans(before.interfaceFont);
    if (next.keys !== undefined && made("keys")) setBindings(before.keys);
    workflowsBack?.();
  };
  return { undo, notSaved };
}

function answerAsk(choice: Choice) {
  const settle = pending;
  settingsAsk.asking = null;
  pending = null;
  settle?.(choice);
}

/** The user allowed the change in front of them. */
export function allowChange() {
  answerAsk("allow");
}

/** The user declined the change in front of them. */
export function declineChange() {
  answerAsk("decline");
}

function offerUndo(undo: Undo, back: () => void) {
  if (undoTimer !== null) clearTimeout(undoTimer);
  settingsAsk.undo = undo;
  restore = back;
  undoTimer = setTimeout(dismissUndo, UNDO_FOR);
}

/** Puts back the settings the last change moved. */
export function undoChange() {
  const back = restore;
  dismissUndo();
  back?.();
}

export function dismissUndo() {
  if (undoTimer !== null) clearTimeout(undoTimer);
  undoTimer = null;
  settingsAsk.undo = null;
  restore = null;
}

/** Test seam. */
export function resetSettingsTools() {
  seen.clear();
  line = Promise.resolve();
  pending = null;
  settingsAsk.asking = null;
  dismissUndo();
}
