<script lang="ts">
  /**
   * The window's left edge in compact mode, where the sessions pane is not
   * in the layout. The pointer reaching the edge, however fast, or leaving
   * the window by it, slides the pane in over the panes; the pointer away
   * from the pane for a moment, or a press outside it, sends it back,
   * unless something in it holds it there: a menu, the new-session choice,
   * a question, a press, or the keyboard. While a session waits for the
   * user, a quiet mark on the edge says so.
   *
   * The edge is told from where the pointer is seen, not from an element
   * along it: a quick move is seen at only a few points, and may be seen
   * last well inside the window, leave it between two of them, or come to
   * rest against the screen's edge where the page hears no more of it.
   */
  import { untrack } from "svelte";
  import { AWAY_AFTER, EDGE_AFTER, EDGE_WIDTH, compact } from "$lib/compact.svelte";
  import { core } from "$lib/core";
  import { layout, peekSessions } from "$lib/layout.svelte";
  import { sessions } from "$lib/sessions.svelte";

  interface Seen {
    x: number;
    y: number;
    t: number;
  }

  /** Where the pointer was last seen in the window and where it was the
      time before: none until it is seen to move, and none again once it
      has left the window. Whether it went out by the left edge and has not
      come back. */
  let at: Seen | null = null;
  let before: Seen | null = null;
  let outLeft = false;

  /** Whether a point is on the window's left edge, at any height. */
  function onEdge(x: number, y: number): boolean {
    return x <= EDGE_WIDTH && y >= 0 && y < window.innerHeight;
  }

  /** Whether the line from one point through another, heading left, reaches
      the window's left edge before its top or its foot. */
  function leftward(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx >= 0) return false;
    const toLeft = from.x / -dx;
    const toTopOrFoot = dy < 0 ? from.y / -dy : dy > 0 ? (window.innerHeight - from.y) / dy : Infinity;
    return toLeft <= toTopOrFoot;
  }

  /** Whether the pointer left the window by its left edge: by the line
      from where it was last seen through where it left, or, where the page
      is told it left from that same point, the line it came along. A
      pointer seen only at the edge, as one a browser reports at a corner
      before any move, has gone nowhere the window can tell. */
  function leftByEdge(from: Seen, exit: { x: number; y: number }, prior: Seen | null): boolean {
    if (prior === null && from.x <= EDGE_WIDTH) return false;
    if (exit.x < 0) {
      const y = from.y + ((exit.y - from.y) * from.x) / (from.x - exit.x);
      return y >= 0 && y <= window.innerHeight;
    }
    const start = exit.x !== from.x || exit.y !== from.y ? from : prior;
    return start !== null && leftward(start, exit);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  function later(what: () => void, after: number) {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      what();
    }, after);
  }
  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function slideIn() {
    cancel();
    peekSessions(true);
  }

  /** The pane drawn over the panes, and whether a point is over it: inside
      its box as it stands once in, or on what it holds, a menu included. */
  function pane(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-testid="sessions-slot"] [data-pane="sessions"]');
  }
  function over(x: number, y: number, target: EventTarget | null): boolean {
    const shown = pane();
    if (shown === null) return false;
    if (target instanceof Node && shown.contains(target)) return true;
    const box = shown.getBoundingClientRect();
    const slot = shown.parentElement?.getBoundingClientRect();
    const left = slot?.left ?? box.left;
    return x >= 0 && x < left + layout.sessions && y >= box.top && y < box.bottom;
  }

  let inside = false;

  /** Whether the pane should go, and after how long: once the pointer has
      been away from it a moment, while nothing holds it. */
  function settle() {
    if (!layout.sessionsPeek) return;
    if (inside || compact.held || outLeft) {
      cancel();
      return;
    }
    if (timer === null) later(() => peekSessions(false), AWAY_AFTER);
  }

  /** The pointer moved: onto the edge from inside the window, at any speed,
      brings the pane at once. Along the edge, or into the window across it,
      it rests on the edge a moment first, so a pass along it brings
      nothing. Heading for the edge too fast for the page to see it arrive,
      the window is asked where the cursor came to. */
  function arrive() {
    if (at === null || before === null) return;
    if (before.x === at.x && before.y === at.y) return;
    if (onEdge(at.x, at.y)) {
      if (before.x > EDGE_WIDTH) slideIn();
      else if (timer === null) later(slideIn, EDGE_AFTER);
      return;
    }
    cancel();
    const speed = (before.x - at.x) / Math.max(1, at.t - before.t);
    if (speed > SPEEDY && at.x / speed < SOON && leftward(before, at)) ask();
  }

  /** How fast, in pixels a millisecond, and how soon, in milliseconds, a
      move heading left counts as one that reaches the edge between what the
      page sees of it. */
  const SPEEDY = 0.5;
  const SOON = 120;

  /** The window is asked where the cursor is, a little after a quick move
      toward the edge: by then it has arrived, against the screen's edge or
      out of the window, whether or not the page heard it. A move heard
      since says where the pointer is instead. */
  let asking = 0;
  function ask() {
    const asked = ++asking;
    const seen = at;
    for (const after of [50, 150])
      setTimeout(async () => {
        if (asked !== asking || at !== seen || layout.sessionsPeek) return;
        const cursor = await core()
          .cursorInWindow()
          .catch(() => null);
        if (cursor === null || asked !== asking || at !== seen || layout.sessionsPeek) return;
        const onLeft = cursor.y >= 0 && cursor.y < window.innerHeight && cursor.x <= EDGE_WIDTH;
        if (onLeft) {
          outLeft = cursor.x < 0;
          slideIn();
        }
      }, after);
  }

  // The pointer, seen wherever it goes in the window. Leaving the window by
  // its left edge slides the pane in, or keeps it, so it is there when the
  // pointer comes back; leaving by another edge is the pointer away from
  // it.
  $effect(() => {
    const move = (e: PointerEvent) => {
      before = at;
      at = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      outLeft = false;
      if (!layout.sessionsPeek) {
        arrive();
        return;
      }
      inside = over(e.clientX, e.clientY, e.target);
      settle();
    };
    const out = (e: PointerEvent) => {
      if (e.relatedTarget !== null) return;
      outLeft = at !== null && leftByEdge(at, { x: e.clientX, y: e.clientY }, before);
      // Back in the window, the pointer is seen afresh: where it was before
      // it left says nothing of how it came back.
      at = null;
      before = null;
      if (!layout.sessionsPeek) {
        if (outLeft) slideIn();
        else cancel();
        return;
      }
      inside = false;
      settle();
    };
    // A press outside the pane is done with it, unless something in it
    // holds it: a menu goes on its own with the press.
    const down = (e: PointerEvent) => {
      if (!layout.sessionsPeek) return;
      if (over(e.clientX, e.clientY, e.target)) return;
      if (compact.held && !pressOnly()) return;
      cancel();
      peekSessions(false);
    };
    window.addEventListener("pointermove", move, true);
    document.addEventListener("pointerout", out, true);
    window.addEventListener("pointerdown", down, true);
    return () => {
      cancel();
      window.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerout", out, true);
      window.removeEventListener("pointerdown", down, true);
      asking += 1;
    };
  });

  /** Whether all that holds the pane is a menu or the keyboard, which a
      press outside lets go of, rather than a question that waits for an
      answer. */
  function pressOnly(): boolean {
    return document.querySelector('[data-pane="sessions"] [role="alertdialog"]') === null;
  }

  // The pane coming in or going, or what holds it letting go, settles it
  // again from where the pointer last was. The keyboard leaving the pane
  // while the pointer is away from it sends it back at once.
  let focusWas = untrack(() => layout.focus);
  $effect(() => {
    const peeked = layout.sessionsPeek;
    void compact.held;
    const focus = layout.focus;
    untrack(() => {
      const left = focusWas === "sessions" && focus !== "sessions";
      focusWas = focus;
      if (!peeked) {
        cancel();
        inside = false;
        return;
      }
      inside = at !== null && over(at.x, at.y, null);
      if (left && !inside && !compact.held) {
        cancel();
        peekSessions(false);
        return;
      }
      settle();
    });
  });

  /** A session other than the one on screen that waits for the user: it
      went unread, or asks for a permission. */
  let waiting = $derived(
    sessions.all.filter(
      (session) => session.key !== sessions.active && (session.unread || session.needs === "permission"),
    ).length,
  );
</script>

{#if waiting > 0}
  <div
    class="mark"
    class:hidden={layout.sessionsPeek}
    aria-hidden="true"
    data-testid="compact-mark"
  ></div>
{/if}

<style>
  /* A short bar in the accent on the edge, where the pane comes from,
     while a session waits for you. */
  .mark {
    position: absolute;
    top: 50%;
    left: calc(2px - var(--frame-pad-left));
    width: 3px;
    height: 28px;
    margin-top: -14px;
    border-radius: 99px;
    background: var(--accent);
    opacity: 0.85;
    pointer-events: none;
    z-index: 5;
  }

  .mark.hidden {
    opacity: 0;
  }

  @media (prefers-reduced-motion: no-preference) {
    .mark {
      transition: opacity 180ms ease-out;
    }
  }
</style>
