<script lang="ts">
  import { holdGrips } from "$lib/dividers";

  interface Props {
    /** The divider running down between two panes, by its name. */
    side: string;
    /** The divider running across over the terminal panel, by its name. */
    foot: string;
    /** Called with how far the pointer moved across and down since the
        last move: the one divider takes the one, the other the other. */
    onDelta: (dx: number, dy: number) => void;
    /** Double-click: both dividers back to their defaults. */
    onReset: () => void;
    onCommit?: () => void;
    /** Anything that moves either divider, so the meeting point follows. */
    at: unknown;
  }

  let { side, foot, onDelta, onReset, onCommit, at }: Props = $props();

  let element: HTMLDivElement;
  let box = $state<{ left: number; top: number; width: number; height: number } | null>(null);
  let dragging = false;
  let last = { x: 0, y: 0 };

  function pair(): [HTMLElement, HTMLElement] | null {
    const down = document.querySelector<HTMLElement>(`.splitter[data-divider="${side}"]`);
    const across = document.querySelector<HTMLElement>(`.splitter[data-divider="${foot}"]`);
    if (down === null || across === null || down.offsetParent === null || across.offsetParent === null) return null;
    return [down, across];
  }

  /** The reach of a divider across its length: its gap and the reach into
      the panes either side. */
  function reach(divider: HTMLElement, vertical: boolean): [number, number] {
    const own = divider.getBoundingClientRect();
    const before = divider.querySelector(".before")?.getBoundingClientRect() ?? own;
    const after = divider.querySelector(".after")?.getBoundingClientRect() ?? own;
    return vertical ? [before.left, after.right] : [before.top, after.bottom];
  }

  /** Where the two meet, as wide as the one's reach and as tall as the
      other's. */
  function place() {
    const found = pair();
    if (found === null) {
      box = null;
      return;
    }
    const [down, across] = found;
    const [left, right] = reach(down, true);
    const [top, bottom] = reach(across, false);
    if (right - left <= 0 || bottom - top <= 0) {
      box = null;
      return;
    }
    box = { left, top, width: right - left, height: bottom - top };
  }

  $effect(() => {
    void at;
    void side;
    const frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => {
    const again = () => place();
    window.addEventListener("resize", again);
    return () => {
      window.removeEventListener("resize", again);
      // Gone in the middle of a drag: the grips are let go and the two
      // dividers no longer marked.
      if (dragging) holdGrips(false);
      for (const divider of document.querySelectorAll(`.splitter[data-divider="${side}"], .splitter[data-divider="${foot}"]`)) {
        divider.removeAttribute("data-met");
        divider.removeAttribute("data-met-drag");
      }
    };
  });

  /** The two grips meet in a T: the one coming down reaches the middle of
      the one running across. */
  function meet() {
    const found = pair();
    if (found === null) return;
    const [down, across] = found;
    const downBox = down.getBoundingClientRect();
    const acrossBox = across.getBoundingClientRect();
    const downGrip = down.querySelector<HTMLElement>(".grip");
    const acrossGrip = across.querySelector<HTMLElement>(".grip");
    const length = downGrip?.offsetHeight ?? 32;
    const thick = acrossGrip?.offsetHeight ?? 4;
    const middle = acrossBox.top + acrossBox.height / 2;
    down.style.setProperty("--grip-at", `${middle + thick / 2 - downBox.top - length}px`);
    const centre = downBox.left + downBox.width / 2;
    across.style.setProperty("--grip-at", `${centre - acrossBox.left - (acrossGrip?.offsetWidth ?? 32) / 2}px`);
  }

  function mark(on: boolean) {
    for (const divider of pair() ?? []) divider.toggleAttribute("data-met", on);
    if (on) meet();
  }

  function marked(drag: boolean) {
    for (const divider of pair() ?? []) divider.toggleAttribute("data-met-drag", drag);
  }

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    element.setPointerCapture(e.pointerId);
    dragging = true;
    holdGrips(true);
    last = { x: e.clientX, y: e.clientY };
    mark(true);
    marked(true);
    e.preventDefault();
  }

  function move(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (dx === 0 && dy === 0) return;
    last = { x: e.clientX, y: e.clientY };
    onDelta(dx, dy);
    requestAnimationFrame(() => {
      place();
      meet();
    });
  }

  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    holdGrips(false);
    element.releasePointerCapture(e.pointerId);
    marked(false);
    onCommit?.();
    const now = element.getBoundingClientRect();
    const inside = e.clientX >= now.left && e.clientX <= now.right && e.clientY >= now.top && e.clientY <= now.bottom;
    if (!inside) mark(false);
  }

  function leave() {
    if (!dragging) mark(false);
  }
</script>

<!-- Where the divider between two panes meets the one over the terminal
     panel, the pointer takes both at once. Each divider is reached by the
     keyboard on its own, so this is for the pointer alone. -->
<div
  class="junction"
  class:off={box === null}
  style:left="{box?.left ?? 0}px"
  style:top="{box?.top ?? 0}px"
  style:width="{box?.width ?? 0}px"
  style:height="{box?.height ?? 0}px"
  aria-hidden="true"
  data-testid="junction"
  data-side={side}
  bind:this={element}
  onpointerenter={() => mark(true)}
  onpointerleave={leave}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={onReset}
></div>

<style>
  .junction {
    position: fixed;
    z-index: 5;
    cursor: move;
    touch-action: none;
  }

  .junction.off {
    display: none;
  }
</style>
