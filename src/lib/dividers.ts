/**
 * What every divider does with the pointer before it is grabbed.
 *
 * A divider draws nothing at rest. As the pointer comes within `NEAR`
 * pixels of where it can be taken hold of, its grip fades in, the nearer
 * the stronger, and follows the pointer along it, so the edge is found the
 * first time without aiming. One listener on the window serves them all,
 * a frame at a time.
 *
 * The reach of a divider runs a few pixels into the panes either side of
 * its gap. Where what lies under the reach wants the pointer itself, a
 * scroll bar at that edge or a control, the reach on that side gives way
 * to it, and the gap alone takes hold.
 */

/** How far from its reach a divider's grip starts to show, in pixels. */
export const NEAR = 24;

/** How far in from a scrolling element's edge its scroll bar is taken to
    stand, overlay scroll bars included, which take no room of their own. */
const SCROLLBAR = 16;

/** What takes the pointer itself where a reach lies over it. */
const CONTROL =
  "button, a[href], input, select, textarea, summary, [contenteditable='true'], [role='button'], [role='scrollbar'], [role='slider'], .scrollbar, .slider";

interface Watched {
  vertical: boolean;
  /** The last nearness written, so an unchanged one is not written again. */
  near: number;
  yieldBefore: boolean;
  yieldAfter: boolean;
}

const watched = new Map<HTMLElement, Watched>();
let pending: PointerEvent | null = null;
let scheduled = false;
let listening = false;

/** Whether a divider is being dragged: the grips hold still meanwhile. */
let held = 0;

function clamp(value: number, least: number, most: number) {
  return Math.min(Math.max(value, least), Math.max(least, most));
}

/** Where a grip rides along its divider, so its middle is at the pointer
    and it stays clear of the divider's ends. */
export function follow(element: HTMLElement, vertical: boolean, x: number, y: number) {
  const box = element.getBoundingClientRect();
  const grip = element.querySelector<HTMLElement>(".grip");
  const length = grip === null ? 32 : vertical ? grip.offsetHeight : grip.offsetWidth;
  if (vertical) element.style.setProperty("--grip-at", `${clamp(y - box.top - length / 2, 2, box.height - length - 2)}px`);
  else element.style.setProperty("--grip-at", `${clamp(x - box.left - length / 2, 2, box.width - length - 2)}px`);
}

/** Whether the element under a point on one side of a divider wants the
    pointer for itself: a control, or a scroll bar along the edge that side
    meets the divider at. Scroll bars run down the right of what scrolls
    and along its foot, so only the side before a divider, left of it or
    above it, can have one there. */
function wants(target: Element | null, vertical: boolean, before: boolean, x: number, y: number): boolean {
  if (target === null) return false;
  if (target.closest(CONTROL) !== null) return true;
  if (!before) return false;
  for (let at: Element | null = target; at !== null && at !== document.body; at = at.parentElement) {
    const style = getComputedStyle(at);
    const box = at.getBoundingClientRect();
    if (vertical) {
      const scrolls = /auto|scroll/.test(style.overflowY) && at.scrollHeight > at.clientHeight + 1;
      if (scrolls && box.right - x <= SCROLLBAR) return true;
    } else {
      const scrolls = /auto|scroll/.test(style.overflowX) && at.scrollWidth > at.clientWidth + 1;
      if (scrolls && box.bottom - y <= SCROLLBAR) return true;
    }
  }
  return false;
}

/** The topmost element under a point that is no divider's own. */
function under(x: number, y: number): Element | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (element.closest(".splitter, .junction") === null) return element;
  }
  return null;
}

function frame() {
  scheduled = false;
  const event = pending;
  pending = null;
  if (event === null || held > 0) return;
  const { clientX: x, clientY: y } = event;
  for (const [element, state] of watched) {
    if (!element.isConnected || element.offsetParent === null) continue;
    const box = element.getBoundingClientRect();
    const before = element.querySelector<HTMLElement>(".before")?.getBoundingClientRect() ?? box;
    const after = element.querySelector<HTMLElement>(".after")?.getBoundingClientRect() ?? box;
    const { vertical } = state;
    const along = vertical ? y >= box.top && y <= box.bottom : x >= box.left && x <= box.right;
    const from = vertical ? before.left : before.top;
    const to = vertical ? after.right : after.bottom;
    const across = vertical ? x : y;
    const distance = Math.max(from - across, across - to, 0);
    const near = along ? Math.round(clamp(1 - distance / NEAR, 0, 1) * 100) / 100 : 0;
    if (near !== state.near) {
      state.near = near;
      element.style.setProperty("--near", String(near));
    }
    if (near > 0) follow(element, vertical, x, y);

    // The reach on either side gives way to what lies under it.
    const inBefore = along && (vertical ? x >= before.left && x < box.left : y >= before.top && y < box.top);
    const inAfter = along && (vertical ? x > box.right && x <= after.right : y > box.bottom && y <= after.bottom);
    const yieldBefore = inBefore && wants(under(x, y), vertical, true, x, y);
    const yieldAfter = inAfter && wants(under(x, y), vertical, false, x, y);
    if (yieldBefore !== state.yieldBefore) {
      state.yieldBefore = yieldBefore;
      element.toggleAttribute("data-yield-before", yieldBefore);
    }
    if (yieldAfter !== state.yieldAfter) {
      state.yieldAfter = yieldAfter;
      element.toggleAttribute("data-yield-after", yieldAfter);
    }
  }
}

function moved(event: PointerEvent) {
  pending = event;
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(frame);
}

function left() {
  pending = null;
  for (const [element, state] of watched) {
    state.near = 0;
    element.style.setProperty("--near", "0");
  }
}

/** Watches a divider for the pointer nearing it, until the returned
    function lets it go. */
export function watchDivider(element: HTMLElement, vertical: boolean): () => void {
  watched.set(element, { vertical, near: 0, yieldBefore: false, yieldAfter: false });
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("pointermove", moved, { passive: true });
    document.documentElement.addEventListener("pointerleave", left);
  }
  return () => {
    watched.delete(element);
    if (watched.size === 0 && listening) {
      listening = false;
      window.removeEventListener("pointermove", moved);
      document.documentElement.removeEventListener("pointerleave", left);
    }
  };
}

/** A drag has started or ended somewhere: the grips hold still while one
    runs, and every one but the dragged one's fades out. */
export function holdGrips(on: boolean) {
  held = Math.max(0, held + (on ? 1 : -1));
  if (on) {
    for (const [element, state] of watched) {
      state.near = 0;
      element.style.setProperty("--near", "0");
    }
  }
}
