import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { putAway } from "$lib/popover";

// A control, its popover, and a composer elsewhere that stops a running
// turn on Escape, as the conversation's does.

let control: HTMLButtonElement;
let popover: HTMLDivElement;
let link: HTMLAnchorElement;
let composer: HTMLTextAreaElement;
let interrupted: number;
let close: ReturnType<typeof vi.fn<() => void>>;
let stop: () => void;

const escape = (target: Element, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  document.body.innerHTML = "";
  control = document.createElement("button");
  popover = document.createElement("div");
  link = document.createElement("a");
  link.href = "#";
  popover.append(link);
  composer = document.createElement("textarea");
  document.body.append(control, popover, composer);
  interrupted = 0;
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") interrupted += 1;
  });
  close = vi.fn<() => void>();
  stop = putAway({ inside: () => [control, popover], close, control: () => control });
});

afterEach(() => stop());

describe("an open popover", () => {
  it("is put away by Escape where the keyboard is elsewhere, and nothing there hears the key", () => {
    composer.focus();
    const event = escape(composer);
    expect(close).toHaveBeenCalledTimes(1);
    expect(interrupted).toBe(0);
    expect(event.defaultPrevented).toBe(true);
    // The keyboard stays where it was.
    expect(document.activeElement).toBe(composer);
  });

  it("gives the keyboard back to its control when it was in the popover", () => {
    link.focus();
    escape(link);
    expect(close).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(control);
  });

  it("leaves a key being composed alone", () => {
    composer.focus();
    escape(composer, { isComposing: true });
    expect(close).not.toHaveBeenCalled();
    expect(interrupted).toBe(1);
  });

  it("is put away by a press outside it and its control, not by one inside", () => {
    popover.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    control.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(close).not.toHaveBeenCalled();
    composer.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("is put away when the window changes size", () => {
    window.dispatchEvent(new Event("resize"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("once put away, leaves Escape to what has the keyboard", () => {
    stop();
    composer.focus();
    escape(composer);
    expect(close).not.toHaveBeenCalled();
    expect(interrupted).toBe(1);
  });
});

describe("an open popover and the window", () => {
  it("is put away when the window loses focus", () => {
    window.dispatchEvent(new Event("blur"));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
