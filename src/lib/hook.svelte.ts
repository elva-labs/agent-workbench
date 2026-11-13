import { dirsOf } from "$lib/accounts.svelte";
import { core, type Settings } from "$lib/core";
import { persist } from "$lib/persist";
import { hostOf } from "$lib/remote.svelte";

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
 * keeps what it had, off, until asked. The core keeps the answer for the
 * machine; the window keeps a copy, read before the core answers.
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
  /** True until the projects on this machine are in and asked about
      together. */
  starting: true,
});

let loaded = false;
/** Projects brought to the answer since the window opened. */
const applied = new Set<string>();
/** Projects inside a batch that has not finished applying them: they read
    the answer as it stands when the batch gets to them. */
const batching = new Set<string>();
/** Projects on other machines still on their way, by host: they are asked
    about together with the rest of their machine once all have arrived or
    been given up, and ask for nothing themselves meanwhile. */
const waiting = new Map<string, Set<string>>();

function isWaiting(project: string): boolean {
  const host = hostOf(project);
  return host !== null && waiting.get(host)?.has(project) === true;
}

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

function remember() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        everywhere: hook.everywhere,
        overrides: hook.overrides,
      }),
    );
  } catch {
    // Non-fatal: the next start uses the default until the core answers.
  }
}

function save() {
  remember();
  persist({ hooks: hooksSettings() });
}

/** The hooks' part of the settings. */
export function hooksSettings(): Settings["hooks"] {
  if (!loaded) loadHooks();
  return { everywhere: hook.everywhere, overrides: { ...hook.overrides } };
}

/** Takes the answer the core has for the machine, and brings the projects
    given to it when it differs from what the window had. Only projects
    already brought to the answer are applied; one still held back for its
    machine's batch, or inside a batch, reads the new answer when that
    batch applies it. Nothing is sent back, since this is the core's word. */
export function adoptHooks(settings: Settings["hooks"], projects: string[]) {
  if (!loaded) loadHooks();
  const overrides: Record<string, boolean> = {};
  for (const [path, value] of Object.entries(settings.overrides ?? {})) {
    if (typeof value === "boolean") overrides[path] = value;
  }
  const everywhere = settings.everywhere === true;
  const same =
    everywhere === hook.everywhere &&
    JSON.stringify(sorted(overrides)) === JSON.stringify(sorted(hook.overrides));
  if (same) return;
  hook.everywhere = everywhere;
  hook.overrides = overrides;
  remember();
  for (const project of projects) {
    if (applied.has(project) && !batching.has(project)) void apply(project);
  }
}

function sorted(record: Record<string, boolean>): [string, boolean][] {
  return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
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
    hook.installed[project] = (
      await core().hookStatus(project, dirsOf())
    ).installed;
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
      ? await core().hookInstall(project, dirsOf())
      : await core().hookUninstall(project, dirsOf());
    hook.installed[project] = status.installed;
  } catch (error) {
    hook.error = String(error);
  } finally {
    hook.busy = false;
  }
}

/** The accounts changed: the server the hooks point the agents at lives
    in every account's state, so each project is read again and brought
    to the answer. */
export async function reapply(projects: string[]) {
  for (const project of projects) {
    delete hook.installed[project];
    await apply(project);
  }
}

/** Called for every open project: each is brought to the answer once per
    run, when it is first seen, asking for itself. Nothing is asked while
    the window is still starting, nor for a project on its way from another
    machine; `startChecks` asks for those together. */
export function ensure(project: string) {
  if (hook.starting || applied.has(project) || isWaiting(project)) return;
  applied.add(project);
  void apply(project);
}

/** The projects on this machine are in: they are asked about in one
    request, and so are the projects of each other machine, local projects
    never waiting on a remote one. `open` lists the paths of the projects
    open now. `arriving` names the projects on other machines still on their
    way, each with a promise that settles once it is open or given up; the
    projects of such a machine are asked about in one request once all of
    its arrivals have settled. Each project is then brought to the answer.
    Projects opened from here on ask for themselves. */
export function startChecks(
  open: () => string[],
  arriving: ReadonlyMap<string, Promise<void>> = new Map(),
) {
  const late = new Map<string, Promise<unknown>[]>();
  for (const [project, arrived] of arriving) {
    const host = hostOf(project);
    if (host === null || applied.has(project)) continue;
    if (!waiting.has(host)) waiting.set(host, new Set());
    waiting.get(host)!.add(project);
    late.set(host, [...(late.get(host) ?? []), arrived]);
  }

  const groups = new Map<string | null, string[]>();
  for (const project of open()) {
    const host = hostOf(project);
    if (applied.has(project) || (host !== null && late.has(host))) continue;
    applied.add(project);
    groups.set(host, [...(groups.get(host) ?? []), project]);
  }
  hook.starting = false;
  for (const group of groups.values()) void applyMany(group);

  for (const [host, arrivals] of late) {
    void Promise.allSettled(arrivals).then(() => {
      waiting.delete(host);
      const group = open().filter(
        (project) => hostOf(project) === host && !applied.has(project),
      );
      for (const project of group) applied.add(project);
      if (group.length > 0) void applyMany(group);
    });
  }
}

/** What is on disk for the projects of one machine, from one request, and
    then each brought to the answer in turn. */
async function applyMany(projects: string[]) {
  for (const project of projects) batching.add(project);
  try {
    const answers = await core().hookStatusMany(projects, dirsOf());
    projects.forEach((project, at) => {
      hook.installed[project] = answers[at]?.installed === true;
    });
  } catch {
    // Not knowing is not an error worth showing, as with one project.
    for (const project of projects) hook.installed[project] = false;
  }
  for (const project of projects) {
    await apply(project);
    batching.delete(project);
  }
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
  batching.clear();
  waiting.clear();
  hook.starting = false;
  hook.everywhere = false;
  hook.overrides = {};
  hook.installed = {};
  hook.busy = false;
  hook.error = null;
}
