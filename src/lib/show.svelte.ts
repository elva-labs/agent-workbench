/**
 * A place in a file, shown in the viewer: what the agent asked for through
 * its show tool, or a reference in its output the user clicked.
 *
 * The request names the file absolutely and where the agent runs. The
 * project is the open one under which either lies, brought forward if it
 * is not the one on screen; the file is then opened relative to what the
 * changes pane watches for it, the project or the worktree a session moved
 * into.
 *
 * In editor mode the place opens in the editor instead: the file as a tab at
 * its line, a diff as that tab's Diff view.
 *
 * What an agent asks to open is for its own session's viewer. While the
 * user is looking at another session, the call is held on the agent's
 * session rather than opened over what the user is reading, and opens
 * when they switch to it. One viewer holds one thing, so only the latest
 * call is kept. A call from the session on screen, or from no session the
 * window knows, opens at once.
 */

import type {
  DiffRequest,
  NotifyRequest,
  ShowRequest,
  TerminalRequest,
} from "$lib/core";
import { openFile } from "$lib/editor.svelte";
import { showDiff, showRange } from "$lib/files.svelte";
import { focusPane, layout, terminalVisible, toggleTerminal } from "$lib/layout.svelte";
import { byKey, isLive, noted, runningByToken, sessions, type Session } from "$lib/sessions.svelte";
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

/** Shows the place now, or does nothing for a file outside every open
    project: for a place the user asked for by clicking. */
export async function showPlace(request: ShowRequest) {
  const project = projectFor(request);
  if (project === null) return;
  await openPlace(request, project);
}

/** The agent asked to show the place: now when its session is on screen,
    else when the user switches to it. */
export async function showRequested(request: ShowRequest) {
  const project = projectFor(request);
  if (project === null) return;
  if (held(request, () => openPlace(request, project))) return;
  await openPlace(request, project);
}

async function openPlace(request: ShowRequest, project: string) {
  if (workspace.active !== project) activate(project);
  const root = watchRoot() ?? project;
  const relative =
    relativeTo(request.path, root) ?? relativeTo(request.path, project);
  if (relative === null) return;
  if (layout.mode === "editing") {
    await openFile(relative, { line: request.from, to: request.to, note: request.note });
    return;
  }
  await showRange(relative, request.from, request.to, request.note);
}

/** The agent asked to open the file's diff: the same way, or not at all
    for a file outside every open project. */
export async function diffRequested(request: DiffRequest) {
  const project = projectFor({ ...request, from: 1, to: 1 });
  if (project === null) return;
  const open = async () => {
    if (workspace.active !== project) activate(project);
    const root = watchRoot() ?? project;
    const relative =
      relativeTo(request.path, root) ?? relativeTo(request.path, project);
    if (relative === null) return;
    if (layout.mode === "editing") {
      await openFile(relative, { view: "diff", note: request.note });
      return;
    }
    await showDiff(relative, request.note);
  };
  if (held(request, open)) return;
  await open();
}

/** The open project a request with only a directory is for. */
export function projectOf(cwd: string): string | null {
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
  const open = () => {
    if (workspace.active !== project) activate(project);
    const inside = relativeTo(request.cwd, project);
    const command =
      inside === null || inside === ""
        ? request.command
        : `cd '${inside.replace(/'/g, "'\\''")}' && ${request.command}`;
    createShell(project, command);
    if (!terminalVisible()) toggleTerminal();
    else focusPane("terminal");
  };
  if (held(request, open)) return;
  open();
}

/** The session a request is from: the running row whose token it names, in
    whichever project, or the running row whose id a plugin names. A
    request that names no session, or one no running row answers to, is
    from none of the workbench's: each session it starts names itself in
    every call, so an agent started outside it in the project's directory,
    with the same tools, is not one of its rows, nor is a call naming a
    token the window never gave out, nor one left over from a session that
    has stopped. */
