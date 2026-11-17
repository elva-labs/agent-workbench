<script lang="ts">
  /**
   * The window's left edge in compact mode, where the sessions pane is not
   * in the layout. The pointer resting on a thin strip along the edge, or
   * leaving the window by it, slides the pane in over the panes; the
   * pointer away from the pane for a moment, or a press outside it, sends
   * it back, unless something in it holds it there: a menu, the
   * new-session choice, a question, a press, or the keyboard. While a
   * session waits for the user, a quiet mark on the edge says so.
   */
  import { untrack } from "svelte";
  import { AWAY_AFTER, EDGE_AFTER, EDGE_WIDTH, compact } from "$lib/compact.svelte";
  import { layout, peekSessions } from "$lib/layout.svelte";
  import { sessions } from "$lib/sessions.svelte";

  /** Where the pointer was last seen, and whether it went out of the window
      by its left edge and has not come back. */
  let at = { x: -1, y: -1 };
  let outLeft = false;

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

  // The pointer, seen wherever it goes in the window. Leaving the window by
  // its left edge slides the pane in, or keeps it, so it is there when the
  // pointer comes back; leaving by another edge is the pointer away from
  // it.
  $effect(() => {
    const move = (e: PointerEvent) => {
      at = { x: e.clientX, y: e.clientY };
      outLeft = false;
      if (!layout.sessionsPeek) return;
      inside = over(e.clientX, e.clientY, e.target);
      settle();
    };
    const out = (e: PointerEvent) => {
      if (e.relatedTarget !== null) return;
      const { x, y } = at;
      outLeft = x >= 0 && x <= 24 && x <= y && x <= window.innerHeight - y;
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
      inside = over(at.x, at.y, null);
      if (left && !inside && !compact.held) {
        cancel();
        peekSessions(false);
        return;
      }
      settle();
    });
  });

  function enterEdge() {
    if (layout.sessionsPeek) return;
    later(slideIn, EDGE_AFTER);
  }

  function leaveEdge() {
    if (!layout.sessionsPeek) cancel();
  }

  /** A session other than the one on screen that waits for the user: it
      went unread, or asks for a permission. */
  let waiting = $derived(
    sessions.all.filter(
      (session) => session.key !== sessions.active && (session.unread || session.needs === "permission"),
    ).length,
  );
</script>

{#if !layout.sessionsPeek}
  <div
    class="edge"
    style:--edge-w="{EDGE_WIDTH}px"
    onpointerenter={enterEdge}
    onpointerleave={leaveEdge}
    aria-hidden="true"
    data-testid="compact-edge"
  ></div>
{/if}
{#if waiting > 0}
  <div
    class="mark"
    class:hidden={layout.sessionsPeek}
    title="{waiting} waiting for you"
    aria-hidden="true"
    data-testid="compact-mark"
  ></div>
{/if}

<style>
  /* Along the window's left edge, as tall as the panes, past the frame's
     padding to the window's own edge. */
  .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(-1 * var(--frame-pad-left));
    width: var(--edge-w);
    z-index: 5;
  }

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
