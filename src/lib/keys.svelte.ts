import { isMac } from "$lib/platform";

/**
 * The chords the app claims, and who decides them.
 *
 * Every chord carries the platform modifier, Cmd on macOS and Ctrl elsewhere:
 * unmodified keys belong to whatever terminal has focus, and that is not
 * negotiable here. Within that rule the user picks: a preset, or a chord of
 * their own per action. The stored shape is the whole table, so a custom
 * arrangement survives a change to the presets.
 */

export type ActionKey =
  | "focus.sessions"
  | "focus.agent"
  | "focus.changes"
  | "focus.terminal"
  | "toggle.sessions"
  | "toggle.changes"
  | "toggle.terminal"
  | "session.next"
  | "session.previous"
  | "review"
  | "view"
  | "scope"
  | "find"
  | "findLines"
  | "theme"
  | "settings";

/** A key with the platform modifier, and whether Shift and Alt join it. */
export interface Chord {
  /** As `KeyboardEvent.key` spells it, letters in lower case. */
  key: string;
  shift: boolean;
  alt: boolean;
}

export type PresetName = "default" | "vim";
export type Keymap = Record<ActionKey, Chord>;

export interface ActionInfo {
  key: ActionKey;
  label: string;
  group: string;
}

/** Every action, in the order the settings show them. */
export const ACTIONS: ActionInfo[] = [
  { key: "focus.sessions", label: "Focus sessions", group: "Panes" },
  { key: "focus.agent", label: "Focus agent", group: "Panes" },
  { key: "focus.changes", label: "Focus changes", group: "Panes" },
  { key: "focus.terminal", label: "Focus terminal", group: "Panes" },
  { key: "toggle.sessions", label: "Show or hide sessions", group: "Panes" },
  { key: "toggle.changes", label: "Show or hide changes", group: "Panes" },
  { key: "toggle.terminal", label: "Show or hide the terminal", group: "Panes" },
  { key: "session.next", label: "Next session or shell", group: "Sessions" },
  { key: "session.previous", label: "Previous session or shell", group: "Sessions" },
  { key: "review", label: "Open or close the file viewer", group: "Changes" },
  { key: "view", label: "Diff or whole file", group: "Changes" },
  { key: "scope", label: "Changed files or all files", group: "Changes" },
  { key: "find", label: "Filter files (in the changes pane)", group: "Changes" },
  { key: "findLines", label: "Search in files", group: "Changes" },
  { key: "theme", label: "Cycle the theme", group: "App" },
  { key: "settings", label: "Open settings", group: "App" },
];

const plain = (key: string): Chord => ({ key, shift: false, alt: false });
const shifted = (key: string): Chord => ({ key, shift: true, alt: false });

export const PRESETS: Record<PresetName, Keymap> = {
  default: {
    "focus.sessions": plain("1"),
    "focus.agent": plain("2"),
    "focus.changes": plain("3"),
    "focus.terminal": plain("4"),
    "toggle.sessions": plain("b"),
    "toggle.changes": plain("\\"),
    "toggle.terminal": plain("j"),
    "session.next": shifted("ArrowDown"),
    "session.previous": shifted("ArrowUp"),
    review: plain("d"),
    view: plain("e"),
    scope: shifted("a"),
    find: plain("f"),
    findLines: shifted("f"),
    theme: shifted("t"),
    settings: plain(","),
  },
  // Movement between panes on h, j, k and l, as the panes lie: sessions to
  // the left, changes to the right, the terminal below, the agent above it.
  vim: {
    "focus.sessions": plain("h"),
    "focus.agent": plain("k"),
    "focus.changes": plain("l"),
    "focus.terminal": plain("j"),
    "toggle.sessions": plain("b"),
    "toggle.changes": plain("\\"),
    "toggle.terminal": shifted("j"),
    "session.next": shifted("n"),
    "session.previous": shifted("p"),
    review: plain("d"),
    view: plain("e"),
    scope: shifted("a"),
    find: plain("f"),
    findLines: shifted("f"),
    theme: shifted("t"),
    settings: plain(","),
  },
};

export const PRESET_LABELS: Record<PresetName, string> = { default: "Default", vim: "Vim" };

const KEY = "workbench.keys";

export const keys = $state({
  /** The preset the table matches, or custom once a chord differs. */
  preset: "default" as PresetName | "custom",
  bindings: { ...PRESETS.default } as Keymap,
});

