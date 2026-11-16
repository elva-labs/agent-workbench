<script lang="ts">
  import { onMount } from "svelte";
  import { follow, holdGrips, watchDivider } from "$lib/dividers";
  import { hold, letGo } from "$lib/flash.svelte";

  interface Props {
    label: string;
    /** Which way the bar runs. A vertical bar moves left and right and
        reports dx; a horizontal one moves up and down and reports dy. */
    orientation?: "vertical" | "horizontal";
    /** A divider inside a pane, between two parts of what it holds,
        rather than the gap between two panes. */
    inner?: boolean;
    /** What the divider moves, for whatever meets it to find it by. */
    name?: string;
    /** Called with the delta in pixels since the last move. */
    onDelta: (delta: number) => void;
    /** Double-click or Home: restore the pane to its default size. */
    onReset: () => void;
    onCommit?: () => void;
  }

  let { label, orientation = "vertical", inner = false, name, onDelta, onReset, onCommit }: Props = $props();

  /** What the status bar says while a divider has the keyboard. */
  const KEYS = "Arrows resize, Shift for more, Home resets";

  let vertical = $derived(orientation === "vertical");
  let dragging = $state(false);
  let keyed = $state(false);
  let element: HTMLDivElement;
  let last = 0;

  onMount(() => {
    const stop = watchDivider(element, orientation === "vertical");
    return () => {
      stop();
      letGo(KEYS);
      // Gone in the middle of a drag, as a pane that folds under it: the
      // other grips are let go.
      if (dragging) holdGrips(false);
    };
  });

  function position(e: PointerEvent) {
    return vertical ? e.clientX : e.clientY;
  }

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragging = true;
    holdGrips(true);
    last = position(e);
    e.preventDefault();
  }

  function move(e: PointerEvent) {
    if (!dragging) return;
    follow(element, vertical, e.clientX, e.clientY);
    const delta = position(e) - last;
    if (delta === 0) return;
    last = position(e);
    onDelta(delta);
  }

  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    holdGrips(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    onCommit?.();
  }

  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 24 : 8;
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const forward = vertical ? "ArrowRight" : "ArrowDown";
    if (e.key === back) onDelta(-step);
    else if (e.key === forward) onDelta(step);
    else if (e.key === "Home") onReset();
    else return;
    e.preventDefault();
    if (!keyed) mark();
    onCommit?.();
  }

  /** From the keyboard the divider draws its line with the grip at its
      middle, and the status bar names the keys it takes. A click that
      focuses it is the pointer's and says nothing. */
  function focused() {
    let visible = false;
    try {
      visible = element.matches(":focus-visible");
    } catch {
      // A page that does not know the selector draws no ring either.
    }
    if (visible) mark();
  }

  function mark() {
    keyed = true;
    element.style.removeProperty("--grip-at");
    hold(KEYS);
  }

  function blurred() {
    keyed = false;
    letGo(KEYS);
  }
</script>

<!-- A separator that can be moved is a widget, and ARIA expects it to be
     focusable and to take arrow keys. The compiler's rule assumes the static
     kind of separator. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="splitter"
  class:dragging
  class:keyed
  class:inner
  class:horizontal={!vertical}
  role="separator"
  aria-orientation={orientation}
  aria-label={label}
  tabindex="0"
  data-divider={name}
  bind:this={element}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={onReset}
  onkeydown={key}
  onfocus={focused}
  onblur={blurred}
>
  <i class="before"></i><i class="after"></i><i class="rest"></i><i class="line"></i><i class="grip"></i>
</div>

