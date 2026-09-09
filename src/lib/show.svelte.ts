/**
 * A place in a file, shown in the viewer: what the agent asked for through
 * its show tool, or a reference in its output the user clicked.
 *
 * The request names the file absolutely and where the agent runs. The
 * project is the open one under which either lies, brought forward if it
 * is not the one on screen; the file is then opened relative to what the
 * changes pane watches for it, the project or the worktree a session moved
 * into.
 */

import type {
  DiffRequest,
  NotifyRequest,
  ShowRequest,
  TerminalRequest,
} from "$lib/core";
import { showDiff, showRange } from "$lib/files.svelte";
import { focusPane, terminalVisible, toggleTerminal } from "$lib/layout.svelte";
import { byKey, forProject, noted, sessions } from "$lib/sessions.svelte";
import { create as createShell } from "$lib/terminals.svelte";
import { activate, watchRoot, workspace } from "$lib/workspace.svelte";

/** Whether `path` is `root` or under it. */
export function within(path: string, root: string): boolean {
  if (path === root) return true;
  const base = root.replace(/[\\/]+$/, "");
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

/** `path` relative to `root`, or null when it is not under it. */
export function relativeTo(path: string, root: string): string | null {
  if (!within(path, root)) return null;
  const base = root.replace(/[\\/]+$/, "");
  return path.slice(base.length + 1).replace(/\\/g, "/");
}

/** The open project a request is for: the deepest one either the agent's
    directory or the file is under. Null when it is for no open project. */
export function projectFor(request: ShowRequest): string | null {
  const candidates = workspace.open
    .map((project) => project.path)
    .filter((path) => within(request.cwd, path) || within(request.path, path))
    .sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

/** Shows the place, or does nothing for a file outside every open project. */
export async function showRequested(request: ShowRequest) {
  const project = projectFor(request);
  if (project === null) return;
  if (workspace.active !== project) activate(project);
  const root = watchRoot() ?? project;
  const relative =
    relativeTo(request.path, root) ?? relativeTo(request.path, project);
  if (relative === null) return;
  await showRange(relative, request.from, request.to, request.note);
}

/** Opens the file's diff, or does nothing for a file outside every open
    project. */
export async function diffRequested(request: DiffRequest) {
  const project = projectFor({ ...request, from: 1, to: 1 });
  if (project === null) return;
  if (workspace.active !== project) activate(project);
  const root = watchRoot() ?? project;
  const relative =
    relativeTo(request.path, root) ?? relativeTo(request.path, project);
  if (relative === null) return;
  await showDiff(relative, request.note);
}

/** The open project a request with only a directory is for. */
function projectOf(cwd: string): string | null {
  return projectFor({
    path: cwd,
    from: 1,
    to: 1,
    note: null,
    cwd,
    session: null,
  });
}

/** Opens a terminal in the project with the command typed at the prompt,
    from the directory the agent runs in when that is not the project. */
export function terminalRequested(request: TerminalRequest) {
  const project = projectOf(request.cwd);
  if (project === null) return;
  if (workspace.active !== project) activate(project);
  const inside = relativeTo(request.cwd, project);
  const command =
    inside === null || inside === ""
      ? request.command
      : `cd '${inside.replace(/'/g, "'\\''")}' && ${request.command}`;
  createShell(project, command);
  if (!terminalVisible()) toggleTerminal();
  else focusPane("terminal");
}

/** The session a request is from: the one it names, else the one running
    deepest where the agent runs, else the project's active one. */
function sessionFor(
  request: { cwd: string; session: string | null },
  project: string,
) {
  const own = forProject(project);
  const named = own.find(
    (session) => session.id !== null && session.id === request.session,
  );
  if (named !== undefined) return named;
  const at = (session: {
    cwd: string | null;
    startIn: string | null;
    project: string;
  }) => session.cwd ?? session.startIn ?? session.project;
  const under = own
    .filter((session) => within(request.cwd, at(session)))
    .sort((a, b) => at(b).length - at(a).length);
  if (under.length > 0) return under[0];
  return own.find((session) => session.key === sessions.active) ?? null;
}

/** Leaves the agent's line on its session's row. */
export function notified(request: NotifyRequest) {
  const project = projectOf(request.cwd);
  if (project === null) return;
  const session = sessionFor(request, project);
  if (session === null) return;
  noted(session.key, request.text);
}

/** A reference in a session's output was clicked: a path the agent wrote,
    taken against where the agent runs. */
export function referenced(key: string, path: string, line: number) {
  const session = byKey(key);
  if (session === null) return;
  const base = session.cwd ?? session.startIn ?? session.project;
  const absolute = /^(?:[A-Za-z]:[\\/]|[\\/]|ssh:\/\/)/.test(path)
    ? path
    : path.startsWith("~/")
      ? path
      : `${base.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`;
  void showRequested({
    path: absolute,
    from: line,
    to: line,
    note: null,
    cwd: base,
    session: session.id,
  });
}
