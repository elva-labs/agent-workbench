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
 * names do. A session that goes on from its notes under a new conversation
 * keeps listing what its earlier conversations presented.
 */

import { marked } from "marked";
import { runnable } from "$lib/bang";
import { core, type Media, type PresentRequest } from "$lib/core";
import { wholeLineageOf } from "$lib/goingOn.svelte";
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
  /** The token of the session that presented it, when the owner is the
      project because the session's id was not known yet. */
  token?: string;
  files: string[];
  caption: string | null;
  /** Seconds since the epoch, of the latest call for these files. */
  at: number;
}

const KEY = "chord.media";
/** The most items kept in all. A session's media is never dropped for
    its own count; past this, the oldest items of conversations no open
    session lists go first. */
const KEEP = 1000;

export const media = $state({
  items: [] as MediaItem[],
  /** How many calls each item has had since the window opened, by its
      id: what draws a page again when it is presented again, however
      soon. Not kept across a restart. */
  calls: {} as Record<string, number>,
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

/** The session the request is for, by its agent's id: the running one
    whose token the request names, anywhere in the window; else the project
    itself. A session whose id is not known yet cannot own
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

/** The owners whose media a session lists: the conversations it went on
    from and itself, or the project's own alone. */
function ownersOf(owner: string): Set<string> {
  return new Set(owner.startsWith("project:") ? [owner] : wholeLineageOf(owner));
}

/** The items for a session, newest first, and the project's own when it
    is asked for. A session lists the media of every conversation it went
    on from as well as its own, and what it presented before its id was
    known; a set of files presented in more than one
    of them is listed once, as its latest call has it. */
export function itemsFor(owner: string, token: string | null = null): MediaItem[] {
  const line = ownersOf(owner);
  const listed: MediaItem[] = [];
  for (const item of [...media.items].reverse()) {
    const mine = token !== null && item.token === token;
    if (!line.has(item.owner) && !mine) continue;
    if (!listed.some((seen) => sameFiles(seen.files, item.files))) listed.push(item);
  }
  return listed;
}

/** What the changes pane lists: the active session's, or with none the
    project's own. */
export function listed(): MediaItem[] {
  const project = workspace.active;
  if (project === null) return [];
  const active = forProject(project).find(
    (session) => session.key === sessions.active,
  );
  if (active !== undefined && active.id !== null) return itemsFor(active.id, active.token);
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
  const token = owner.startsWith("project:") ? sessionFor(request)?.token : undefined;
  // A row is reused only under the same owner: an earlier conversation's
  // item stays where it is for the other sessions that went on from it.
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
    ...(token === undefined ? {} : { token }),
    files: request.files,
    caption: request.caption,
    at: Math.floor(now / 1000),
  };
  if (again !== undefined) {
    media.items = media.items.filter((candidate) => candidate !== again);
  }
  media.items.push(item);
  media.calls[item.id] = (media.calls[item.id] ?? 0) + 1;
  trim();
  save();
  const open = () => {
    if (workspace.active !== project) activate(project);
    showMedia(item);
  };
  if (held(request, open)) return;
  open();
}

/** Keeps the list under `KEEP`: the oldest items go, those of
    conversations an open session lists last of all, never one of them. */
function trim() {
  let extra = media.items.length - KEEP;
  if (extra <= 0) return;
  const open = new Set<string>();
  for (const session of sessions.all)
    if (session.id !== null) for (const id of wholeLineageOf(session.id)) open.add(id);
  const tokens = new Set(sessions.all.map((session) => session.token));
  const drop = new Set<string>();
  for (const item of media.items) {
    if (extra === 0) break;
    if (open.has(item.owner) || (item.token !== undefined && tokens.has(item.token))) continue;
    drop.add(item.id);
    extra -= 1;
  }
  media.items = media.items.filter((item) => !drop.has(item.id));
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

/** The languages a fenced block names when it holds words rather than
    code: such a block is a drafted message, a comment or a description
    for the reader to copy. A block with no language is one too, unless
    it holds text laid out by its lines (see `drawn`). Any other language
    is code, whose lines are kept as written. */
const PROSE = new Set(["text", "txt", "plain", "plaintext", "markdown", "md", "message", "email", "comment", "prose"]);

/** Whether a block's lines are laid out rather than written as prose: a
    table or tree drawn in text, aligned columns, command output, a stack
    trace, a diff. Such a block keeps its lines and scrolls sideways. */
function drawn(text: string): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    return (
      /[\u2500-\u257f]/.test(line) ||
      (trimmed.length > 1 && trimmed.startsWith("|") && trimmed.endsWith("|")) ||
      /^(?:---|\+\+\+) |^@@ /.test(line) ||
      /\S(?: {2,}|\t+)\S/.test(line) ||
      /^\s*at \S.*:\d+(?::\d+)?\)?$|^\s*File ".*", line \d+|^Traceback /.test(line)
    );
  });
}