<style>
  /* The track is the gap between two panes, or nothing inside a pane;
     what it draws stands over it, and the reach either side of it. */
  .splitter {
    --track: var(--splitter-w);
    --reach: var(--splitter-reach);
    position: relative;
    z-index: 4;
    flex: none;
    width: var(--track);
    cursor: col-resize;
    background: transparent;
    touch-action: none;
    outline: none;
  }

  .splitter.inner {
    --track: var(--splitter-inner-w);
    --reach: var(--splitter-inner-reach);
    z-index: 3;
  }

  .splitter.horizontal {
    width: auto;
    height: var(--track);
    cursor: row-resize;
  }

  .splitter > i {
    position: absolute;
    display: block;
    pointer-events: none;
  }

  /* The reach into the pane on either side, which gives way to a scroll
     bar or a control under it. */
  .splitter > i.before,
  .splitter > i.after {
    pointer-events: auto;
    top: 0;
    bottom: 0;
    width: calc((var(--reach) - var(--track)) / 2);
  }

  .before {
    right: 100%;
  }

  .after {
    left: 100%;
  }

  .splitter.horizontal > i.before,
  .splitter.horizontal > i.after {
    left: 0;
    right: 0;
    width: auto;
    height: calc((var(--reach) - var(--track)) / 2);
  }

  .splitter.horizontal > i.before {
    top: auto;
    bottom: 100%;
  }

  .splitter.horizontal > i.after {
    top: 100%;
    bottom: auto;
  }

  .splitter:global([data-yield-before]) > i.before,
  .splitter:global([data-yield-after]) > i.after {
    pointer-events: none;
  }

  /* A line at rest only where the system asks for more contrast, and only
     inside a pane: between panes the boxes and cards draw their edges. */
  .rest,
  .line {
    top: 0;
    bottom: 0;
    left: calc(50% - var(--w) / 2);
    width: var(--w);
  }

  .horizontal > .rest,
  .horizontal > .line {
    left: 0;
    right: 0;
    top: calc(50% - var(--w) / 2);
    width: auto;
    height: var(--w);
  }

  .rest {
    --w: 1px;
    background: transparent;
  }

  @media (prefers-contrast: more), (forced-colors: active) {
    .inner > .rest {
      background: var(--rule-strong);
    }
  }

  /* Dragged or under the keyboard, a line in the accent the length of the
     divider. */
  .line {
    --w: var(--splitter-line);
    background: var(--accent);
    opacity: 0;
  }

  .splitter.dragging > .line,
  .splitter.keyed > .line,
  .splitter:global([data-met-drag]) > .line {
    opacity: 1;
  }

  .splitter.keyed > .line {
    --w: var(--splitter-line-on);
  }

  /* The grip fades in as the pointer nears, follows it along, and stands
     full on the reach, while dragged and under the keyboard, wider on the
     line. Under the keyboard it stands at the middle. */
  .grip {
    --w: var(--grip-w);
    left: calc(50% - var(--w) / 2);
    top: var(--grip-at, calc(50% - var(--grip-len) / 2));
    width: var(--w);
    height: var(--grip-len);
    border-radius: var(--grip-radius);
    background: var(--accent);
    opacity: calc(var(--near, 0) * 0.55);
    transition: opacity 120ms ease;
  }

  .horizontal > .grip {
    left: var(--grip-at, calc(50% - var(--grip-len) / 2));
    top: calc(50% - var(--w) / 2);
    width: var(--grip-len);
    height: var(--w);
  }

  .splitter:hover > .grip,
  .splitter.dragging > .grip,
  .splitter.keyed > .grip,
  .splitter:global([data-met]) > .grip {
    opacity: 1;
  }

  .splitter.dragging > .grip,
  .splitter.keyed > .grip,
  .splitter:global([data-met-drag]) > .grip {
    --w: var(--grip-w-on);
  }

  .splitter.keyed > .grip {
    top: calc(50% - var(--grip-len) / 2);
  }

  .horizontal.keyed > .grip {
    top: calc(50% - var(--w) / 2);
    left: calc(50% - var(--grip-len) / 2);
  }

  @media (prefers-reduced-motion: reduce) {
    .grip {
      transition: none;
    }
  }
</style>
