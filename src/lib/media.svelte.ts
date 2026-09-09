/**
 * Media the agent presented: images, PDFs and documents, kept per session
 * as one item per call and opened in the changes pane's viewer, every file
 * of the call down the page.
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
import { showMedia } from "$lib/files.svelte";

export interface MediaItem {
  id: string;
  /** The agent's session id, which is the same after a restart, or
      `project:<path>` when no session with an id was found. */
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

/** The session the request is for, by its agent's id: the one the request
    names, when it is running in the project; else the one running deepest
    in the directory the agent runs in; then the active session there; then
    the project itself. A session whose id is not known yet cannot own
    anything, since the id is what the list is kept by. */
export function ownerFor(request: PresentRequest, project: string): string {
  const own = forProject(project).filter((session) => session.id !== null);
  const named = own.find((session) => session.id === request.session);
  if (named !== undefined) return named.id!;
  const at = (session: {
    cwd: string | null;
    startIn: string | null;
    project: string;
  }) => session.cwd ?? session.startIn ?? session.project;
  const under = own
    .filter((session) => within(request.cwd, at(session)))
    .sort((a, b) => at(b).length - at(a).length);
  if (under.length > 0) return under[0].id!;
  const active = own.find((session) => session.key === sessions.active);
  if (active !== undefined) return active.id!;
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
  const active = forProject(project).find(
    (session) => session.key === sessions.active,
  );
  if (active !== undefined && active.id !== null) return itemsFor(active.id);
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
  showMedia(item);
}

/** A call from the list, opened in the viewer again. */
export function openItem(item: MediaItem) {
  showMedia(item);
}

/** What the viewer shows for a file: an image or a PDF as a data URL, a
    Markdown document rendered to HTML, or the reason it cannot be shown. */
export type Loaded =
  | { mime: string; url: string }
  | { mime: string; html: string }
  | { error: string };

/** Where a link or an image in a document may point: the web, mail, or a
    place in the document. Anything else, a `javascript:` link above all,
    is rendered as its text. */
const LINK = /^(?:https?:|mailto:|#)/i;
const IMAGE = /^(?:https?:|data:image\/)/i;

const renderer = new marked.Renderer();
renderer.link = ({ href, title, tokens }) => {
  const text = renderer.parser.parseInline(tokens);
  if (!LINK.test(href)) return text;
  const named = title ? ` title="${escapeAttribute(title)}"` : "";
  return `<a href="${escapeAttribute(href)}"${named} rel="noopener noreferrer">${text}</a>`;
};
renderer.image = ({ href, title, text }) => {
  if (!IMAGE.test(href)) return escapeText(text);
  const named = title ? ` title="${escapeAttribute(title)}"` : "";
  return `<img src="${escapeAttribute(href)}" alt="${escapeAttribute(text)}"${named}>`;
};

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}

/** Markdown rendered for the viewer. Raw HTML in the document is shown as
    the text it is, and a link or an image may point only where `LINK` and
    `IMAGE` allow, since the document is the agent's and the window is the
    app's. */
export function render(markdown: string): string {
  const escaped = markdown.replace(/</g, "&lt;");
  return marked.parse(escaped, { async: false, gfm: true, renderer }) as string;
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
}
