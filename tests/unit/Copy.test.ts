import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Copy from "$lib/components/conversation/Copy.svelte";
import { FLASH_MS, flash, resetFlash } from "$lib/flash.svelte";

const copied: string[] = [];
let refuse: Error | null = null;

vi.mock("$lib/core", () => ({
  core: () => ({
    async copyText(text: string) {
      if (refuse !== null) throw refuse;
      copied.push(text);
    },
  }),
}));

beforeEach(() => {
  copied.length = 0;
  refuse = null;
  resetFlash();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(text: () => string = () => "npm test") {
  render(Copy, { label: "Copy command", text, host: "command", testid: "copy-command" });
  return screen.getByTestId("copy-command");
}

describe("a Copy in the thread", () => {
  it("is an item of the thread's arrow walk, not a stop of its own for Tab", () => {
    const button = setup();
    expect(button).toHaveAttribute("tabindex", "-1");
    expect(button).toHaveAttribute("data-thread-item");
    expect(button).toHaveAccessibleName("Copy command");
  });

  it("copies what is there at the click, turns to Copied for a moment and says so", async () => {
    let said = "cargo te";
    const button = setup(() => said);
    said = "cargo test -p core";
    await fireEvent.click(button);
    expect(copied).toEqual(["cargo test -p core"]);
    expect(button).toHaveAttribute("data-copied", "true");
    // The status alone says it, once: the button's own name stays.
    expect(button).toHaveAccessibleName("Copy command");
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    await vi.advanceTimersByTimeAsync(FLASH_MS);
    expect(button).toHaveAttribute("data-copied", "false");
    expect(button).toHaveAccessibleName("Copy command");
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("keeps a name a screen reader is not told twice, given or drawn", async () => {
    render(Copy, { label: "Copy", name: "Copy the code", text: () => "x", host: "code", place: "corner", testid: "copy-code" });
    const button = screen.getByTestId("copy-code");
    expect(button).toHaveAccessibleName("Copy the code");
    await fireEvent.click(button);
    expect(button).toHaveAccessibleName("Copy the code");
    for (const face of button.querySelectorAll(".face")) expect(face).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the focus where it was when pressed", async () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    const button = setup();
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it("says in the status bar when the clipboard refuses, and stays Copy", async () => {
    refuse = new Error("no clipboard");
    const button = setup();
    await fireEvent.click(button);
    expect(copied).toEqual([]);
    expect(button).toHaveAttribute("data-copied", "false");
    expect(flash.text).toBe("Could not copy: no clipboard");
  });
});
