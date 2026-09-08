import { core } from "$lib/core";

/**
 * The agents' hooks: one answer for every project, and a word for the rare
 * project that wants otherwise.
 *
 * The hooks write into a project's own agent configuration, in files kept
 * out of its repository, and what they buy is the same in every project:
 * the changes pane hears from the agent the moment a tool finishes, and a
 * session's row follows the agent's own word for working, waiting and asking.
 * So the choice is made once and every project opened from then on follows
 * it. A fresh install starts with them on; a setup that predates the choice
 * keeps what it had, off, until asked.
 */

const KEY = "workbench.hooks";
/** Present once anything has been saved: the mark of a setup from before. */
const WORKSPACE_KEY = "workbench.workspace";

export const hook = $state({
  /** The answer for every project without a word of its own. */
  everywhere: true,
  /** The projects with a word of their own: on or off, whatever the rest. */
  overrides: {} as Record<string, boolean>,
  /** What is on disk, by project path, once asked. */
  installed: {} as Record<string, boolean>,
  busy: false,
  error: null as string | null,
});

let loaded = false;
/** Projects brought to the answer since the window opened. */
const applied = new Set<string>();

export function loadHooks() {
  loaded = true;
  let raw: string | null = null;
  let fresh = true;
  try {
    raw = localStorage.getItem(KEY);
    fresh = localStorage.getItem(WORKSPACE_KEY) === null;
  } catch {
    // No storage: the defaults stand for this run.
  }
  if (raw === null) {
    hook.everywhere = fresh;
    hook.overrides = {};
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const record =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    hook.everywhere = record.everywhere === true;
    const overrides: Record<string, boolean> = {};
    if (record.overrides !== null && typeof record.overrides === "object") {
      for (const [path, value] of Object.entries(
        record.overrides as Record<string, unknown>,
      )) {
        if (typeof value === "boolean") overrides[path] = value;
      }
    }
    hook.overrides = overrides;
  } catch {
    hook.everywhere = false;
    hook.overrides = {};
  }
}

function save() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        everywhere: hook.everywhere,
        overrides: hook.overrides,
      }),
    );
  } catch {
    // Non-fatal: the choice does not survive a restart.
  }
}

/** The project's own word, or null when it follows the rest. */
export function overrideOf(project: string): boolean | null {
  if (!loaded) loadHooks();
  return hook.overrides[project] ?? null;
}

/** Whether the project should have the hooks. */
export function wanted(project: string): boolean {
  if (!loaded) loadHooks();
  return hook.overrides[project] ?? hook.everywhere;
}

export function isInstalled(project: string | null): boolean {
  return project !== null && hook.installed[project] === true;
}

export function isKnown(project: string | null): boolean {
  return project !== null && hook.installed[project] !== undefined;
}

export async function check(project: string) {
  try {
    hook.installed[project] = (await core().hookStatus(project)).installed;
  } catch {
    // Not knowing is not an error worth showing: the watcher works regardless.
    hook.installed[project] = false;
  }
}

/** Brings a project to the answer: installs or removes as wanted, and does
    nothing to one already there. */
export async function apply(project: string) {
  hook.busy = true;
  hook.error = null;
  try {
    if (!isKnown(project)) await check(project);
    const want = wanted(project);
    if (want === isInstalled(project)) return;
    const status = want
      ? await core().hookInstall(project)
      : await core().hookUninstall(project);
    hook.installed[project] = status.installed;
  } catch (error) {
    hook.error = String(error);
  } finally {
    hook.busy = false;
  }
}

/** Called for every open project: each is brought to the answer once per
    run, when it is first seen. */
export function ensure(project: string) {
  if (applied.has(project)) return;
  applied.add(project);
  void apply(project);
}

/** The answer for every project, applied to the ones open now. */
export async function setEverywhere(on: boolean, projects: string[]) {
  if (!loaded) loadHooks();
  hook.everywhere = on;
  save();
  for (const project of projects) await apply(project);
}

/** A project's own word, or null to have it follow the rest again. */
export async function setOverride(project: string, value: boolean | null) {
  if (!loaded) loadHooks();
  if (value === null) delete hook.overrides[project];
  else hook.overrides[project] = value;
  save();
  await apply(project);
}

/** Test seam. */
export function reset() {
  loaded = true;
  applied.clear();
  hook.everywhere = false;
  hook.overrides = {};
  hook.installed = {};
  hook.busy = false;
  hook.error = null;
}
