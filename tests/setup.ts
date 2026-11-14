import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";

// jsdom has no matchMedia, and the theme module asks it what the system prefers.
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// jsdom has no pointer capture, which the splitter uses to keep receiving moves
// once the pointer leaves its 6px hit target.
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
}

// jsdom lays nothing out, so a range has no boxes. The editor measures the
// text it scrolls to with them; empty boxes leave it where it is.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

// jsdom implements no layout, so it has no scrollIntoView. The tree calls it
// to keep the keyboard cursor on screen.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

// jsdom animates nothing, so it has no Web Animations API. The panes and the
// rows in them transition through it, and every transition asks the element
// for an animation. These finish at once, which leaves the DOM in the state
// the transition was on its way to: the one a test reads.
if (!Element.prototype.animate) {
  Element.prototype.animate = function () {
    const animation = {
      currentTime: 0,
      playState: "finished",
      effect: null,
      onfinish: null as (() => void) | null,
      cancel: () => {},
      finish: () => {},
      pause: () => {},
      play: () => {},
    };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  } as typeof Element.prototype.animate;
  Element.prototype.getAnimations = () => [];
}

// jsdom lays nothing out, so it has no ResizeObserver. Svelte's dimension
// bindings watch elements with one; the values stay at zero here.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.restoreAllMocks();
});
