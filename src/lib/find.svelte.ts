import type { Conversation } from "$lib/conversation.svelte";
import { saidBlocks } from "$lib/media.svelte";
import { endedWith, entryPrint, heldIn, heldWaiting, type Held, type HeldOptions } from "$lib/thread";

/**
 * Find in a conversation.
 *
 * What is looked in is everything the thread holds, whether it is drawn
 * or not: messages, what the agent said as the reader sees it rendered,
 * plans, questions and notes, and inside folded work each step's command,
 * input, changed lines and output, a subagent's run included. The labels
 * the thread puts around them, who spoke, when, how long the work took,
 * are not looked in. Case is ignored unless the words looked for hold a
 * capital.
 *
 * The matches are counted from the conversation, a slice at a time, so a
 * long one never holds up typing, and counted again as it changes. They
 * are marked only where the thread draws them, by the place each thing it
 * holds is drawn: an element carrying its key in `data-find`, read as
 * find reads it, leaving out what is marked `data-find-skip` and what
 * another thing the thread holds draws inside it. Marking paints over the
 * text without changing the page, so selecting, copying and links work as
 * ever.
 */

/** The chord asked the conversation on screen to find. */
export const findAsked = $state({ count: 0 });

export function askFind() {
  findAsked.count += 1;
}

/** Whether case counts in a search: only when it holds a capital. */
export function caseCounts(query: string): boolean {
  return /[\p{Lu}\p{Lt}]/u.test(query);
}

/** Text in lower case, each character keeping its length, so a place in
    one is the same place in the other. */
export function lower(text: string): string {
  const all = text.toLowerCase();
  if (all.length === text.length) return all;
  let out = "";
  for (const char of text) {
    const one = char.toLowerCase();
    out += one.length === char.length ? one : char;
  }
  return out;
}

/** Where `needle` stands in `haystack`, each place after the end of the
    one before. */
export function places(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === "") return out;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) out.push(at);
  return out;
}

function countIn(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/** Elements that stand on lines of their own: a match never runs from
    one into the next. */
const BLOCKS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY",
  "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** What a part of the page shows, as find reads it: its text, and where
    each text node of it starts in that text. */
export interface Read {
  text: string;
  nodes: Text[];
  starts: number[];
}

/**
 * Reads the places a thing the thread holds is drawn, as find reads them:
 * their text, with a line between things that stand apart, a block, a
 * break, a place left out, or the next place. What is marked
 * `data-find-skip`, and the place of another thing, a key other than
 * `key`, are left out. Space that only stands between blocks, or beside
 * the edge of one or a place left out, counts as a line.
 */
export function readOut(places: Iterable<Node>, key: string | null = null): Read {
  let text = "";
  const nodes: Text[] = [];
  const starts: number[] = [];
  let line = false;
  const apart = () => {
    if (text !== "") line = true;
  };
  /** Whether what stands beside a space marks where one thing ends:
      nothing, a block, a break, a place left out or another's place. */
  const edge = (node: Node | null): boolean => {
    while (node !== null && node.nodeType === Node.COMMENT_NODE) node = node.previousSibling;
    if (node === null) return true;
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = node as Element;
    const own = element.getAttribute("data-find");
    return (
      BLOCKS.has(element.tagName) ||
      element.tagName === "BR" ||
      element.hasAttribute("data-find-skip") ||
      (own !== null && key !== null && own !== key)
    );
  };
  const after = (node: Node | null): Node | null => {
    while (node !== null && node.nodeType === Node.COMMENT_NODE) node = node.nextSibling;
    return node;
  };
  const visit = (node: Node, pre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node as Text).data;
      if (value === "") return;
      // Space between blocks, or beside a place left out, is no part of
      // the words either side: it is where one thing ends.
      if (!pre && value.trim() === "" && (value.includes("\n") || edge(node.previousSibling) || edge(after(node.nextSibling)))) {
        apart();
        return;
      }
      if (line) text += "\n";
      line = false;
      nodes.push(node as Text);
      starts.push(text.length);
      text += value;
      return;
    }
    let block = false;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const own = element.getAttribute("data-find");
      if (element.hasAttribute("data-find-skip") || (own !== null && key !== null && own !== key) || element.tagName === "BR") {
        apart();
        return;
      }
      block = BLOCKS.has(element.tagName);
      pre ||= element.tagName === "PRE";
    } else if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (block) apart();
    for (let child = node.firstChild; child !== null; child = child.nextSibling) visit(child, pre);
    if (block) apart();
  };
  for (const place of places) {
    apart();
    visit(place, place instanceof Element && place.parentElement?.closest("pre") != null);
  }
  return { text, nodes, starts };
}

/** Markdown the agent wrote, as the thread shows it rendered, read as
    find reads it. */
export function saidText(markdown: string): string {
  if (markdown === "") return "";
  const made = document.createElement("template");
  made.innerHTML = saidBlocks(markdown).join("");
  return readOut([made.content]).text;
}

