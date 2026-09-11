/**
 * Plugin sources and their plugins, as the settings list them: what the
 * core has on this machine, each plugin's state as the core tells it, and
 * the actions the settings offer. The core keeps the truth; this keeps a
 * copy for the window and asks again after every change.
 */

import {
  core,
  type PluginInfo,
  type PluginSource,
  type PluginStateEvent,
  type ProjectInfo,
} from "$lib/core";
import { workspace } from "$lib/workspace.svelte";

export const plugins = $state({
  sources: [] as PluginSource[],
  loaded: false,
  busy: false,
  /** What the last action said went wrong, shown until the next. */
  error: null as string | null,
  /** When the sources were last checked for newer commits. */
  checked: 0,
});

/** How often the sources are checked while the app runs. */
export const CHECK_EVERY = 24 * 60 * 60 * 1000;

const TRUSTED_KEY = "workbench.plugins.trusted";

export async function loadPlugins() {
  try {
    plugins.sources = await core().pluginSources();
  } catch (error) {
    plugins.error = String(error);
  }
  plugins.loaded = true;
}

async function act<T>(work: () => Promise<T>): Promise<T | null> {
  plugins.busy = true;
  plugins.error = null;
  try {
    return await work();
  } catch (error) {
    plugins.error = String(error);
    return null;
  } finally {
    plugins.busy = false;
  }
}

/**
 * A source the core answered with, kept beside what the window already
 * knows. What a plugin declares and whether it is on come from the
 * answer; what its process is doing comes from the events, which can
 * arrive before the answer that started it does, so the answer never
 * writes a state over one the events have already moved on.
 */
function put(source: PluginSource) {
  const at = plugins.sources.findIndex((s) => s.id === source.id);
  if (at === -1) {
    plugins.sources.push(source);
    return;
  }
  const known = plugins.sources[at];
  plugins.sources[at] = {
    ...source,
    plugins: source.plugins.map((plugin) => {
      const before = known.plugins.find((p) => p.name === plugin.name);
      return before === undefined
        ? plugin
        : {
            ...plugin,
            state: before.state,
            detail: before.detail,
            hello: before.hello,
          };
    }),
  };
}

/** Adds a repository or a directory. False when it could not be added,
    with the reason in `error`. */
export async function addSource(
  location: string,
  reference: string | null = null,
): Promise<boolean> {
  const added = await act(() => core().pluginAdd(location, reference));
  if (added === null) return false;
  put(added);
  return true;
}

export async function removeSource(id: string) {
  const done = await act(async () => {
    await core().pluginRemove(id);
    return true;
  });
  if (done) plugins.sources = plugins.sources.filter((s) => s.id !== id);
}

export async function checkSource(id: string) {
  const newer = await act(() => core().pluginCheck(id));
  const source = plugins.sources.find((s) => s.id === id);
  if (source !== undefined && newer !== null) source.newer = newer;
  if (source !== undefined && newer === null && plugins.error === null)
    source.newer = null;
}

export async function checkAll() {
  for (const source of plugins.sources) {
    if (source.kind === "git") await checkSource(source.id);
  }
  plugins.checked = Date.now();
}

export async function updateSource(id: string) {
  const updated = await act(() => core().pluginUpdate(id));
  if (updated !== null) put(updated);
}

export async function enablePlugin(id: string, name: string, on: boolean) {
  awaiting(id, name, on);
  const updated = await act(() => core().pluginEnable(id, name, on));
  if (updated !== null) put(updated);
}

/** What a plugin's row says while the core has not spoken yet: a plugin
    just turned on is on its way up, and one turned off is down. */
function awaiting(id: string, name: string, on: boolean) {
  const plugin = plugins.sources
    .find((source) => source.id === id)
    ?.plugins.find((p) => p.name === name);
  if (plugin === undefined) return;
  plugin.state = on ? "starting" : "off";
  plugin.detail = null;
  if (!on) plugin.hello = null;
}

/** A plugin's state changed on the core's side: the row follows. */
export function stateChanged(event: PluginStateEvent) {
  const source = plugins.sources.find((s) => s.id === event.source);
  const plugin = source?.plugins.find((p) => p.name === event.name);
  if (plugin === undefined) return;
  plugin.state = event.state;
  plugin.detail = event.detail;
  plugin.hello = event.hello;
}

/** Whether the question that comes with turning a plugin on has been
    answered for it. Asked once, and remembered by the window. */
export function trusted(id: string, name: string): boolean {
  try {
    const raw = localStorage.getItem(TRUSTED_KEY);
    const list: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(list) && list.includes(`${id}/${name}`);
  } catch {
    return false;
  }
}

export function trust(id: string, name: string) {
  try {
    const raw = localStorage.getItem(TRUSTED_KEY);
    const list: unknown = raw === null ? [] : JSON.parse(raw);
    const kept = Array.isArray(list)
      ? list.filter((x) => typeof x === "string")
      : [];
    if (!kept.includes(`${id}/${name}`)) kept.push(`${id}/${name}`);
    localStorage.setItem(TRUSTED_KEY, JSON.stringify(kept));
  } catch {
    // Non-fatal: the question is asked again after a restart.
  }
}

/** What enabling a plugin means, in a few words: "2 tools, 1 section, a
    wide view, runs node". */
export function summary(plugin: PluginInfo): string {
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) =>
    n === 0 ? null : `${n} ${n === 1 ? one : many}`;
  const tools = count(plugin.tools.length, "tool", "tools");
  const sections = count(plugin.sections.length, "section", "sections");
  if (tools !== null) parts.push(tools);
  if (sections !== null) parts.push(sections);
  if (plugin.view !== null) parts.push(`a ${plugin.view} view`);
  const program = plugin.run[0] ?? "";
  const runtime = program.split(/[\\/]/).pop() ?? program;
  parts.push(`runs ${runtime}`);
  return parts.join(", ");
}

/** The state as the row reads it. */
export function stateLabel(plugin: PluginInfo): string {
  switch (plugin.state) {
    case "running":
      return plugin.hello === null
        ? "running"
        : `running ${plugin.hello.version}`;
    case "starting":
      return "starting";
    case "stopped":
      return plugin.detail === null
        ? "stopped, starting again"
        : `stopped: ${plugin.detail}, starting again`;
    case "failed":
      return plugin.detail === null ? "failed" : `failed: ${plugin.detail}`;
    default:
      return "off";
  }
}

/** The paths of the open projects, as the core is told them. */
export function projectsToSend(open: ProjectInfo[]): string[] {
  return open.map((project) => project.path);
}

/** Tells the core which projects are open whenever the set changes, so the
    plugins on each machine know the projects there. Runs in an effect
    root: call once, from the page. */
export function watchPluginProjects() {
  let sent: string | null = null;
  $effect(() => {
    const paths = projectsToSend(workspace.open);
    const now = paths.join("\n");
    if (now === sent) return;
    sent = now;
    // A machine that could not be told hears the next change.
    void core()
      .pluginProjects(paths)
      .catch(() => {});
  });
}

/** Checks the sources once a day while the app runs. Runs in an effect
    root: call once, from the page. */
export function watchPluginUpdates() {
  $effect(() => {
    const timer = setInterval(() => {
      if (plugins.sources.some((s) => s.kind === "git")) void checkAll();
    }, CHECK_EVERY);
    return () => clearInterval(timer);
  });
}

/** Test seam. */
export function resetPlugins() {
  plugins.sources = [];
  plugins.loaded = false;
  plugins.busy = false;
  plugins.error = null;
  plugins.checked = 0;
}