export function sessionFor(request: { session: string | null }): Session | null {
  if (request.session === null) return null;
  return (
    runningByToken(request.session) ??
    sessions.all.find((session) => session.id === request.session && isLive(session)) ??
    null
  );
}

/** What each session's agent asked to open while the user was looking at
    another session, by session key: the latest call, to open on switching. */
const heldOpens = new Map<string, () => void | Promise<void>>();

/** The request's session when it is one the window knows and the user is
    looking at another: what it asks to open waits. Null when the request is
    from the session on screen, or from no session the window knows. */
export function elsewhere(request: { session: string | null }) {
  const session = sessionFor(request);
  if (session === null || session.key === sessions.active) return null;
  return session;
}

/** Holds `open` on the request's session when that session is not the one
    on screen, to run when the user switches to it, and says so. False when
    the request is from the session on screen, or from no session the window
    knows: the caller opens it now. */
export function held(
  request: { session: string | null },
  open: () => void | Promise<void>,
): boolean {
  const session = elsewhere(request);
  if (session === null) return false;
  heldOpens.set(session.key, open);
  return true;
}

/** The user switched to a session: what its agent asked to open while
    they were elsewhere opens now. */
export function switched(key: string) {
  for (const stale of heldOpens.keys()) {
    if (byKey(stale) === null) heldOpens.delete(stale);
  }
  const open = heldOpens.get(key);
  if (open === undefined) return;
  heldOpens.delete(key);
  void open();
}

/** Forgets what was held, for tests. */
export function resetHeld() {
  heldOpens.clear();
}

/** Leaves the agent's line on its session's row. */
export function notified(request: NotifyRequest) {
  const project = projectOf(request.cwd);
  if (project === null) return;
  const session = sessionFor(request);
  if (session === null) return;
  noted(session.key, request.text);
}

/** A path as the agent reads it, taken against where it runs. */
function taken(path: string, base: string): string {
  return /^(?:[A-Za-z]:[\\/]|[\\/]|ssh:\/\/)/.test(path)
    ? path
    : path.startsWith("~/")
      ? path
      : `${base.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`;
}

/** A path with its `.` and `..` parts walked, so what it names is what
    is checked, its parts joined by the separator it starts with. */
function resolved(path: string): string {
  const head = /^(?:ssh:\/\/[^/]*|[A-Za-z]:)?/.exec(path)?.[0] ?? "";
  const kept: string[] = [];
  for (const part of path.slice(head.length).split(/[\\/]/)) {
    if (part === "..") kept.pop();
    else if (part !== "." && part !== "") kept.push(part);
  }
  const sep = /[\\/]/.exec(path.slice(head.length))?.[0] ?? "/";
  return `${head}${sep}${kept.join(sep)}`;
}

/** What opens a file a session's message mentions, by the path its agent
    was told: the file's changes in the viewer when it has some, the file
    as it is when not. Null for a folder, or a file outside the session's
    project and worktree, which the viewer does not show. */
export function mentionOpener(key: string, path: string): (() => void) | null {
  const session = byKey(key);
  if (session === null || path.endsWith("/")) return null;
  const base = session.cwd ?? session.startIn ?? session.project;
  const absolute = resolved(taken(path, base));
  const homes = [session.worktree, session.project].filter((home) => home !== null);
  if (!homes.some((home) => within(absolute, home))) return null;
  return () => void diffRequested({ path: absolute, note: null, cwd: base, session: session.token });
}

/** A reference in a session's output was clicked: a path the agent wrote,
    taken against where the agent runs. */
export function referenced(key: string, path: string, line: number) {
  const session = byKey(key);
  if (session === null) return;
  const base = session.cwd ?? session.startIn ?? session.project;
  const absolute = taken(path, base);
  void showPlace({
    path: absolute,
    from: line,
    to: line,
    note: null,
    cwd: base,
    session: session.token,
  });
}