/** A range for each place `needle` stands in what was read. */
export function rangesIn(read: Read, needle: string, cased: boolean): Range[] {
  const haystack = cased ? read.text : lower(read.text);
  const out: Range[] = [];
  let node = 0;
  const point = (at: number, end: boolean): [Text, number] => {
    // The text node holding the place: for an end, the one it ends in.
    while (node + 1 < read.nodes.length && (end ? read.starts[node + 1] < at : read.starts[node + 1] <= at)) node += 1;
    return [read.nodes[node], at - read.starts[node]];
  };
  for (const at of places(haystack, needle)) {
    const range = document.createRange();
    const [startNode, startAt] = point(at, false);
    const keep = node;
    const [endNode, endAt] = point(at + needle.length, true);
    range.setStart(startNode, Math.min(startAt, startNode.length));
    range.setEnd(endNode, Math.min(endAt, endNode.length));
    out.push(range);
    node = keep;
  }
  return out;
}

/** One match: the key of what holds it, and which of its matches it is. */
export interface Hit {
  key: string;
  nth: number;
}

/** What one thing holds as find reads it, kept while it does not change. */
interface Seen {
  text: string;
  markdown: string | null;
  seen: string;
  lowered: string | null;
}

function samePrint(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false;
  return true;
}

/** How long a slice of counting runs before the window gets a turn, in
    milliseconds. */
const SLICE = 8;

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Find in one conversation: the words looked for, how many matches there
 * are, and which is the current one. The count is of the whole
 * conversation; the current match is kept by what holds it as the
 * conversation changes.
 */
export class Finder {
  query = $state("");
  /** The matches counted for the query, or null while the first count
      for it is still on its way. */
  total = $state<number | null>(0);
  /** The current match, from 0, or -1 for none. */
  current = $state(-1);
  /** Which of what the thread holds has matches, and how many, in the
      order drawn. */
  found = $state.raw<{ held: Held; count: number }[]>([]);

  #conversation: () => Conversation;
  #options: () => HeldOptions;
  #seen = new Map<string, Seen>();
  /** What each entry held when last read, by its key, with its print. */
  #entries = new Map<string, { print: unknown[]; items: Held[] }>();
  /** Everything the thread held when last read, and what it was read at. */
  #read: { conversation: Conversation; root: string | null; revision: number; items: Held[] } | null = null;
  #run = 0;

  constructor(conversation: () => Conversation, options: () => HeldOptions = () => ({})) {
    this.#conversation = conversation;
    this.#options = options;
  }

