<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Conversation, Entry, Message } from "$lib/conversation.svelte";
  import { clock, nowDoing, speaker, stamps, startedIds, tokens } from "$lib/thread";
  import { reportsShown, spoken } from "$lib/instructions";
  import { sessionName, timeOf, type Sender } from "$lib/senders.svelte";
  import { focusPane } from "$lib/layout.svelte";
  import { shareFolds } from "$lib/folds";
  import { goTo } from "$lib/workspace.svelte";
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
   * Only the entries in and near the view are drawn; the space of the
   * others stands above and below them at the height they were drawn at,
   * or at the height drawn entries average before they ever were. What the
   * reader looks at stays where it is when anything drawn above it changes
   * height or entries come above it.
   */
  interface Props {
    conversation: Conversation;
    /** The folder paths in the thread are shown from. */
    root: string | null;
    /** What stands above a thread with nothing in it yet. */
    intro: string | null;
    /** The agent's own name, for a run on its default model. */
    agent: string;
    /** A message that failed to send is taken back into the composer. */
    onPutBack?: (message: Message) => void;
    /** The session that sent a message, or null for the user. */
    sender?: (message: Message) => Sender | null;
  }

  let { conversation, root, intro, agent, onPutBack, sender }: Props = $props();

  shareFolds(() => conversation.opened);

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
      heard();
      // Which rows to draw is worked out again a frame on: drawing them
      // now would change the size this has just been told of.
      requestAnimationFrame(look);
      if (!pinned) {
        keep();
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

  /** Where the thread last scrolled itself to: a scroll that lands there
      is its own, and says nothing of where the user wants to be. */
  let ownTop = Number.NEGATIVE_INFINITY;

  function toEnd(node: HTMLDivElement) {
    node.scrollTop = node.scrollHeight;
    ownTop = node.scrollTop;
  }

  /** When the user last scrolled the thread themselves: the wheel, a
      touch, a key that scrolls, or the scrollbar. */
  let scrolledBy = Number.NEGATIVE_INFINITY;
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
    if (scroller !== null && scroller.scrollTop !== lastTop) onscroll();
  }

  function onscroll() {
    if (scroller === null) return;
    const top = scroller.scrollTop;
    const down = top >= lastTop - 1;
    lastTop = top;
    // Only the user decides whether the thread follows. The thread's own
    // scroll to its foot can be heard after more has come, and the browser
    // moves the view itself to keep its place while text is drawn again;
    // neither is the user leaving the foot.
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
      next = home ? (inside[0] ?? all[0]) : (inside[inside.length - 1] ?? all[all.length - 1]);
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
    if (entry.parts.length > 0 || entry.key === liveKey) return true;
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
  /** The row at the top of the view and how far below the top it stood,
      when the thread was last looked at, and where it was scrolled to. */
  let anchor: { key: string; offset: number } | null = null;
  let lookedTop = 0;

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
    if (scroller === null || box === null) return;
    const view = scroller.getBoundingClientRect();
    const nodes = rowNodes();
    anchor = null;
    for (const node of nodes) {
      const drawnAt = node.getBoundingClientRect();
      const key = node.dataset.row!;
      if (drawnAt.height > 0) heights.set(key, drawnAt.height);
      if (anchor === null && drawnAt.bottom > view.top) anchor = { key, offset: drawnAt.top - view.top };
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
    if (pinned) {
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
    if (held !== null) {
      const first = rowAt.get(held[0]);
      const last = rowAt.get(held[1]);
      if (first !== undefined && last !== undefined && Math.max(to, last + 1) - Math.min(from, first) <= to - from + HELD_REACH) {
        from = Math.min(from, first);
        to = Math.max(to, last + 1);
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
    // The keyboard does not go with a row the thread stops drawing.
    const active = document.activeElement;
    if (active instanceof HTMLElement && box.contains(active)) {
      const row = active.closest<HTMLElement>("[data-row]");
      const at = row === null ? undefined : rowAt.get(row.dataset.row!);
      if (at !== undefined && (at < from || at >= to)) scroller.focus({ preventScroll: true });
    }
    win = next;
  }

  /** Puts the row at the top of the view back where it stood, unless the
      user scrolled since the thread was looked at, which is where they
      want to be. While the user scrolls, the space above the rows drawn
      takes the change where it can: a scroll set then would stop theirs
      in WebKit. */
  function keep() {
    if (scroller === null || anchor === null || scroller.scrollTop !== lookedTop) return;
    const node = box?.querySelector<HTMLElement>(`:scope > [data-row="${CSS.escape(anchor.key)}"]`);
    if (node === null || node === undefined) return;
    const moved = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(moved) < 0.5) return;
    if (performance.now() - scrolledBy < 1000 && range().from > 0 && space.above - moved >= 0) {
      space.above -= moved;
      paint();
      return;
    }
    scroller.scrollTop += moved;
    ownTop = scroller.scrollTop;
    lookedTop = scroller.scrollTop;
  }

  // Once the rows drawn or the entries change: the foot while the thread
  // follows, what the reader looked at otherwise; then the rows for where
  // that leaves the view.
  let settling = 0;
  $effect(() => {
    void drawn;
    void win;
    untrack(() => {
      if (scroller === null) return;
      paint();
      // Where the user has scrolled counts before the thread moves.
      heard();
      if (pinned && performance.now() - touched > 400) toEnd(scroller);
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
   * The thread stops following its foot unless the entry is at it.
   */
  export async function reveal(key: string, block: ScrollLogicalPosition = "nearest"): Promise<HTMLElement | null> {
    const at = rowAt.get(key);
    if (at === undefined || scroller === null || box === null) return null;
    if (at < rows.length - 1) pinned = false;
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
      find()?.scrollIntoView({ block });
      ownTop = scroller.scrollTop;
    } finally {
      sought = null;
    }
    look();
    await tick();
    return find();
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
  bind:this={scroller}
  onscroll={() => {
    onscroll();
    look();
  }}
  onpointerdown={(e) => {
    touched = performance.now();
    // A press on the scrollbar itself scrolls.
    if (e.target === scroller) userScrolls();
  }}
  onkeydown={onThreadKey}
  onwheel={userScrolls}
  ontouchmove={userScrolls}
  role="log"
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
        {conversation.late ? "Earlier messages of this session are in its transcript and are not shown here." : intro}
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
        <article class="msg agent" data-testid="agent-run" data-turn={entry.turn}>
          <header class="who">
            <i class="mark"></i><b><Plain text={speaker(conversation, turn?.model ?? null, agent)} /></b>
            {#if entry.at !== null}<time class="num">{written.get(`e:${entry.key}`) ?? clock(entry.at)}</time>{/if}
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
        <p class="note {entry.tone}" data-testid="note">
          <Icon name={entry.tone === "info" ? "info" : "warn"} size={13} /><Plain text={entry.text} />
        </p>
      {:else if entry.kind === "compaction"}
        <div class="divider" data-testid="compaction">
          <span>
            {#if !entry.done}
              Compacting the conversation…
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

{#snippet userMessage(said: Message)}
  {@const from = sender?.(said) ?? null}
  {@const at = said.at ?? timeOf(said.id)}
  {@const words = spoken(said.text, from === null)}
  <article
    class="msg you"
    class:from={from !== null}
    class:waiting={!said.placed}
    class:dropped={said.state === "dropped" || said.state === "failed"}
    data-testid="user-message"
    data-state={said.state}
    data-from={from?.id}
  >
    <header class="who">
      {#if from === null}
        <b>You</b>
      {:else}
        <span>From</span><span class="sender" data-testid="message-sender"><Plain text={from.name} /></span>
        {#if from.key !== null}<button class="link go" tabindex="-1" data-thread-item onclick={() => goToSender(from)} data-testid="message-sender-go"
            >Go to it</button
          >{/if}
      {/if}
      {#if at !== null}<time class="num">{written.get(`m:${said.id}`) ?? clock(at)}</time>{/if}
    </header>
    <div class="bubble">
      {#if said.images.length > 0}
        <div class="images">
          {#each said.images as image, at (at)}
            <img src="data:{image.mediaType};base64,{image.data}" alt="Attached image {at + 1}" />
          {/each}
        </div>
      {/if}
      {#if words.text !== ""}<p><Plain text={words.text} /></p>{/if}
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
      <p class="state" data-testid="message-waiting">Waiting for the agent to finish what it is doing</p>
    {:else if said.state === "sending"}
      <p class="state">Sending</p>
    {:else if said.state === "dropped"}
      <p class="state bad">
        Not answered{#if said.error}: <Plain text={said.error} />{/if}
        {#if onPutBack}
          <button class="link" tabindex="-1" data-thread-item onclick={() => onPutBack(said)} data-testid="put-back">Put back in the composer</button>
        {/if}
      </p>
    {:else if said.state === "failed"}
      <p class="state bad">
        Not sent{#if said.error}: <Plain text={said.error} />{/if}
        {#if onPutBack}
          <button class="link" tabindex="-1" data-thread-item onclick={() => onPutBack(said)} data-testid="put-back">Put back in the composer</button>
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

  /* The thread keeps the reader's place itself, the same in every engine,
     as rows are drawn and left out around the view. */
  .thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-anchor: none;
    padding: 22px 24px 12px;
  }

  @container conversation (max-width: 520px) {
    .frame .thread {
      padding: 16px 14px 10px;
    }

    .you .bubble {
      max-width: 92%;
    }
  }

  /* A thread that has earlier messages coming or read sits at the pane's
     foot while it is shorter than the pane, so what is read and laid above
     moves nothing under it. */
  .thread.foot {
    display: flex;
    flex-direction: column;
  }

  .col {
    max-width: 740px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 22px;
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
    gap: 22px;
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

  .bubble {
    max-width: 82%;
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

  /* Another session's words: a plain bubble, so they never read as the
     user's own. */
  .you.from .bubble {
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--rule);
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
    background: var(--surface);
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
