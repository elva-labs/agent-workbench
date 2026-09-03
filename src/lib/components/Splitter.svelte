<script lang="ts">
  interface Props {
    label: string;
    /** Called with the horizontal delta in pixels since the last move. */
    onDelta: (dx: number) => void;
    /** Double-click or Home: restore the pane to its default width. */
    onReset: () => void;
    onCommit?: () => void;
  }

  let { label, onDelta, onReset, onCommit }: Props = $props();

  let dragging = $state(false);
  let lastX = 0;

  function down(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragging = true;
    lastX = e.clientX;
    e.preventDefault();
  }

  function move(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    if (dx === 0) return;
    lastX = e.clientX;
    onDelta(dx);
  }

  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    onCommit?.();
  }

  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 24 : 8;
    if (e.key === "ArrowLeft") onDelta(-step);
    else if (e.key === "ArrowRight") onDelta(step);
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
  role="separator"
  aria-orientation="vertical"
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

  /* The hairline sits inside a wider hit target: 1px to look at, 6px to grab. */
  .splitter::after {
    content: "";
    position: absolute;
    inset: 0 calc(50% - 0.5px);
    background: var(--rule);
    transition: background 90ms ease;
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
