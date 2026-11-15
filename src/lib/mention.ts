import { wordStarts, type Marks } from "$lib/completion";

/**
 * Files mentioned in a message to an integrated session's agent: when an
 * `@` being typed is one, which of the project's files what follows it
 * leaves, what picking one writes, where the picked ones stand in the
 * message, and the form they go to the agent in.
 *
 * An `@` starts a mention at the start of the message or after a space,
 * never inside a word, so an email address is text, and never inside code
 * written between backticks. The word runs to the next space.
 *
 * A mention is the file's path, for the agent to read itself. It goes to
 * the agent between backticks, `` `@src/lib/a.ts` ``: Claude Code takes
 * any word of a message that begins with `@` as a file whose content it
 * sends along, and a word that begins with a backtick it leaves as
 * written. The same form keeps a path with spaces in one piece. Where the
 * mentions stand in a message is kept with it, never read back from its
 * text, since the same form is what a user writes for code.
 */

/** An `@` word being typed: where its `@` is, what follows it up to the
    caret, and where the word ends. */
export interface MentionWord {
  at: number;
  query: string;
  end: number;
}

/** Whether a place in a message is inside code: a fenced block, or
    backticks opened earlier on its line and not closed. */
export function inCode(draft: string, at: number): boolean {
  const before = draft.slice(0, at);
  const fences = before.split("```").length - 1;
  if (fences % 2 === 1) return true;
  const line = before.slice(before.lastIndexOf("\n") + 1).replaceAll("```", "");
  return (line.split("`").length - 1) % 2 === 1;
}

/** The `@` word the caret is in, or null when the caret is in no word that
    begins with an `@` after a space or at the start, or is in code. */
export function mentionWord(draft: string, caret: number): MentionWord | null {
  let at = caret;
  while (at > 0 && !/\s/.test(draft[at - 1])) at -= 1;
  if (draft[at] !== "@" || caret <= at) return null;
  if (inCode(draft, at)) return null;
  const rest = draft.slice(caret).search(/\s/);
  return { at, query: draft.slice(at + 1, caret), end: rest === -1 ? draft.length : caret + rest };
}

/** The message with its `@` word made the path's mention and a space, and
    where the caret goes: after the space. */
export function insertMention(draft: string, word: MentionWord, path: string): { text: string; caret: number } {
  const head = `${draft.slice(0, word.at)}@${path} `;
  const rest = draft.slice(word.end).replace(/^[ \t]/, "");
  return { text: `${head}${rest}`, caret: head.length };
}

/** A picked mention where it stands in the message, its `@` included. */
export interface Span {
  start: number;
  end: number;
  path: string;
}

/** What may follow a mention in a sentence without making it a longer
    path: a space, the end, or marks of punctuation before either. */
const AFTER = /^(?:$|\s|[.,;:!?)\]}'"]+(?:$|\s))/;

/** Where each picked path stands as a mention in the message: an `@` at
    the start or after a space, the path, and then a space, the end or a
    mark of punctuation. The longer of two paths that overlap wins. */
