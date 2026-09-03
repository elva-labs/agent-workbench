<script lang="ts">
  interface Props {
    label: string;
    /** Which way the bar runs. A vertical bar moves left and right and
        reports dx; a horizontal one moves up and down and reports dy. */
    orientation?: "vertical" | "horizontal";
    /** Called with the delta in pixels since the last move. */
    onDelta: (delta: number) => void;
    /** Double-click or Home: restore the pane to its default size. */
    onReset: () => void;
    onCommit?: () => void;
  }

  let { label, orientation = "vertical", onDelta, onReset, onCommit }: Props = $props();

  let vertical = $derived(orientation === "vertical");
  let dragging = $state(false);
  let last = 0;

  function position(e: PointerEvent) {
    return vertical ? e.clientX : e.clientY;
  }

  function down(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragging = true;
    last = position(e);
    e.preventDefault();
  }

  function move(e: PointerEvent) {
    if (!dragging) return;
    const delta = position(e) - last;
    if (delta === 0) return;
    last = position(e);
    onDelta(delta);
  }

  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
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
    onCommit?.();
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
  class:horizontal={!vertical}
  role="separator"
  aria-orientation={orientation}
  aria-label={label}
  tabindex="0"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={onReset}
  onkeydown={key}
></div>

<style>
  .splitter {
    width: var(--splitter-w);
    cursor: col-resize;
    background: transparent;
    position: relative;
    touch-action: none;
    flex: none;
  }

  .splitter.horizontal {
    width: auto;
    height: var(--splitter-w);
    cursor: row-resize;
  }

  /* The hairline sits inside a wider hit target: 1px to look at, 6px to grab. */
  .splitter::after {
    content: "";
    position: absolute;
    inset: 0 calc(50% - 0.5px);
    background: var(--rule);
    transition: background 90ms ease;
  }

  .splitter.horizontal::after {
    inset: calc(50% - 0.5px) 0;
  }

  .splitter:hover::after,
  .splitter:focus-visible::after,
  .splitter.dragging::after {
    background: var(--accent);
  }

  .splitter:focus-visible {
    outline: none;
  }
</style>
