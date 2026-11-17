<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Conversation, Entry, Message } from "$lib/conversation.svelte";
  import { clock, drawnPart, notRead, nowDoing, replyMarkdown, speaker, stamps, startedIds, tokens, toHear } from "$lib/thread";
  import { reportsShown, spoken, wakeShown } from "$lib/instructions";
  import { sentParts, unsent } from "$lib/mention";
  import { mentionsOf } from "$lib/mentioned.svelte";
  import { sessionName, timeOf, type Sender } from "$lib/senders.svelte";
  import { focusPane } from "$lib/layout.svelte";
  import { shareFolds } from "$lib/folds";
  import { shareAsking } from "$lib/stepAsking";
  import { askingOf } from "$lib/subagents";
  import { renderSaid } from "$lib/media.svelte";
  import { goTo } from "$lib/workspace.svelte";
  import { reduced } from "$lib/motion";
  import Copy from "./Copy.svelte";
  import Icon from "./Icon.svelte";
  import Parts from "./Parts.svelte";
  import Plain from "./Plain.svelte";
  import Started from "./Started.svelte";

  /**
   * The thread: who said what, in the order it happened. The user's words
   * sit to the right in a tinted bubble under "You", and what another
   * session sent sits there too, in a plain bubble under that session's
   * name; the agent's run on the left under its name, down a quiet line at
   * the side. Messages that wait for the agent stand under the thread until
   * a turn takes them. The workbench's own sentence after a started
   * session's prompt is never shown as part of it, only behind a fold.
   *
   * The thread stays at its foot while it is there and new content comes,
   * and stays where the user scrolled to otherwise, with a way back down.
   *
   * A long thread draws only the entries in and near the view; the space
   * of the others stands above and below them at the height they were
   * drawn at, or at the height drawn entries average before they ever
   * were. What the reader looks at stays where it is when anything drawn
   * above it changes height or entries come above it. A short one is drawn
   * whole.
   */
  interface Props {
    conversation: Conversation;
    /** The folder paths in the thread are shown from. */
    root: string | null;
    /** What stands above a thread with nothing in it yet. */
    intro: string | null;
    /** The agent's own name, for a run on its default model. */
    agent: string;
    /** Whether each run goes under the model its turn ran on; else under
        the agent's name. */
    models?: boolean;
    /** A message that failed to send is taken back into the composer. */
    onPutBack?: (message: Message) => void;
    /** The session that sent a message, or null for the user. */
    sender?: (message: Message) => Sender | null;
    /** What opens a file a message mentions, or null for one the viewer
        does not show. */
    opener?: (path: string) => (() => void) | null;
    /** Room kept at the top for what stands over it, such as the find
        bar, in pixels. */
    room?: number;
    /** What the messages that wait can do: be sent now, all of them, or
        each of the user's own be taken back. Absent where a thread offers
        neither. */
    waiting?: {
      sendNow: () => void;
      takeBack: (message: Message) => void;
      /** The line under each, which says what it waits for. */
      line: string;
      /** Whether they can be sent now. */
      canSend: boolean;
      /** Whether a message can be taken back: not while they are on
          their way. */
      canTake: boolean;
      /** What sending now does, for its tooltip. */
      title: string;
      /** What taking one back does, and the chord for the newest. */
      takeTitle: string;
      takeChord: string;
    };
  }

  let { conversation, root, intro, agent, models = true, onPutBack, sender, opener, room = 0, waiting }: Props = $props();

  /** A message's first words, to tell its buttons from another's. */
  function shortly(text: string): string {
    const line = text.trim().split("\n")[0] ?? "";
    return line.length > 40 ? `${line.slice(0, 39)}…` : line;
  }

  /** The last message that waits for a turn, under which sending them
      all now is offered. */
  let lastQueued = $derived(conversation.waiting.findLast((said) => said.state === "queued")?.id ?? null);
  /** The newest of the user's own messages that wait, which the chord
      takes back. */
  let newestOwn = $derived(
    conversation.waiting.findLast((said) => said.state === "queued" && (sender?.(said) ?? null) === null)?.id ?? null,
  );

  shareFolds(() => conversation.opened);

  /** The calls whose subagent asks now, which their steps say. */
  let asking = $derived(askingOf(conversation));
  shareAsking(() => asking);

  /** The messages whose workbench sentence stands open. */
  let unfolded = $state<Record<string, boolean>>({});

  function goToSender(from: Sender) {
    if (from.key !== null && goTo(from.key)) focusPane("agent");
  }

  let scroller = $state<HTMLDivElement | null>(null);
  /** Whether the thread is at its foot, and so follows what comes. */
  let pinned = true;
  /** Something came while the user was scrolled up. */
  let behind = $state(false);

  /** The agent's last run in the running turn, where what it is doing now
      is said. */
  let liveKey = $derived.by(() => {
    if (!conversation.working || conversation.ended !== null) return null;
    // With no turn running the run that ended says how it ended; only a
    // compaction or subagents still to report are said under it.
    if (
      conversation.current === null &&
      !conversation.compacting &&
      !conversation.tasks.some((task) => task.kind === "agent" && !task.ambient && task.status === "running")
    )
      return null;
    for (let at = conversation.entries.length - 1; at >= 0; at--) {
      const entry = conversation.entries[at];
      if (entry.kind === "agent") return conversation.current === null || entry.turn === conversation.current ? entry.key : null;
      if (entry.kind === "user") return null;
    }
    return null;
  });

  /** The last run of each turn, which says how the turn ended. */
  let lastOfTurn = $derived.by(() => {
    const last = new Map<number, string>();
    for (const entry of conversation.entries) if (entry.kind === "agent") last.set(entry.turn, entry.key);
    return new Set(last.values());
  });

  /** A cheap reading of what the thread holds, which changes whenever
      something new comes: more entries, a longer last part, a request. */
  function pulse(): string {
    const last = conversation.entries[conversation.entries.length - 1];
    let tail = "";
    if (last?.kind === "agent") {
      const part = last.parts[last.parts.length - 1];
      if (part !== undefined)
        tail =
          part.kind === "text" || part.kind === "thinking"
            ? `${part.text.length}`
            : part.kind === "tool"
              ? `${part.done}:${part.output.length}`
              : part.kind;
      tail = `${last.parts.length}:${tail}`;
    }
    return `${conversation.entries.length}|${conversation.waiting.length}|${tail}|${conversation.open.length}|${liveKey}`;
  }

  let col = $state<HTMLDivElement | null>(null);
  /** When the user last pressed or clicked in the thread: the thread
      growing then is a fold they opened, not something new to follow. */
  let touched = Number.NEGATIVE_INFINITY;

  // Marks new content as come while the user is scrolled up.
  $effect(() => {
    pulse();
    untrack(() => {
      heard();
      if (!pinned) behind = true;
      // In a long thread its size changes as rows are drawn around the
      // view, so new content is followed here rather than by its size.
      else if (windowed)
        void tick().then(() => {
          if (pinned && scroller !== null) toEnd(scroller);
        });
      announce();
    });
  });

  // Follows the thread's own size while at the foot, so text that is drawn
  // a frame after it arrives, or grows as a whole replaces its pieces, is
  // followed all the same; and the size of the space it is shown in, which
  // shrinks as the dock or the composer under it grows.
  $effect(() => {
    if (col === null || scroller === null) return;
    const scrolled = scroller;
    const inner = col;
    const observer = new ResizeObserver((seen) => {
      // Out of view, the thread has no size to follow. Back in view, the
      // browser puts the view where it was, and from there it goes on as
      // for any change of size: to the foot, if it followed its foot.
      if (!shown()) return;
      reflowed();
      heard();
      // Which rows to draw is worked out again a frame on: drawing them
      // now would change the size this has just been told of.
      if (windowed) requestAnimationFrame(look);
      if (!pinned || (windowed && !atFoot())) {
        if (windowed) keep();
        return;
      }
      // A fold the user opened in the thread grows it; the space shrinking
      // under it is never the user's doing in the thread.
      const grew = seen.some((entry) => entry.target === inner);
      const shrank = seen.some((entry) => entry.target === scrolled);
      if (shrank || (grew && performance.now() - touched > 400)) toEnd(scrolled);
    });
    observer.observe(col);
    observer.observe(scroller);
    return () => observer.disconnect();
  });

  // What the user sends goes on screen: the thread goes to its foot.
  let lastSent = 0;
  $effect(() => {
    const now = conversation.sentHere;
    untrack(() => {
      if (now > lastSent && scroller !== null) {
        pinned = true;
        behind = false;
        void tick().then(() => {
          if (scroller !== null) toEnd(scroller);
        });
      }
      lastSent = now;
    });
  });

  /** What waited under the thread when it was last followed. */
  let waitingThen = "";
  // What waits under the thread stands at its foot, under the newest of
  // what was said: while the thread follows its foot, a message that comes
  // to wait, or whose line under it changes, is brought wholly into view
  // once it is laid out, even just after a press in the thread, such as on
  // its own Send now.
  $effect(() => {
    const now = `${conversation.waiting.map((said) => `${said.id}:${said.state}`).join(",")}|${waiting?.line}|${waiting?.canSend}|${waiting?.canTake}`;
    untrack(() => {
      if (now === waitingThen) return;
      waitingThen = now;
      if (!pinned || scroller === null) return;
      void tick().then(() =>
        requestAnimationFrame(() => {
          if (pinned && scroller !== null) toEnd(scroller);
        }),
      );
    });
  });

  /** Where the thread last scrolled itself to, or the browser left it to
      keep the reader's place across a change of width: a scroll that lands
      there says nothing of where the user wants to be. */
  let ownTop = Number.NEGATIVE_INFINITY;

  function toEnd(node: HTMLDivElement) {
    if (!shown()) return;
    node.scrollTop = node.scrollHeight;
    ownTop = node.scrollTop;
    // The thread has the view now: a scroll that comes after this is the
    // user's only once they scroll again.
    scrolledBy = Number.NEGATIVE_INFINITY;
  }

  /** The width the thread was last seen at. */
  let across = 0;

  /** Takes in a change of the thread's width. A thread drawn whole leaves
      the reader's place to the browser, which scrolls to keep it as the
      rows reflow: where that leaves the view is not the user's doing. */
  function reflowed() {
    if (scroller === null) return;
    const width = scroller.clientWidth;
    if (across > 0 && width !== across && !windowed) ownTop = scroller.scrollTop;
    across = width;
  }

  /** Whether the thread is laid out. A session not in front is not, so
      the conversations behind it cost nothing when the window is laid
      out; its sizes and its scroll position then read as nothing and are
      left alone. */
  function shown(): boolean {
    return scroller !== null && scroller.getClientRects().length > 0;
  }

  /** Whether a long thread is at its foot to follow it: it follows, and it
      has not been laid out yet, or the view is where the thread last put
      it or within two screens of the foot. A view something else moved far
      from the foot, a screen reader, a find bar or a selection being
      dragged, has the rows around it drawn, and goes back to the foot only
      for what comes next. */
  function atFoot(): boolean {
    if (!pinned || scroller === null) return false;
    if (anchor === null || scroller.scrollTop === ownTop) return true;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < Math.max(800, 2 * scroller.clientHeight);
  }

  /** When the user last scrolled the thread themselves: the wheel, a
      touch, a key that scrolls, or the scrollbar. */
  let scrolledBy = Number.NEGATIVE_INFINITY;
  /** The scroll bar is held down, for as long as it is. */
  let dragging = false;
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

  /** Where the foot was when the user last scrolled: a scroll can be heard
      only after more has come, and the foot the user scrolled to is then
      short of the foot there is now. */
  let footThen = Number.POSITIVE_INFINITY;

  function userScrolls() {
    scrolledBy = performance.now();
    // From here on a scroll is the user's, wherever it lands.
    ownTop = Number.NEGATIVE_INFINITY;
    if (scroller !== null) footThen = scroller.scrollHeight - scroller.clientHeight;
  }

  /** Where the thread was last heard to be, to tell a scroll down from
      one up. */
  let lastTop = 0;

  /** Takes in where the user has scrolled before the thread moves on its
      own: a browser can tell of a scroll only after more has come. */
  function heard() {
    if (scroller !== null && shown() && scroller.scrollTop !== lastTop) onscroll();
  }

  function onscroll() {
    if (scroller === null) return;
    reflowed();
    const top = scroller.scrollTop;
    const down = top >= lastTop - 1;
    lastTop = top;
    // Only the user decides whether the thread follows. The thread's own
    // scroll to its foot can be heard after more has come, and the browser
    // moves the view itself to keep its place while text is drawn again;
    // neither is the user leaving the foot. A move nobody here made, such
    // as a screen reader bringing what it reads into view, stays where it
    // was put.
    if (performance.now() - scrolledBy > 1000) return;
    if (Math.abs(top - ownTop) < 2) return;
    if (scroller.scrollHeight - top - scroller.clientHeight < 32) {
      pinned = true;
      behind = false;
      return;
    }
    // Scrolling down to the foot as it stood when the user scrolled is
    // going back to the foot, and scrolling down never leaves it: either
    // way the thread follows, and goes on to the foot there is now.
    if (down && (pinned || footThen - top < 32)) {
      pinned = true;
      behind = false;
      toEnd(scroller);
      return;
    }
    pinned = false;
  }

  /** What the arrows walk in the thread: its folds, steps and links, in
      the order they stand, while they are drawn. */
  function items(): HTMLElement[] {
    if (col === null) return [];
    return [...col.querySelectorAll<HTMLElement>("[data-thread-item], a[href]")].filter(
      (item) => item.getClientRects().length > 0 && !(item as HTMLButtonElement).disabled,
    );
  }

  /** The thread is one stop for Tab, as a list is. Up and Down move
      through what it holds, from where the keyboard is or, from the thread
      itself, from what is in view; Home and End go to the first and the
      last, and Escape goes back to the composer. The other keys that
      scroll scroll it. What is not drawn is drawn as the walk comes to it. */
  async function onThreadKey(e: KeyboardEvent) {
    touched = performance.now();
    if (scroller === null) return;
    // Escape gives the keyboard back to the composer, as it does from the
    // palette, when there is one to type in.
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const field = scroller.closest("[data-session]")?.querySelector<HTMLElement>("[data-testid='composer-input']");
      if (field) {
        e.preventDefault();
        e.stopPropagation();
        field.focus();
      }
      return;
    }
    let all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    // On the thread itself, Home and End scroll to the first and the last
    // here: the browser would scroll toward a height the thread no longer
    // has once it draws the rows there.
    if (windowed && at === -1 && (e.key === "Home" || e.key === "End") && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      userScrolls();
      const home = e.key === "Home";
      if (!home) {
        pinned = true;
        behind = false;
      }
      await reveal(rows[home ? 0 : rows.length - 1].key, home ? "start" : "end");
      if (home) scroller.scrollTop = 0;
      else toEnd(scroller);
      look();
      return;
    }
    const walk = ["ArrowDown", "ArrowUp"].includes(e.key) || (at !== -1 && ["Home", "End"].includes(e.key));
    if (!walk || all.length === 0 || e.metaKey || e.ctrlKey || e.altKey) {
      if (SCROLL_KEYS.has(e.key)) userScrolls();
      return;
    }
    e.preventDefault();
    let next: HTMLElement | undefined;
    if (e.key === "Home" || e.key === "End") {
      const home = e.key === "Home";
      userScrolls();
      const row = rows.length === 0 ? null : await reveal(rows[home ? 0 : rows.length - 1].key, home ? "start" : "end");
      all = items();
      const inside = row === null ? [] : all.filter((item) => row.contains(item));
      // The last is what waits under the thread, where something does.
      next = home ? (inside[0] ?? all[0]) : all[all.length - 1];
      // At the last, the thread is at its foot, and follows it.
      if (!home) {
        pinned = true;
        behind = false;
      }
    } else if (at !== -1) {
      const down = e.key === "ArrowDown";
      next = all[at + (down ? 1 : -1)] ?? (await beyond(all[at], down)) ?? all[at];
    } else {
      const view = scroller.getBoundingClientRect();
      const seen = all.filter((item) => {
        const box = item.getBoundingClientRect();
        return box.bottom > view.top && box.top < view.bottom;
      });
      next = (e.key === "ArrowDown" ? seen[0] : seen[seen.length - 1]) ?? (e.key === "ArrowDown" ? all[0] : all[all.length - 1]);
    }
    if (next === undefined) return;
    userScrolls();
    // An item kept drawn far from the view is brought to it as a row not
    // drawn would be, so the rows around it are drawn as it comes.
    const row = windowed ? next.closest<HTMLElement>("[data-row]") : null;
    if (row !== null && scroller !== null) {
      const view = scroller.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      if (box.bottom < view.top || box.top > view.bottom) await reveal(row.dataset.row!);
    }
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
  }

  /** The next thing to walk to past what is drawn, drawing the rows that
      way until one holds something; nothing at the end of the thread. */
  async function beyond(from: HTMLElement, down: boolean): Promise<HTMLElement | undefined> {
    for (;;) {
      const { from: first, to } = range();
      const at = down ? to : first - 1;
      if (at < 0 || at >= rows.length) return undefined;
      userScrolls();
      const row = await reveal(rows[at].key);
      if (row === null) return undefined;
      const all = items();
      const here = all.indexOf(from);
      const next = here === -1 ? undefined : all[here + (down ? 1 : -1)];
      if (next !== undefined) return next;
      const inside = all.filter((item) => row.contains(item));
      if (inside.length > 0) return down ? inside[0] : inside[inside.length - 1];
    }
  }

  function toFoot() {
    if (scroller === null) return;
    moves += 1;
    pinned = true;
    behind = false;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }

  function message(id: string): Message | null {
    return conversation.messages[id] ?? null;
  }

  /** The error a session ended with is said where it offers to resume,
      and not again at the foot of the thread. */
  let endedWith = $derived.by(() => {
    if (conversation.ended === null) return null;
    const last = conversation.entries[conversation.entries.length - 1];
    return last?.kind === "note" && last.tone === "error" ? last.key : null;
  });

  function visible(entry: Entry): boolean {
    if (entry.key === endedWith) return false;
    if (entry.kind !== "agent") return true;
    if (entry.parts.some(drawnPart) || entry.key === liveKey) return true;
    const turn = conversation.turns[entry.turn];
    return lastOfTurn.has(entry.key) && (turn?.outcome === "interrupted" || turn?.outcome === "failed");
  }

  /** Whether an entry draws anything: its own words, or the line where
      this run began after it. */
  function draws(entry: Entry): boolean {
    if (conversation.began !== null && entry.key === conversation.began.after) return true;
    if (entry.kind === "user") return message(entry.message) !== null;
    if (entry.kind === "note") return entry.key !== endedWith;
    return entry.kind === "compaction" || visible(entry);
  }

  /** The entries that draw something, in order: what the thread draws a
      window of. */
  let rows = $derived(conversation.entries.filter(draws));
  let rowAt = $derived(new Map(rows.map((entry, at) => [entry.key, at])));

  /** A thread of no more rows than this is drawn whole, as it costs
      little, and everything in it can be selected and read out at once. */
  const WHOLE_ROWS = 80;
  let windowed = $derived(rows.length > WHOLE_ROWS);

  /** The rows drawn, from the first to the last by key. Null until the
      thread has been looked at: then the last rows are drawn. */
  let win = $state<{ first: string; last: string; from: number; to: number } | null>(null);
  /** The space of the rows not drawn, above and below the rows drawn, and
      what the rows above add up to. The space above can stand off what
      they add up to: while the user scrolls it takes up what rows drawn
      above the view turned out to measure, so the view is not moved under
      them. It is what they add up to again once the first row is drawn. */
  let space = { above: 0, below: 0, base: 0 };
  const FIRST_DRAWN = 16;

  /** The rows drawn, as indices: from the first to just after the last. */
  function range(): { from: number; to: number } {
    const count = rows.length;
    if (!windowed) return { from: 0, to: count };
    if (win === null) return { from: Math.max(0, count - FIRST_DRAWN), to: count };
    const from = rowAt.get(win.first) ?? Math.min(win.from, count);
    const last = rowAt.get(win.last);
    const to = last === undefined ? Math.min(win.to, count) : last + 1;
    return to <= from ? { from: Math.max(0, count - FIRST_DRAWN), to: count } : { from, to };
  }

  let drawn = $derived.by(() => {
    const { from, to } = range();
    return rows.slice(from, to);
  });

  let box = $state<HTMLDivElement | null>(null);
  /** The height each row was last drawn at, by key. */
  const heights = new Map<string, number>();
  /** The rows a selection lies in, by key, which stay drawn while it does
      and the view is no more than `HELD_REACH` rows from them. */
  let held: [string, string] | null = null;
  const HELD_REACH = 150;
  /** The row being brought into view, which stays drawn until it is. */
  let sought: string | null = null;
  /** What stood at the top of the view and how far below the top, when
      the thread was last looked at, and where it was scrolled to: the
      first row reaching into the view, and the innermost block of it that
      does, so the line read is what stays when the row reflows. */
  let anchor: { key: string; offset: number; block: Element; blockOffset: number } | null = null;
  let lookedTop = 0;


  /** The innermost block of a row that reaches into the view from above. */
  function blockAt(row: Element, top: number): Element {
    let at = row;
    for (let depth = 0; depth < 12; depth++) {
      let next: Element | null = null;
      for (const child of at.children) {
        const box = child.getBoundingClientRect();
        if (box.height > 0 && box.bottom > top) {
          next = child;
          break;
        }
      }
      if (next === null) break;
      at = next;
    }
    return at;
  }

  function rowNodes(): HTMLElement[] {
    return box === null ? [] : [...box.querySelectorAll<HTMLElement>(":scope > [data-row]")];
  }

  /** The height of a row never drawn: what the first rows drawn
      averaged, kept from then on, so the space of the rows not drawn
      changes only as rows are drawn. */
  let guess: number | null = null;

  /** The height of a row: as it was last drawn, or the guess. */
  function heightOf(key: string): number {
    return heights.get(key) ?? guess ?? 140;
  }

  function gapOf(): number {
    return box === null ? 0 : parseFloat(getComputedStyle(box).rowGap) || 0;
  }

  /** Where a row's top stands below the top of the box the rows are in:
      as drawn for the rows drawn, reckoned from them for the rest. */
  function topOf(row: number, gap: number): number {
    const { from } = range();
    let offset = space.above;
    for (let at = from; at < row; at++) offset += heightOf(rows[at].key) + gap;
    for (let at = from - 1; at >= row; at--) offset -= heightOf(rows[at].key) + gap;
    return offset;
  }

  /** What the rows from `from` to just before `to` add up to. */
  function sum(from: number, to: number, gap: number): number {
    let total = 0;
    for (let at = from; at < to; at++) total += heightOf(rows[at].key) + gap;
    return total;
  }

  /** Draws the space of the rows not drawn; with `grow`, only where it
      grows. Before the rows drawn change, the space grows and does not
      shrink, and it takes its size once they have: the thread is never
      short of its height on the way, which WebKit would answer by pulling
      the view up to fit. */
  function paint(grow = false) {
    if (box === null) return;
    const above = grow ? Math.max(space.above, parseFloat(box.style.paddingTop) || 0) : space.above;
    const below = grow ? Math.max(space.below, parseFloat(box.style.paddingBottom) || 0) : space.below;
    box.style.paddingTop = `${above}px`;
    box.style.paddingBottom = `${below}px`;
  }

  /**
   * Takes in where the thread stands: the heights of the rows drawn, the
   * row at the top of the view, and which rows to draw for the view and a
   * screen above and below it, or for the foot while it follows. Rows a
   * selection lies in stay drawn while the view is not far from them, and
   * the keyboard leaves a row before it goes.
   */
  function look() {
    if (scroller === null || box === null || !windowed || !shown()) return;
    // What moved under the reader since the thread last looked is put back
    // before the place is taken again. A browser tells of a scroll at the
    // frame after it, and rows can move in between: a type size, a font or
    // a width coming in.
    if (!atFoot()) keep();
    const view = scroller.getBoundingClientRect();
    const nodes = rowNodes();
    anchor = null;
    for (const node of nodes) {
      const drawnAt = node.getBoundingClientRect();
      const key = node.dataset.row!;
      if (drawnAt.height > 0) heights.set(key, drawnAt.height);
      if (anchor === null && drawnAt.bottom > view.top) {
        const block = blockAt(node, view.top);
        anchor = { key, offset: drawnAt.top - view.top, block, blockOffset: block.getBoundingClientRect().top - view.top };
      }
    }
    if (guess === null && heights.size > 0) {
      let total = 0;
      for (const height of heights.values()) total += height;
      guess = total / heights.size;
    }
    lookedTop = scroller.scrollTop;
    const count = rows.length;
    if (count === 0) {
      win = null;
      space = { above: 0, below: 0, base: 0 };
      return;
    }
    const spare = Math.max(400, scroller.clientHeight);
    const gap = gapOf();
    let from: number;
    let to: number;
    // The foot is drawn while the thread follows it and the view is there;
    // anywhere else, what is drawn is what is around the view.
    if (atFoot()) {
      to = count;
      from = count;
      let filled = 0;
      while (from > 0 && filled < scroller.clientHeight + spare) {
        from -= 1;
        filled += heightOf(rows[from].key) + gap;
      }
    } else {
      // The view, a screen above and below it, measured from the top of
      // the box the rows are in.
      const seen = view.top - box.getBoundingClientRect().top;
      const start = seen - spare;
      const end = seen + scroller.clientHeight + spare;
      // From the first row drawn, back or on to the first row that reaches
      // into that, then on to the first past it.
      from = Math.min(range().from, count - 1);
      let top = topOf(from, gap);
      while (from > 0 && top > start) {
        from -= 1;
        top -= heightOf(rows[from].key) + gap;
      }
      while (from < count - 1 && top + heightOf(rows[from].key) < start) {
        top += heightOf(rows[from].key) + gap;
        from += 1;
      }
      to = from;
      while (to < count && top < end) {
        top += heightOf(rows[to].key) + gap;
        to += 1;
      }
      to = Math.max(to, from + 1);
    }
    // The rows a selection lies in, and the row the keyboard is on, stay
    // drawn while the view is not far from them.
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && box.contains(active) ? active.closest<HTMLElement>("[data-row]")?.dataset.row : undefined;
    const kept: [string, string][] = [];
    if (held !== null) kept.push(held);
    if (focused !== undefined) kept.push([focused, focused]);
    for (const [first, last] of kept) {
      const lo = rowAt.get(first);
      const hi = rowAt.get(last);
      if (lo !== undefined && hi !== undefined && Math.max(to, hi + 1) - Math.min(from, lo) <= to - from + HELD_REACH) {
        from = Math.min(from, lo);
        to = Math.max(to, hi + 1);
      }
    }
    const aim = sought === null ? undefined : rowAt.get(sought);
    if (aim !== undefined) {
      from = Math.min(from, aim);
      to = Math.max(to, aim + 1);
    }
    const base = sum(0, from, gap);
    const off = space.above - space.base;
    space = { above: from === 0 ? 0 : Math.max(0, base + off), below: sum(to, count, gap), base };
    const next = { first: rows[from].key, last: rows[to - 1].key, from, to };
    if (win !== null && win.first === next.first && win.last === next.last) {
      paint();
      return;
    }
    paint(true);
    // The keyboard does not go with a row the thread stops drawing, which
    // it does only once the view is far from it.
    const at = focused === undefined ? undefined : rowAt.get(focused);
    if (at !== undefined && (at < from || at >= to)) scroller.focus({ preventScroll: true });
    win = next;
  }

  /** Puts what stood at the top of the view back where it stood when the
      rows moved under it since the thread was looked at. A scroll since
      then, heard yet or not, is where the view is meant to be, and stays.
      While the user scrolls, the space above the rows drawn takes the
      change where it can: a scroll set then would stop theirs in WebKit. */
  function keep() {
    if (scroller === null || anchor === null || !shown()) return;
    const node = box?.querySelector<HTMLElement>(`:scope > [data-row="${CSS.escape(anchor.key)}"]`);
    if (node === null || node === undefined) return;
    // The block that stood there, or the row it was in when that block has
    // been drawn again since.
    const [kept, offset] = node.contains(anchor.block) ? [anchor.block, anchor.blockOffset] : [node, anchor.offset];
    const scrolled = scroller.scrollTop - lookedTop;
    const moved = kept.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset + scrolled;
    if (Math.abs(moved) < 0.5) return;
    const scrolling = dragging || performance.now() - scrolledBy < 1000 || performance.now() - glided < 1000;
    if (scrolling && range().from > 0 && space.above - moved >= 0) {
      space.above -= moved;
      paint();
      return;
    }
    const was = scroller.scrollTop;
    scroller.scrollTop += moved;
    ownTop = scroller.scrollTop;
    lookedTop += scroller.scrollTop - was;
  }

  // Once the rows drawn or the entries change: the foot while the thread
  // follows, what the reader looked at otherwise; then the rows for where
  // that leaves the view.
  let settling = 0;
  /** The last row when the rows drawn last changed. */
  let footThenKey: string | null = null;
  $effect(() => {
    void drawn;
    void win;
    untrack(() => {
      if (scroller === null) return;
      if (!windowed) {
        // Drawn whole, the thread is as a page is: the browser keeps the
        // reader's place, and its size says when to follow the foot. What
        // is drawn is kept as the window, so a thread that grows long goes
        // on from it.
        const first = rows[0]?.key;
        const last = rows[rows.length - 1]?.key;
        if (first === undefined || last === undefined) win = null;
        else if (win?.first !== first || win.last !== last) win = { first, last, from: 0, to: rows.length };
        space = { above: 0, below: 0, base: 0 };
        paint();
        return;
      }
      paint();
      // Where the user has scrolled counts before the thread moves.
      heard();
      // At its foot, the thread goes on to it, but not as a fold the user
      // opened there grows.
      const foot = rows[rows.length - 1]?.key ?? null;
      const came = foot !== footThenKey;
      footThenKey = foot;
      if (atFoot() && (came || performance.now() - touched > 400)) toEnd(scroller);
      else keep();
      // Drawing rows can call for others; a few rounds settle it.
      if (settling++ < 8) look();
      queueMicrotask(() => (settling = 0));
    });
  });

  // A selection holds the rows it lies in drawn.
  $effect(() => {
    const changed = () => {
      const selection = document.getSelection();
      const was = held;
      held = null;
      if (selection !== null && !selection.isCollapsed && box !== null) {
        const rowOf = (node: Node | null) =>
          (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-row]") ?? null;
        const ends = [rowOf(selection.anchorNode), rowOf(selection.focusNode)].filter(
          (row): row is HTMLElement => row !== null && box!.contains(row),
        );
        if (ends.length > 0) {
          const at = ends.map((row) => rowAt.get(row.dataset.row!) ?? 0).sort((a, b) => a - b);
          held = [rows[at[0]].key, rows[at[at.length - 1]].key];
        }
      }
      if (was !== null && held === null) look();
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  });

  /**
   * Brings an entry into view, drawing it if it is not, and gives back
   * what it is drawn as: for find, and for opening the thread at a call.
   * The thread stops following its foot unless the entry is at it. With
   * `inside`, what in the entry matches it is what comes into view, and
   * the thread stops following its foot wherever the entry is, so what
   * comes after it in the same run leaves it where it was put.
   */
  export async function reveal(
    key: string,
    block: ScrollLogicalPosition = "nearest",
    inside: string | null = null,
  ): Promise<HTMLElement | null> {
    const at = rowAt.get(key);
    if (at === undefined || scroller === null || box === null) return null;
    moves += 1;
    if (at < rows.length - 1 || inside !== null) {
      pinned = false;
      behind = false;
    }
    const find = () => box?.querySelector<HTMLElement>(`:scope > [data-row="${CSS.escape(key)}"]`) ?? null;
    sought = key;
    try {
      if (find() === null) {
        // To where the row is reckoned to stand, so the rows drawn with
        // it are the ones around it.
        const top = box.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        scroller.scrollTop = top + topOf(at, gapOf());
        ownTop = scroller.scrollTop;
        look();
        await tick();
      }
      const row = find();
      ((inside === null ? null : row?.querySelector<HTMLElement>(inside)) ?? row)?.scrollIntoView({ block });
      ownTop = scroller.scrollTop;
    } finally {
      sought = null;
    }
    look();
    await tick();
    return find();
  }

  // Room at the top comes and goes without moving what is in view: only a
  // thread at its top shows it.
  let roomWas = 0;
  $effect(() => {
    const now = room;
    untrack(() => {
      if (scroller === null || now === roomWas) return;
      const by = now - roomWas;
      roomWas = now;
      const top = scroller.scrollTop;
      scroller.style.setProperty("--room", `${now}px`);
      if (top <= 0) return;
      scroller.scrollTop = top + by;
      if (ownTop === top) ownTop = scroller.scrollTop;
      if (lookedTop === top) lookedTop = scroller.scrollTop;
      lastTop = scroller.scrollTop;
    });
  });

  /** The first row reaching into the view from above: where a search
      for new words starts. */
  export function topRow(): string | null {
    if (scroller === null) return null;
    const top = scroller.getBoundingClientRect().top;
    for (const node of rowNodes()) if (node.getBoundingClientRect().bottom > top) return node.dataset.row ?? null;
    return null;
  }

  /**
   * Puts what find found in the middle of the view, and into view across
   * a block that scrolls sideways. It glides there from near, and is there
   * at once from further than a screen away or where the system asks for
   * less motion. Rows drawn on the way can cut a glide short, so once the
   * thread is still the match is put in the middle at once if it is not
   * there, unless the user has scrolled since. `range` gives the match as
   * it is drawn then. The thread stops following its foot.
   */
  export async function center(range: () => Range | null) {
    const first = range();
    if (first === null || scroller === null) return;
    const began = performance.now();
    const mine = ++moves;
    if (!place(first, true)) return;
    await still();
    if (scroller === null || scrolledBy > began || moves !== mine) return;
    const again = range();
    if (again === null) return;
    const at = again.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (Math.abs(at.top + at.height / 2 - (view.top + view.height / 2)) > view.height / 4) place(again, false);
  }

  /** Scrolls a range to the middle of the view; answers whether it
      glides there. */
  function place(range: Range, glides: boolean): boolean {
    if (scroller === null) return false;
    const at = range.getBoundingClientRect();
    if (at.width === 0 && at.height === 0) return false;
    const view = scroller.getBoundingClientRect();
    const by = at.top + at.height / 2 - (view.top + view.height / 2);
    const glide = glides && !reduced() && Math.abs(by) <= scroller.clientHeight;
    const across = range.startContainer.parentElement?.closest<HTMLElement>("pre, [data-testid='diff']") ?? null;
    if (across !== null && across.scrollWidth > across.clientWidth) {
      const side = across.getBoundingClientRect();
      if (at.left < side.left || at.right > side.right)
        across.scrollTo({ left: across.scrollLeft + at.left - side.left - side.width / 3, behavior: glide ? "smooth" : "instant" });
    }
    if (Math.abs(by) < 1) return false;
    pinned = false;
    const top = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + by));
    ownTop = top;
    // While it glides, rows drawn above the view take up their own
    // difference in height, as while the user scrolls, so nothing set
    // stops the glide.
    if (glide) glided = performance.now();
    scroller.scrollTo({ top, behavior: glide ? "smooth" : "instant" });
    return glide;
  }

  /** Waits until the thread has not moved for a few frames, or a second
      and a half has gone. */
  function still(): Promise<void> {
    return new Promise((resolve) => {
      let last = scroller?.scrollTop ?? 0;
      let same = 0;
      let left = 90;
      const check = () => {
        const now = scroller?.scrollTop ?? 0;
        same = now === last ? same + 1 : 0;
        last = now;
        left -= 1;
        if (same >= 3 || left <= 0) resolve();
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  /** How many times the thread was sent somewhere on purpose: to a match,
      to an entry, or to its foot. */
  let moves = 0;

  /** When find last set the thread gliding. */
  let glided = Number.NEGATIVE_INFINITY;

  /**
   * What a screen reader hears of a long thread. Its log says nothing
   * itself there, since rows drawn as the reader scrolls would be read out
   * as if they had just come; what comes while the thread is open is said
   * here instead: a message, a block of the agent's text once it is whole,
   * and a note.
   */
  let said = $state("");
  const opened = Date.now();
  const told = new Set<string>();

  function plain(markdown: string): string {
    const made = document.createElement("template");
    made.innerHTML = renderSaid(markdown);
    return (made.content.textContent ?? "").trim();
  }

  function announce() {
    if (!windowed) return;
    const fresh = toHear(conversation, told, opened, {
      message: (message) => spoken(message.text, sender?.(message) == null).text,
      block: plain,
    });
    if (fresh.length > 0) said = fresh.join("\n\n");
  }

  /** Where this run began, when its line stands at the top: nothing
      before it is drawn yet, or nothing was found. */
  let beganAtTop = $derived(conversation.began !== null && conversation.began.after === null);

  /** Every time the thread shows, as it writes it, by what it is shown
      on: a message by its id, a run by its key, and the line where this
      run began, which always names its day. */
  let written = $derived.by(() => {
    const keys: string[] = [];
    const times: { at: number; day?: boolean }[] = [];
    const add = (key: string, at: number | null, day = false) => {
      if (at === null) return;
      keys.push(key);
      times.push({ at, day });
    };
    const began = conversation.began;
    if (began !== null && began.after === null) add("began", began.at, true);
    for (const entry of conversation.entries) {
      if (entry.kind === "user") {
        const said = conversation.messages[entry.message];
        if (said !== undefined) add(`m:${said.id}`, said.at ?? timeOf(said.id));
      } else if (entry.kind === "agent" && visible(entry)) add(`e:${entry.key}`, entry.at);
      if (began !== null && began.after === entry.key) add("began", began.at, true);
    }
    for (const said of conversation.waiting) add(`m:${said.id}`, said.at ?? timeOf(said.id));
    const shown = stamps(times);
    return new Map(keys.map((key, at) => [key, shown[at]]));
  });
</script>

<div class="frame">
<!-- One stop for Tab, walked with the arrows; the pointer handlers only
     note that the user acted in the thread. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="thread"
  class:foot={conversation.earlier === "loading" || conversation.earlier === "read"}
  class:windowed
  bind:this={scroller}
  onscroll={() => {
    onscroll();
    look();
  }}
  onpointerdown={(e) => {
    touched = performance.now();
    // A press on the scrollbar itself scrolls, until it is let go. The
    // scrollbar is at the thread's right edge, over it where it overlays;
    // a press on the thread's own margin elsewhere scrolls nothing.
    if (scroller !== null && e.target === scroller && e.offsetX >= scroller.clientWidth - 16) {
      userScrolls();
      dragging = true;
      const up = () => {
        dragging = false;
        userScrolls();
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    }
  }}
  onkeydown={onThreadKey}
  onwheel={userScrolls}
  ontouchmove={userScrolls}
  role="log"
  aria-live={windowed ? "off" : undefined}
  aria-label="The conversation"
  data-testid="thread"
  tabindex="0"
>
  <div class="col" bind:this={col}>
    {#if conversation.earlierCut}
      <p class="intro" data-testid="earlier-cut">The start of this conversation is too long to show here.</p>
    {/if}
    {#if (conversation.late && conversation.earlier !== "loading") || (intro !== null && conversation.entries.length === 0 && conversation.waiting.length === 0 && conversation.began === null && conversation.earlier !== "loading")}
      <p class="intro" data-testid="thread-intro">
        {conversation.late ? `Earlier messages of this session ${notRead(conversation.earlierWhy)}` : intro}
      </p>
    {/if}
    {#if conversation.earlier === "loading"}
      <p class="now reading" data-testid="earlier-reading"><span class="caret"></span>Reading the earlier messages</p>
    {:else if conversation.earlier === "read" && beganAtTop}
      <p class="note" data-testid="earlier-none">
        <Icon name="info" size={13} />No earlier messages were found for this session.
      </p>
    {/if}
    {#if beganAtTop}
      {@render runBegan()}
    {/if}

    {#if rows.length > 0}
    <div class="rows" bind:this={box} data-testid="thread-rows">
    {#each drawn as entry (entry.key)}
      <div class="row" data-row={entry.key}>
      {#if entry.kind === "user"}
        {@const said = message(entry.message)}
        {#if said !== null}
          {@render userMessage(said)}
        {/if}
      {:else if entry.kind === "agent" && visible(entry)}
        {@const turn = conversation.turns[entry.turn]}
        {@const live = entry.key === liveKey}
        {@const doing = live ? nowDoing(conversation, entry.parts) : null}
        <article class="msg agent" data-testid="agent-run" data-turn={entry.turn} data-copy-host="message">
          <header class="who">
            <i class="mark"></i><b><Plain text={speaker(conversation, models ? (turn?.model ?? null) : null, agent)} /></b>
            {#if entry.at !== null}<time class="num">{written.get(`e:${entry.key}`) ?? clock(entry.at)}</time>{/if}
            {#if entry.parts.some((part) => part.kind === "text" && part.text.trim() !== "")}
              <Copy label="Copy as Markdown" text={() => replyMarkdown(entry.parts)} host="message" place="end" testid="copy-reply" />
            {/if}
          </header>
          <Parts parts={entry.parts} {root} />
          <Started ids={startedIds(entry.parts)} />
          {#if live && doing !== null}
            <p class="now" data-testid="now"><span class="caret"></span><Plain text={doing} /></p>
          {/if}
          {#if lastOfTurn.has(entry.key) && turn?.outcome === "interrupted"}
            <p class="outcome" data-testid="turn-outcome">Interrupted</p>
          {:else if lastOfTurn.has(entry.key) && turn?.outcome === "failed"}
            <p class="outcome bad" data-testid="turn-outcome">
              The turn failed{#if turn.error}: <Plain text={turn.error} />{:else}.{/if}
            </p>
          {/if}
        </article>
      {:else if entry.kind === "note" && entry.key !== endedWith}
        <p class="note {entry.tone}" data-testid="note" data-find={entry.key}>
          <Icon name={entry.tone === "info" ? "info" : "warn"} size={13} /><Plain text={entry.text} />
        </p>
      {:else if entry.kind === "compaction"}
        <div class="divider" data-testid="compaction">
          <span>
            {#if !entry.done}
              Compacting the conversation…
            {:else if entry.failed}
              Not compacted{#if entry.error !== null}: <Plain text={entry.error} />{/if}
            {:else}
              Conversation compacted{entry.reason === "full" ? ", the context was full" : ""}{#if entry.tokensBefore !== null && entry.tokensAfter !== null}<span class="num"> · {tokens(entry.tokensBefore)} → {tokens(entry.tokensAfter)} tokens</span>{/if}
            {/if}
          </span>
        </div>
      {/if}
      {#if conversation.began !== null && entry.key === conversation.began.after}
        {@render runBegan()}
      {/if}
      </div>
    {/each}
    </div>
    {/if}

    {#each conversation.waiting as said (said.id)}
      {@render userMessage(said)}
    {/each}
  </div>
</div>

<p class="told" aria-live="polite" data-testid="thread-said">{said}</p>

{#if behind}
  <button class="latest" tabindex="0" onclick={toFoot} data-testid="jump-latest">
    <Icon name="down" size={12} />Latest
  </button>
{/if}
</div>

{#snippet runBegan()}
  {#if conversation.began !== null}
    <div class="divider" data-testid="run-began">
      <span>Resumed here, <time class="num">{written.get("began") ?? clock(conversation.began.at)}</time></span>
    </div>
  {/if}
{/snippet}

<!-- A message to the agent: the user's, another session's under its name,
     or the workbench's own, sent to a session that was idle, which says
     what the sessions it started did, each by the name its row has. -->
{#snippet userMessage(said: Message)}
  {@const from = sender?.(said) ?? null}
  {@const at = said.at ?? timeOf(said.id)}
  {@const words = from?.workbench
    ? { text: wakeShown(said.text, sessionName) ?? said.text, instructions: null, reports: null }
    : spoken(said.text, from === null)}
  {@const putBack = from?.workbench ? undefined : onPutBack}
  <article
    class="msg you"
    class:from={from !== null}
    class:waiting={!said.placed}
    class:dropped={said.state === "dropped" || said.state === "failed"}
    data-testid="user-message"
    data-state={said.state}
    data-from={from?.workbench ? "workbench" : from?.id}
    data-copy-host="message"
  >
    <header class="who">
      {#if from === null}
        {#if words.text !== ""}
          <Copy label="Copy" name="Copy the message" text={() => unsent(words.text, mentionsOf(said.id)).draft} host="message" testid="copy-message" />
        {/if}
        <b>You</b>
      {:else}
        <span>From</span><span class="sender" data-testid="message-sender"><Plain text={from.name} /></span>
        {#if from.key !== null}<button class="link go" tabindex="-1" data-thread-item onclick={() => goToSender(from)} data-testid="message-sender-go"
            >Go to it</button
          >{/if}
      {/if}
      {#if at !== null}<time class="num">{written.get(`m:${said.id}`) ?? clock(at)}</time>{/if}
      {#if from !== null && words.text !== ""}
        <Copy label="Copy" name="Copy the message" text={() => unsent(words.text, mentionsOf(said.id)).draft} host="message" place="end" testid="copy-message" />
      {/if}
    </header>
    <div class="bubble">
      {#if said.images.length > 0}
        <div class="images">
          {#each said.images as image, at (at)}
            <img src="data:{image.mediaType};base64,{image.data}" alt="Attached image {at + 1}" />
          {/each}
        </div>
      {/if}
      {#if words.text !== ""}<p data-find={said.id}
          >{#each sentParts(words.text, mentionsOf(said.id)) as part, at (at)}{#if part.path === undefined}<Plain text={part.text} />{:else}{@const open =
                opener?.(part.path) ?? null}{#if open === null}<span class="mention" data-testid="message-mention"
                  ><Plain text={part.text} /></span
                >{:else}<button
                  class="mention link-file"
                  tabindex="-1"
                  data-thread-item
                  title="Open {part.path}"
                  onclick={open}
                  data-testid="message-mention"><Plain text={part.text} /></button
                >{/if}{/if}{/each}</p
        >{/if}
    </div>
    {#if words.reports !== null}
      {@const shown = `${said.id}:reports`}
      <button
        class="link instructions"
        tabindex="-1"
        data-thread-item
        onclick={() => (unfolded[shown] = !unfolded[shown])}
        aria-expanded={unfolded[shown] === true}
        data-testid="workbench-reports">Reports from the workbench</button
      >
      {#if unfolded[shown]}<p class="state reports" data-testid="workbench-reports-text"
          >{reportsShown(words.reports, sessionName)}</p
        >{/if}
    {/if}
    {#if words.instructions !== null}
      <button
        class="link instructions"
        tabindex="-1"
        data-thread-item
        onclick={() => (unfolded[said.id] = !unfolded[said.id])}
        aria-expanded={unfolded[said.id] === true}
        data-testid="workbench-instructions">Instructions from the workbench</button
      >
      {#if unfolded[said.id]}<p class="state" data-testid="workbench-instructions-text">{words.instructions}</p>{/if}
    {/if}
    {#if said.state === "queued"}
      {@const last = waiting !== undefined && said.id === lastQueued}
      {@const send = waiting !== undefined && last && waiting.canSend}
      {@const take = waiting !== undefined && from === null && waiting.canTake}
      <p class="state" data-testid="message-waiting">
        {waiting?.line ?? "Waiting for the agent to finish what it is doing"}{#if waiting !== undefined && (send || take)}<span
            class="acts"
            >{#if send}<button
                class="link"
                tabindex="-1"
                data-thread-item
                onclick={waiting.sendNow}
                title={waiting.title}
                aria-label="Send the waiting messages now"
                data-testid="send-now">Send now</button
              >{/if}{#if take}<button
                class="link"
                tabindex="-1"
                data-thread-item
                onclick={() => waiting.takeBack(said)}
                title={said.id === newestOwn && waiting.takeChord !== "" ? `${waiting.takeTitle} (${waiting.takeChord})` : waiting.takeTitle}
                aria-label="Take back “{shortly(words.text)}”"
                data-testid="take-back">Take back</button
              >{/if}</span
          >{/if}
      </p>
    {:else if said.state === "sending"}
      <p class="state">Sending</p>
    {:else if said.state === "dropped"}
      <p class="state bad">
        Not answered{#if said.error}: <Plain text={said.error} />{/if}
        {#if putBack}
          <button class="link" tabindex="-1" data-thread-item onclick={() => putBack(said)} data-testid="put-back">Put back in the composer</button>
        {/if}
      </p>
    {:else if said.state === "failed"}
      <p class="state bad">
        Not sent{#if said.error}: <Plain text={said.error} />{/if}
        {#if putBack}
          <button class="link" tabindex="-1" data-thread-item onclick={() => putBack(said)} data-testid="put-back">Put back in the composer</button>
        {/if}
      </p>
    {/if}
  </article>
{/snippet}

<style>
  .frame {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* What is placed inside it, such as the words a Copy button says to a
     screen reader, scrolls with it and adds nothing to the pane's own
     size. Its room, less in a narrow pane, comes with the pane's width in
     the same layout, so a change of width moves the rows once. */
  .thread {
    /* The thread's rhythm: the room between two messages, which is also
       the room under the last before the dock or the composer. */
    --thread-gap: 22px;
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: calc(max(16px, min(22px, var(--conv-wide))) + var(--room, 0px))
      max(14px, min(var(--conv-gutter), var(--conv-wide))) var(--thread-gap);
  }

  /* A long thread keeps the reader's place itself, the same in every
     engine, as rows are drawn and left out around the view. */
  .thread.windowed,
  .thread.windowed :global(*) {
    overflow-anchor: none;
  }

  /* Heard, not seen. */
  .told {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: pre-wrap;
  }

  /* A thread that has earlier messages coming or read sits at the pane's
     foot while it is shorter than the pane, so what is read and laid above
     moves nothing under it. */
  .thread.foot {
    display: flex;
    flex-direction: column;
  }

  .col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--thread-gap);
    font-size: var(--conv-size);
    line-height: 1.58;
    color: var(--ink);
  }

  .thread.foot .col {
    width: 100%;
    margin-top: auto;
  }

  .rows,
  .row {
    display: flex;
    flex-direction: column;
    gap: var(--thread-gap);
    min-width: 0;
  }

  .intro {
    margin: 0;
    font-size: var(--conv-small);
    color: var(--ink-2);
    text-align: center;
  }

  .msg {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .who {
    display: flex;
    align-items: center;
    gap: 7px;
    font-family: var(--chrome);
    font-size: var(--conv-meta);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-2);
  }

  .who b {
    font-weight: 600;
    color: var(--ink);
  }

  .num {
    font-variant-numeric: tabular-nums;
  }

  .mark {
    width: 9px;
    height: 9px;
    border-radius: min(3px, var(--radius));
    background: var(--accent);
  }

  .you {
    align-items: flex-end;
  }

  /* A message of the user's own takes more of a narrow row, one 492px
     wide or narrower, as every row in a pane of 520px or less is. The row
     decides, in the same layout as the pane's width. */
  .bubble {
    max-width: max(min(82%, var(--conv-measure)), min(92%, calc((492.5px - 100%) * 1000)));
    padding: 9px 13px;
    border-radius: calc(var(--radius) * 2) calc(var(--radius) * 2) var(--radius-sm)
      calc(var(--radius) * 2);
    background: var(--accent-soft);
    color: var(--ink);
    user-select: text;
    -webkit-user-select: text;
  }

  .bubble p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* A file the message mentions, in the accent; one the viewer shows
     opens there. */
  .mention {
    color: var(--accent);
  }

  .link-file {
    display: inline;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: inherit;
    white-space: inherit;
    overflow-wrap: inherit;
    cursor: pointer;
  }

  .link-file:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .images img {
    max-width: 160px;
    max-height: 120px;
    border-radius: var(--radius-sm);
    object-fit: cover;
  }

  /* What the workbench or another session sent stands on the left, with
     everything not the user's: no bubble, in the quieter ink of the
     thread's own notes, lined up with the agent's text, so it reads as a
     notice from the app rather than as the user's words or the agent's. */
  .you.from {
    align-items: stretch;
    padding-left: 18px;
  }

  .you.from .bubble {
    max-width: none;
    padding: 0;
    border-radius: 0;
    background: none;
    color: var(--ink-2);
  }

  .you.from.waiting .bubble {
    box-shadow: none;
  }

  .you.from .state {
    text-align: left;
  }

  .you.from .link.instructions {
    align-self: flex-start;
  }

  .who .sender {
    font-weight: 600;
    color: var(--ink);
    text-transform: none;
    letter-spacing: normal;
  }

  .who .go {
    margin-left: 0;
  }

  .link.instructions {
    margin: -2px 0 0;
    font-size: var(--conv-fine);
    color: var(--ink-2);
  }

  .link.instructions:hover {
    color: var(--ink);
  }

  .state.reports {
    white-space: pre-line;
  }

  .you.waiting .bubble {
    background: none;
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .you.dropped .bubble {
    opacity: 0.65;
  }

  .state {
    margin: -2px 0 0;
    font-size: var(--conv-fine);
    color: var(--ink-2);
    text-align: right;
  }

  .state.bad {
    color: var(--del);
  }

  .link {
    margin-left: 6px;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }

  /* The actions on a waiting line wrap as one, never apart. Each has room
     inside it for the focus ring, which is drawn inside it, as everywhere,
     so the ring keeps off its words and off the row above; the last one's
     words end where the line's own would. */
  .acts {
    display: inline-block;
    margin: 0 -4px 0 2px;
    white-space: nowrap;
  }

  .acts .link {
    margin-left: 0;
    padding: 0 4px;
    border-radius: var(--radius-sm);
  }

  .agent {
    padding-left: 16px;
    border-left: 2px solid var(--rule);
  }

  .now {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: var(--conv-small);
    color: var(--ink-2);
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .now.reading {
    justify-content: center;
  }

  .caret {
    flex: none;
    width: 7px;
    height: 14px;
    border-radius: 2px;
    background: var(--accent);
    animation: breathe 1.1s ease-in-out infinite;
  }

  .outcome {
    margin: 0;
    font-size: var(--conv-meta);
    color: var(--ink-2);
  }

  .outcome.bad {
    color: var(--del);
  }

  .note {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 0;
    font-size: var(--conv-meta);
    color: var(--ink-2);
    text-align: center;
  }

  .note.warning {
    color: var(--ink-2);
  }

  .note.error {
    color: var(--del);
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--conv-meta);
    color: var(--ink-2);
  }

  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--rule);
  }

  .latest {
    position: absolute;
    left: 50%;
    bottom: 10px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border: 1px solid var(--divider, var(--rule));
    border-radius: calc(var(--radius) * 4);
    background: var(--paint-surface);
    box-shadow: 0 4px 14px color-mix(in srgb, black 14%, transparent);
    font: inherit;
    font-size: var(--conv-meta);
    color: var(--ink-2);
    cursor: pointer;
    z-index: 2;
  }

  .latest:hover {
    color: var(--ink);
  }

  @keyframes breathe {
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .caret {
      animation: none;
    }
  }
</style>