export function mentionSpans(draft: string, picked: readonly string[]): Span[] {
  const found: Span[] = [];
  const paths = [...new Set(picked)].sort((a, b) => b.length - a.length);
  for (const path of paths) {
    const word = `@${path}`;
    let from = 0;
    for (;;) {
      const start = draft.indexOf(word, from);
      if (start === -1) break;
      from = start + 1;
      const end = start + word.length;
      if (start > 0 && !/\s/.test(draft[start - 1])) continue;
      if (!AFTER.test(draft.slice(end))) continue;
      if (found.some((span) => start < span.end && end > span.start)) continue;
      if (inCode(draft, start)) continue;
      found.push({ start, end, path });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** A message in pieces, its mentions apart, for drawing. */
export interface Part {
  text: string;
  /** The path, when the piece is a mention. */
  path?: string;
}

/** The message cut where its mentions begin and end. */
export function parts(text: string, spans: readonly Span[]): Part[] {
  const out: Part[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) out.push({ text: text.slice(at, span.start) });
    out.push({ text: text.slice(span.start, span.end), path: span.path });
    at = span.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** Why a path cannot go to the agent as a mention, or null when it can.
    A line break or another control character would end the mention early
    and leave the rest standing as the user's own words, and a space
    before an `@` would start a word the agent takes as a file to send
    whole. */
export function unsafe(path: string): string | null {
  if (/[\n\r\u2028\u2029]/.test(path)) return "its path has a line break in it";
  if (/\p{Cc}/u.test(path)) return "its path has a control character in it";
  if (/\s@/.test(path)) return "its path has a space before an @";
  return null;
}

/** A path as it goes to the agent: its `@` and the path between backticks,
    one more of them than the longest run in the path, with nothing before
    the `@`. A path that ends in a backtick has a space after it, so the
    run that closes it stays apart. Only for a path `unsafe` passes. */
export function wire(path: string): string {
  const longest = Math.max(0, ...(path.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}@${path}${path.endsWith("`") ? " " : ""}${fence}`;
}

/** A mention where it stands in a message as it went, in its sent form. */
export type Sent = Span;

/**
 * The message as it goes to the agent, and where its mentions stand in it:
 * each picked mention in its sent form, and the files attached to it on a
 * line of their own after the words, each in the same form. A path
 * `unsafe` refuses is left as it was typed.
 */
export function outgoing(
  draft: string,
  picked: readonly string[],
  attached: readonly string[] = [],
): { text: string; mentions: Sent[] } {
  let text = "";
  let at = 0;
  const mentions: Sent[] = [];
  const put = (path: string) => {
    const sent = wire(path);
    mentions.push({ start: text.length, end: text.length + sent.length, path });
    text += sent;
  };
  for (const span of mentionSpans(draft, picked)) {
    if (unsafe(span.path) !== null) continue;
    text += draft.slice(at, span.start);
    put(span.path);
    at = span.end;
  }
  text += draft.slice(at);
  const files = attached.filter((path) => unsafe(path) === null);
  if (files.length === 0) return { text, mentions };
  text = text.trim() === "" ? "" : `${text.replace(/\s+$/, "")}\n\n`;
  files.forEach((path, index) => {
    if (index > 0) text += " ";
    put(path);
  });
  return { text, mentions };
}

/** A message as it went, cut where the mentions kept with it stand, each
    shown as the user wrote it: an `@` and the path. A mention kept with
    it that is not in its sent form there is left as text. */
export function sentParts(text: string, mentions: readonly Sent[]): Part[] {
  const out: Part[] = [];
  let at = 0;
  const sorted = [...mentions].sort((a, b) => a.start - b.start);
  for (const mention of sorted) {
    if (mention.start < at || text.slice(mention.start, mention.end) !== wire(mention.path)) continue;
    if (mention.start > at) out.push({ text: text.slice(at, mention.start) });
    out.push({ text: `@${mention.path}`, path: mention.path });
    at = mention.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** A message as it went, made a draft again: its mentions as the user
    wrote them, and their paths, picked. */
export function unsent(text: string, mentions: readonly Sent[]): { draft: string; picked: string[] } {
  const all = sentParts(text, mentions);
  return {
    draft: all.map((part) => part.text).join(""),
    picked: all.flatMap((part) => (part.path === undefined ? [] : [part.path])),
  };
}

/** The `@` words in a message that are typed whole rather than picked:
    each at the start or after a space, outside code, and not the word the
    caret is in, with a mark of punctuation after it left off. */
export function typedWords(draft: string, skip: MentionWord | null): string[] {
  const words: string[] = [];
  for (const found of draft.matchAll(/(?<=^|\s)@(\S+)/g)) {
    if (skip !== null && found.index === skip.at) continue;
    if (inCode(draft, found.index)) continue;
    words.push(found[1].replace(/[.,;:!?)\]}'"]+$/, ""));
  }
  return words;
}

// ---- the project's files ----

/** A file or folder the menu offers, by its path from the project's root;
    a folder's ends in a slash. */
export interface Found {
  path: string;
  marks: Marks;
}

const forward = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");

/** Where a path's last part begins; a folder's slash at the end is not
    part of it. */
function nameStart(path: string): number {
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  return bare.lastIndexOf("/") + 1;
}

/**
 * Every file and folder of a project, for finding what a query names. Made
 * once for a listing; a query then looks at each path once.
 */
export class FileIndex {
  readonly paths: string[];
  private readonly lower: string[];
  private readonly names: number[];
  private readonly depths: number[];

  constructor(files: readonly string[]) {
    const folders = new Set<string>();
    for (const file of files) {
      let slash = file.indexOf("/");
      while (slash !== -1) {
        folders.add(`${file.slice(0, slash)}/`);
        slash = file.indexOf("/", slash + 1);
      }
    }
    this.paths = [...files, ...folders];
    this.lower = this.paths.map((path) => path.toLowerCase());
    this.names = this.paths.map(nameStart);
    this.depths = this.paths.map((path) => path.replace(/\/$/, "").split("/").length);
  }

  /** What stands at the project's top: its files and folders, by name. */
  top(): string[] {
    return this.paths.filter((path) => path.indexOf("/") === -1 || path.indexOf("/") === path.length - 1).sort(byName);
  }

  /**
   * The paths a query leaves, best first, at most `limit` of them, and how
   * many it leaves in all. A query matches the last part of a path first:
   * the whole of it but the extension, where it begins, where a later word
   * in it begins, then anywhere in it; then the path, where a word in it
   * begins and then anywhere. A query with a slash in it
   * matches only paths. Of two as good, a changed file comes first, then
   * the one fewer folders down, then by name. Case is ignored.
   */
  find(query: string, changed: ReadonlySet<string>, limit: number): { found: Found[]; total: number } {
    const wanted = query.toLowerCase();
    const named = !wanted.includes("/");
    const hits: { index: number; tier: number; from: number }[] = [];
    for (let index = 0; index < this.lower.length; index++) {
      const path = this.lower[index];
      const at = path.indexOf(wanted);
      if (at === -1) continue;
      const name = this.names[index];
      let tier = -1;
      let from = at;
      if (named) {
        const own = path.indexOf(wanted, name);
        if (own === name) {
          const next = path[name + wanted.length];
          tier = next === undefined || next === "." || next === "/" ? 0 : 1;
        } else if (own !== -1) {
          const word = wordStarts(path.slice(name)).find((start) => start > 0 && path.startsWith(wanted, name + start));
          tier = word === undefined ? 3 : 2;
          from = word === undefined ? own : name + word;
        }
      }
      if (tier === -1) {
        const word = wordStarts(path).find((start) => path.startsWith(wanted, start));
        tier = word === undefined ? 5 : 4;
        from = word ?? at;
      }
      hits.push({ index, tier, from });
    }
    const lower = this.lower;
    hits.sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(changed.has(this.paths[b.index])) - Number(changed.has(this.paths[a.index])) ||
        this.depths[a.index] - this.depths[b.index] ||
        (lower[a.index] < lower[b.index] ? -1 : lower[a.index] > lower[b.index] ? 1 : 0),
    );
    return {
      found: hits.slice(0, limit).map((hit) => ({
        path: this.paths[hit.index],
        marks: wanted === "" ? [] : [[hit.from, hit.from + wanted.length]],
      })),
      total: hits.length,
    };
  }
}

function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A path from the project's root cut into its last part and the folder
    it is in, with the marks of each. */
export function split(found: Found): { name: string; dir: string; nameMarks: Marks; dirMarks: Marks } {
  const start = nameStart(found.path);
  const dir = start === 0 ? "" : found.path.slice(0, start - 1);
  const name = found.path.slice(start);
  const nameMarks: Marks = [];
  const dirMarks: Marks = [];
  for (const [from, to] of found.marks) {
    if (to > start) nameMarks.push([Math.max(0, from - start), to - start]);
    if (from < start - 1) dirMarks.push([from, Math.min(to, start - 1)]);
  }
  return { name, dir, nameMarks, dirMarks };
}

// ---- where a path is for the agent ----

/**
 * A file as the agent is told of it: its path from where the agent works
 * when it is inside that, else in full. `root` is the folder the listing is
 * of, `dir` where the agent works, and `path` either from `root` or in
 * full; a path on another machine is never shortened against one here.
 */
export function forAgent(path: string, root: string, dir: string): string {
  const full = /^(?:[A-Za-z]:[\\/]|[\\/]|ssh:\/\/)/.test(path) ? path : `${root.replace(/[\\/]+$/, "")}/${path}`;
  const base = `${forward(dir)}/`;
  const shown = forward(full) + (path.endsWith("/") ? "/" : "");
  if (shown.startsWith(base)) return shown.slice(base.length);
  // On another machine the agent knows the path there, without the host.
  return full.replace(/^ssh:\/\/[^/]*/, "");
}

/** A file's size as a card says it: bytes, KB, MB or GB, one decimal
    under ten. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown} ${units[unit]}`;
}