  /** What one thing the thread holds shows, as find reads it. */
  #text(item: Held, cased: boolean): string {
    let seen = this.#seen.get(item.key);
    if (seen === undefined || seen.text !== item.text || seen.markdown !== item.markdown) {
      const said = item.markdown === null ? "" : saidText(item.markdown);
      seen = {
        text: item.text,
        markdown: item.markdown,
        seen: item.text === "" ? said : said === "" ? item.text : `${item.text}\n${said}`,
        lowered: null,
      };
      this.#seen.set(item.key, seen);
    }
    if (cased) return seen.seen;
    seen.lowered ??= lower(seen.seen);
    return seen.lowered;
  }

  /** The current match: what holds it and which of its matches it is. */
  hit(at: number = this.current): (Hit & { held: Held }) | null {
    if (at < 0) return null;
    let before = 0;
    for (const one of this.found) {
      if (at < before + one.count) return { key: one.held.key, nth: at - before, held: one.held };
      before += one.count;
    }
    return null;
  }

  /** Moves the current match on, or back, wrapping at the ends. */
  step(by: 1 | -1) {
    const total = this.total ?? 0;
    if (total === 0) return;
    this.current = this.current < 0 ? (by > 0 ? 0 : total - 1) : (this.current + by + total) % total;
  }

  /**
   * Counts the query's matches in the whole conversation again, a slice
   * at a time. For new words, `from` says where to start: the first match
   * in or after the thing with that key, else in or after the entry with
   * that key, else the first. Otherwise the current match stays on what
   * holds it. Answers whether this count was the last one asked for.
   */
  async search(from: { key?: string | null; entry?: string | null } | null = null): Promise<boolean> {
    const run = ++this.#run;
    const query = this.query;
    if (query === "") {
      this.found = [];
      this.total = 0;
      this.current = -1;
      return true;
    }
    const cased = caseCounts(query);
    const needle = cased ? query : lower(query);
    const conversation = this.#conversation();
    let started = performance.now();
    /** Lets the window have a turn once a slice has run; false when a
        later count was asked for meanwhile. */
    const breathe = async (): Promise<boolean> => {
      if (performance.now() - started <= SLICE) return true;
      if (from !== null) this.total = null;
      await pause();
      started = performance.now();
      return run === this.#run;
    };
    const items = await this.#held(conversation, breathe);
    if (items === null) return false;
    const counts: number[] = new Array(items.length);
    for (let at = 0; at < items.length; at++) {
      if (!(await breathe())) return false;
      counts[at] = countIn(this.#text(items[at], cased), needle);
    }
    const was = from === null ? this.hit() : null;
    const found: { held: Held; count: number }[] = [];
    let total = 0;
    let current = -1;
    // Where a new search starts: the place in the list it starts from.
    let start = -1;
    if (from !== null) {
      start = from.key == null ? -1 : items.findIndex((item) => item.key === from.key);
      if (start === -1 && from.entry != null) {
        const order = new Map(conversation.entries.map((entry, at) => [entry.key, at]));
        const wanted = order.get(from.entry);
        if (wanted !== undefined)
          start = items.findIndex((item) => (item.entry === null ? Infinity : (order.get(item.entry) ?? -1)) >= wanted);
      }
    }
    for (let at = 0; at < items.length; at++) {
      const count = counts[at];
      if (count === 0) continue;
      if (from !== null && current === -1 && start !== -1 && at >= start) current = total;
      if (was !== null && items[at].key === was.key) current = total + Math.min(was.nth, count - 1);
      found.push({ held: items[at], count });
      total += count;
    }
    if (total > 0 && current === -1)
      current = from !== null ? 0 : Math.min(Math.max(this.current, 0), total - 1);
    // What is no longer held is no longer kept.
    if (this.#seen.size > items.length * 2) {
      const keys = new Set(items.map((item) => item.key));
      for (const key of this.#seen.keys()) if (!keys.has(key)) this.#seen.delete(key);
    }
    this.found = found;
    this.total = total;
    this.current = total === 0 ? -1 : current;
    return true;
  }

  /**
   * Everything the thread holds, read again only where it changed: as
   * it was while the conversation has not changed since, and otherwise
   * each entry as it was while its print is the same. Answers null when a
   * later count was asked for on the way.
   */
  async #held(conversation: Conversation, breathe: () => Promise<boolean>): Promise<Held[] | null> {
    const options = this.#options();
    const root = options.root ?? null;
    const revision = conversation.revision;
    const read = this.#read;
    if (read !== null && read.conversation === conversation && read.root === root && read.revision === revision)
      return read.items;
    if (read !== null && (read.conversation !== conversation || read.root !== root)) this.#entries.clear();
    const ended = endedWith(conversation);
    const items: Held[] = [];
    const keys = new Set<string>();
    for (const entry of [...conversation.entries]) {
      if (!(await breathe())) return null;
      keys.add(entry.key);
      if (entry.key === ended) continue;
      const print = entryPrint(conversation, entry);
      const kept = this.#entries.get(entry.key);
      if (kept !== undefined && samePrint(kept.print, print)) {
        for (const item of kept.items) items.push(item);
        continue;
      }
      const fresh = heldIn(conversation, entry, options);
      this.#entries.set(entry.key, { print, items: fresh });
      for (const item of fresh) items.push(item);
    }
    for (const item of heldWaiting(conversation, options)) items.push(item);
    for (const key of this.#entries.keys()) if (!keys.has(key)) this.#entries.delete(key);
    this.#read = { conversation, root, revision, items };
    return items;
  }

  /** Stops any count on its way. */
  cancel() {
    this.#run += 1;
  }
}

const HITS = "find-hit";
const CURRENT = "find-current";

/** Whether the page can paint over text without changing it. */
function canPaint(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

/**
 * Marks the matches `root` draws: every one tinted and the current one
 * filled. Answers the current match's range when it is drawn.
 */
export function paintMatches(root: Element, query: string, keys: Set<string>, current: Hit | null): Range | null {
  const cased = caseCounts(query);
  const needle = cased ? query : lower(query);
  const byKey = new Map<string, Element[]>();
  for (const place of root.querySelectorAll<HTMLElement>("[data-find]")) {
    const key = place.dataset.find!;
    if (!keys.has(key)) continue;
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [place]);
    else list.push(place);
  }
  const hits: Range[] = [];
  let now: Range | null = null;
  for (const [key, list] of byKey) {
    const ranges = rangesIn(readOut(list, key), needle, cased);
    if (current !== null && key === current.key && ranges.length > 0) {
      now = ranges[Math.min(current.nth, ranges.length - 1)];
      hits.push(...ranges.filter((range) => range !== now));
    } else hits.push(...ranges);
  }
  if (canPaint()) {
    CSS.highlights.set(HITS, new Highlight(...hits));
    const filled = new Highlight(...(now === null ? [] : [now]));
    filled.priority = 1;
    CSS.highlights.set(CURRENT, filled);
  }
  return now;
}

/** Takes every mark away. */
export function clearMatches() {
  if (!canPaint()) return;
  CSS.highlights.delete(HITS);
  CSS.highlights.delete(CURRENT);
}