/** A line's hanging indent in characters: its leading whitespace and a
    list marker after it, so a continuation line starts under the words. */
function hang(line: string): number {
  const lead = /^[ \t]*/.exec(line)![0];
  const width = lead.replace(/\t/g, "        ").length;
  const marker = /^(?:[-*+]|\d{1,3}[.)]|>)[ \t]+/.exec(line.slice(lead.length));
  return width + (marker ? marker[0].length : 0);
}

/** Every code block the agent wrote, at the top or in a list or a quote,
    stands in a box of its own that the conversation puts its Copy in. A
    block of prose wraps at the box's width, each line a block of its own
    that hangs its continuation lines under its words; the text of the
    box is still the lines as written, line breaks included. A line that
    is a command for the user to run is marked for its Run (see `runLine`). */
const drawCode = said.code;
said.code = function (this: typeof said, token) {
  const lang = (token.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
  if ((lang !== "" && !PROSE.has(lang)) || (lang === "" && drawn(token.text)))
    return `<div class="code" data-copy-host="code">${runLines(drawCode.call(this, token))}</div>`;
  const named = lang === "" ? "" : ` class="language-${escapeAttribute(lang)}"`;
  const lines = token.text
    .split("\n")
    .map((line) => `<span class="line" style="--hang:${hang(line)}ch">${runLine(escapeAttribute(line))}\n</span>`)
    .join("");
  return `<div class="code" data-copy-host="code" data-wrap><pre><code${named}>${lines}</code></pre></div>\n`;
};

/** What marks an element as holding a command for the user to run. The
    command is drawn left to right in the order it runs, so right-to-left
    letters in it cannot reorder or mirror what is around them. */
const RUN = 'data-run="" dir="ltr" style="unicode-bidi: bidi-override"';

/** A line of code as HTML, held in an element marked `data-run` when it is
    a command for the user to run, `!` and a space and then the command, so
    the conversation puts a Run after it. Escaping leaves a line's `!` and
    space as they are and an empty line empty, so the escaped line tells
    as well as the line itself. */
function runLine(html: string): string {
  return runnable(html) === null ? html : `<span ${RUN}>${html}</span>`;
}

/** A code block as marked draws it, each of its lines through `runLine`. */
function runLines(html: string): string {
  const block = /^(<pre><code[^>]*>)([\s\S]*)(<\/code><\/pre>\n?)$/.exec(html);
  if (block === null) return html;
  return block[1] + block[2].split("\n").map(runLine).join("\n") + block[3];
}

/** A code span is marked `data-run` when it holds a command for the user
    to run, as a line of a block is. */
const drawSpan = said.codespan;
said.codespan = function (this: typeof said, token) {
  const html = drawSpan.call(this, token);
  return runnable(token.text) === null ? html : html.replace(/^<code>/, `<code ${RUN}>`);
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
  media.calls = {};
}
