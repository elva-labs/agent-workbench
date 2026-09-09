/**
 * Media the agent presented: images and PDFs, kept per session and opened
 * in a modal, the first file on screen and the rest as previews to click
 * through.
 *
 * The agent's request names files and where the agent runs; the session on
 * that directory, in the project it is under, is the one the files belong
 * to, or the project itself when no session is. The list names files on
 * disk rather than keeping copies, so a file the agent later removes shows
 * as gone rather than stale, and it survives a restart the way session
 * names do.
 */

import { marked } from "marked";
import { core, type Media, type PresentRequest } from "$lib/core";
import { forProject, sessions } from "$lib/sessions.svelte";
import { projectFor, within } from "$lib/show.svelte";
import { activate, workspace } from "$lib/workspace.svelte";

export interface MediaItem {
  id: string;
  /** The session's key, or `project:<path>` when no session was found. */
  owner: string;
  project: string;
  files: string[];
  caption: string | null;
  /** Seconds since the epoch. */
  at: number;
}

const KEY = "workbench.media";
/** Kept per owner: enough to find a screenshot from earlier, not a store. */
const KEEP = 50;

export const media = $state({
  items: [] as MediaItem[],
  /** What the modal shows: an item and which of its files. */
  open: null as { item: MediaItem; index: number } | null,
});

let loaded = false;

export function loadMedia() {
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    media.items = Array.isArray(parsed)
      ? parsed.filter(
          (item): item is MediaItem =>
            item !== null &&
            typeof item === "object" &&
            typeof (item as MediaItem).id === "string" &&
            Array.isArray((item as MediaItem).files),
        )
      : [];
  } catch {
    media.items = [];
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(media.items));
  } catch {
    // Non-fatal: the list does not survive a restart.
  }
}

/** The session the request is for: the one running deepest in the
    directory the agent runs in, in the project the request is under; then
    the active session there; then the project itself. */
export function ownerFor(request: PresentRequest, project: string): string {
  const own = forProject(project);
  const at = (session: {
    cwd: string | null;
    startIn: string | null;
    project: string;
  }) => session.cwd ?? session.startIn ?? session.project;
  const under = own
    .filter((session) => within(request.cwd, at(session)))
    .sort((a, b) => at(b).length - at(a).length);
  if (under.length > 0) return under[0].key;
  if (
    sessions.active !== null &&
    own.some((session) => session.key === sessions.active)
  ) {
    return sessions.active;
  }
  return `project:${project}`;
}

/** The items for a session, newest first, and the project's own when it
    is asked for. */
export function itemsFor(owner: string): MediaItem[] {
  return media.items.filter((item) => item.owner === owner).reverse();
}

/** What the changes pane lists: the active session's, or with none the
    project's own. */
export function listed(): MediaItem[] {
  const project = workspace.active;
  if (project === null) return [];
  const active = sessions.active;
  if (
    active !== null &&
    forProject(project).some((session) => session.key === active)
  ) {
    return itemsFor(active);
  }
  return itemsFor(`project:${project}`);
}

/** The agent presented files: kept on the session, and opened. */
export function presented(request: PresentRequest, now = Date.now()) {
  if (!loaded) loadMedia();
  const project = projectFor({
    ...request,
    path: request.files[0] ?? request.cwd,
    from: 1,
    to: 1,
    note: null,
  });
  if (project === null) return;
  if (workspace.active !== project) activate(project);
  const item: MediaItem = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    owner: ownerFor(request, project),
    project,
    files: request.files,
    caption: request.caption,
    at: Math.floor(now / 1000),
  };
  media.items.push(item);
  const mine = media.items.filter(
    (candidate) => candidate.owner === item.owner,
  );
  if (mine.length > KEEP) {
    const drop = new Set(
      mine.slice(0, mine.length - KEEP).map((candidate) => candidate.id),
    );
    media.items = media.items.filter((candidate) => !drop.has(candidate.id));
  }
  save();
  media.open = { item, index: 0 };
}

export function openItem(item: MediaItem, index = 0) {
  media.open = {
    item,
    index: Math.max(0, Math.min(index, item.files.length - 1)),
  };
}

export function closeMedia() {
  media.open = null;
}

/** The next or previous file of what is open, stopping at the ends. */
export function step(direction: 1 | -1) {
  if (media.open === null) return;
  const index = media.open.index + direction;
  if (index < 0 || index >= media.open.item.files.length) return;
  media.open = { item: media.open.item, index };
}

/** What the modal shows for a file: an image or a PDF as a data URL, a
    Markdown document rendered to HTML, or the reason it cannot be shown. */
export type Loaded =
  | { mime: string; url: string }
  | { mime: string; html: string }
  | { error: string };

/** Markdown rendered for the modal. Raw HTML in the document is shown as
    the text it is, since the document is the agent's and the window is
    the app's. */
export function render(markdown: string): string {
  const escaped = markdown.replace(/</g, "&lt;");
  return marked.parse(escaped, { async: false, gfm: true }) as string;
}

function decode(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function load(path: string): Promise<Loaded> {
  try {
    const found: Media = await core().readMedia(path);
    if (found.mime === "text/markdown") {
      return { mime: found.mime, html: render(decode(found.data)) };
    }
    return { mime: found.mime, url: `data:${found.mime};base64,${found.data}` };
  } catch (error) {
    return { error: String(error) };
  }
}

/** Test seam. */
export function resetMedia() {
  loaded = true;
  media.items = [];
  media.open = null;
}