/** Keys the app must never take from the agent, even with the modifier: on
    Windows and Linux the modifier is Ctrl, and these are the agent's. */
const RESERVED = new Set(["c", "r"]);

export function chordFor(action: ActionKey): Chord {
  return keys.bindings[action];
}

export function sameChord(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.shift === b.shift && a.alt === b.alt;
}

/** The action a chord is bound to, if any. */
export function actionOf(chord: Chord): ActionKey | null {
  for (const action of ACTIONS) {
    if (sameChord(keys.bindings[action.key], chord)) return action.key;
  }
  return null;
}

/** Which preset a table is, or custom. */
export function presetOf(bindings: Keymap): PresetName | "custom" {
  for (const name of Object.keys(PRESETS) as PresetName[]) {
    if (ACTIONS.every(({ key }) => sameChord(PRESETS[name][key], bindings[key]))) return name;
  }
  return "custom";
}

export function applyPreset(name: PresetName) {
  keys.bindings = { ...PRESETS[name] };
  keys.preset = name;
  save();
}

/**
 * Binds an action to a chord. The reason it could not, when it could not:
 * a chord another action holds, or one the agent needs. The other action is
 * not silently unbound, since the user did not ask for that.
 */
export function setBinding(action: ActionKey, chord: Chord): string | null {
  if (!chord.shift && RESERVED.has(chord.key)) {
    return `${describe(chord)} stays with the agent: it interrupts, or searches history, there.`;
  }
  const holder = actionOf(chord);
  if (holder !== null && holder !== action) {
    return `${describe(chord)} is already ${labelOf(holder)}. Change that one first.`;
  }
  keys.bindings[action] = chord;
  keys.preset = presetOf(keys.bindings);
  save();
  return null;
}

/** Back to what the default preset has for this action, if that chord is
    free, else the binding stays as it is. */
export function resetBinding(action: ActionKey): string | null {
  return setBinding(action, PRESETS.default[action]);
}

export function labelOf(action: ActionKey): string {
  return ACTIONS.find((info) => info.key === action)?.label ?? action;
}

/** The chord a key event spells, or null when the modifier is not down. */
export function chordFromEvent(
  e: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean },
  mac: boolean = isMac(),
): Chord | null {
  const mod = Boolean(mac ? e.metaKey : e.ctrlKey);
  if (!mod) return null;
  if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return null;
  return { key: normalise(e.key), shift: Boolean(e.shiftKey), alt: Boolean(e.altKey) };
}

/** Letters in lower case, so Shift does not spell a second chord. */
function normalise(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

const MAC_KEYS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
};

const OTHER_KEYS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  " ": "Space",
};

/** A chord as the status bar and the settings spell it, in the platform's
    own glyphs: `⌘⇧↓` or `Ctrl+Shift+Down`. */
export function describe(chord: Chord, mac: boolean = isMac()): string {
  if (mac) {
    const key = MAC_KEYS[chord.key] ?? chord.key.toUpperCase();
    return `⌘${chord.shift ? "⇧" : ""}${chord.alt ? "⌥" : ""}${key}`;
  }
  const key = OTHER_KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return `Ctrl+${chord.shift ? "Shift+" : ""}${chord.alt ? "Alt+" : ""}${key}`;
}

export function loadKeys() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  try {
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return;
    const bindings = { ...PRESETS.default };
    const table = (stored as { bindings?: unknown }).bindings;
    if (typeof table === "object" && table !== null) {
      for (const { key } of ACTIONS) {
        const chord = (table as Record<string, unknown>)[key];
        if (isChord(chord)) bindings[key] = { key: chord.key, shift: chord.shift, alt: chord.alt };
      }
    }
    keys.bindings = bindings;
    keys.preset = presetOf(bindings);
  } catch {
    // A corrupt entry is not worth a broken keyboard. The default stands.
  }
}

function isChord(value: unknown): value is Chord {
  if (typeof value !== "object" || value === null) return false;
  const chord = value as Record<string, unknown>;
  return (
    typeof chord.key === "string" &&
    chord.key !== "" &&
    typeof chord.shift === "boolean" &&
    typeof chord.alt === "boolean"
  );
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ bindings: keys.bindings }));
  } catch {
    // Non-fatal: the arrangement does not survive a restart.
  }
}

/** Test seam. */
export function resetKeys() {
  keys.bindings = { ...PRESETS.default };
  keys.preset = "default";
}
