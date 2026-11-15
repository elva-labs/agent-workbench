/**
 * Media the agent presented: images, PDFs, documents, pages and diagrams, kept per session
 * as one item per set of files and opened in the changes pane's viewer,
 * every file of the set down the page. Presenting the same files again
 * brings the item to the top with the new caption and shows the files as
 * they are now, so a document worked on over many turns is one row.
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
import { held, projectFor, sessionFor } from "$lib/show.svelte";
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
  /** Seconds since the epoch, of the latest call for these files. */
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

/** The session the request is for, by its agent's id: the one whose token
    the request names, anywhere in the window, or whose id a plugin names;
    else the project itself. A session whose id is not known yet cannot own
    anything, since the id is what the list is kept by. */
export function ownerFor(request: PresentRequest, project: string): string {
  return sessionFor(request)?.id ?? `project:${project}`;
}

/** The same files, in any order: the same item, whichever way the agent
    listed them this time. */
function sameFiles(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((file, i) => file === sorted[i]);
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

/** The agent presented files: kept on the session, and opened, now or
    when the user switches to the session. */
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
  const owner = ownerFor(request, project);
  const again = media.items.find(
    (candidate) =>
      candidate.owner === owner && sameFiles(candidate.files, request.files),
  );
  const item: MediaItem = {
    id:
      again?.id ??
      `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    owner,
    project,
    files: request.files,
    caption: request.caption,
    at: Math.floor(now / 1000),
  };
  if (again !== undefined) {
    media.items = media.items.filter((candidate) => candidate !== again);
  }
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
  const open = () => {
    if (workspace.active !== project) activate(project);
    showMedia(item);
  };
  if (held(request, open)) return;
  open();
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
  /** An HTML page, shown in a frame of its own. */
  | { mime: string; page: string }
  /** A Mermaid diagram's source, drawn in the window. */
  | { mime: string; diagram: string }
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

/** The renderer for what an agent says in a conversation: the same, except
    that an image is loaded only from the text itself. One from anywhere
    else would be fetched the moment the words arrive, which would tell
    whoever serves it whatever the agent put in its address. */
const said = new marked.Renderer();
said.link = ({ href, title, tokens }) => {
  const text = said.parser.parseInline(tokens);
  if (!LINK.test(href)) return text;
  const named = title ? ` title="${escapeAttribute(title)}"` : "";
  return `<a href="${escapeAttribute(href)}"${named} rel="noopener noreferrer">${text}</a>`;
};
said.image = ({ href, title, text }) => {
  if (/^data:image\//i.test(href)) {
    const named = title ? ` title="${escapeAttribute(title)}"` : "";
    return `<img src="${escapeAttribute(href)}" alt="${escapeAttribute(text)}"${named}>`;
  }
  if (!/^https?:/i.test(href)) return escapeText(text);
  return `<a href="${escapeAttribute(href)}" rel="noopener noreferrer">${escapeText(text || href)}</a>`;
};

/** Every code block the agent wrote, at the top or in a list or a quote,
    stands in a box of its own that the conversation puts its Copy in. */
const drawCode = said.code;
said.code = function (this: typeof said, token) {
  return `<div class="code" data-copy-host="code">${drawCode.call(this, token)}</div>`;
};

/** Raw HTML in a document is shown as the text it is, never drawn. Text is
    always escaped here: marked leaves text unescaped once it believes a raw
    block such as `<code>` has opened, and since raw HTML is never drawn, no
    such block ever has. Code is escaped by marked itself. */
renderer.html = ({ text }) => escapeText(text);
said.html = ({ text }) => escapeText(text);
renderer.text = (token) =>
  "tokens" in token && token.tokens ? renderer.parser.parseInline(token.tokens) : escapeText(token.text);
said.text = (token) =>
  "tokens" in token && token.tokens ? said.parser.parseInline(token.tokens) : escapeText(token.text);

/** Text as HTML that draws it as text: `<` and `>` always escaped, and
    `&` escaped unless it starts an entity, which then draws as its
    character, as Markdown means it to. An entity can only ever be text: it
    is decoded after the markup is read, so `&lt;b&gt;` is the letters,
    never a tag. */
function escapeText(text: string): string {
  return text
    .replace(/&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Markdown rendered for the viewer. Raw HTML in the document is shown as
    the text it is, and a link or an image may point only where `LINK` and
    `IMAGE` allow, since the document is the agent's and the window is the
    app's. */
export function render(markdown: string): string {
  return marked.parse(markdown, { async: false, gfm: true, renderer }) as string;
}

/** Markdown an agent wrote in a conversation, rendered as `render` does,
    with an image from anywhere but the text itself shown as a link. */
export function renderSaid(markdown: string): string {
  return marked.parse(markdown, { async: false, gfm: true, renderer: said }) as string;
}

/** Markdown an agent wrote, rendered as `renderSaid` does, one top-level
    block at a time, so a block that is done is drawn once while the words
    after it still come. */
export function saidBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown, { gfm: true });
  const out: string[] = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    // Each block is parsed with the whole text's link definitions, so a
    // reference link finds its address wherever it is defined.
    const one = Object.assign([token], { links: tokens.links });
    out.push(marked.parser(one, { async: false, gfm: true, renderer: said }));
  }
  return out;
}

/** How much of Markdown that is still being written stands in whole
    blocks that nothing written after it can change: every block but the
    last, which may yet grow. Rendered on its own, that much renders as it
    does at the head of the whole text, so it need only be rendered once. */
export function settled(markdown: string): number {
  const tokens = marked.lexer(markdown, { gfm: true });
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last].type === "space") last--;
  const whole = tokens
    .slice(0, Math.max(0, last))
    .map((token) => token.raw)
    .join("");
  // The lexer reads line ends its own way; what it read must be the text
  // as it stands for its length to say where the blocks end.
  return markdown.startsWith(whole) ? whole.length : 0;
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
    if (found.mime === "text/html") {
      return { mime: found.mime, page: decode(found.data) };
    }
    if (found.mime === "text/vnd.mermaid") {
      return { mime: found.mime, diagram: decode(found.data) };
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
