import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import Splitter from "$lib/components/Splitter.svelte";

function setup() {
  const onDelta = vi.fn();
  const onReset = vi.fn();
  const onCommit = vi.fn();
  render(Splitter, { label: "Resize changes", onDelta, onReset, onCommit });
  return { handle: screen.getByRole("separator"), onDelta, onReset, onCommit };
}

describe("Splitter", () => {
  it("exposes itself as a labelled vertical separator", () => {
    const { handle } = setup();
    expect(handle).toHaveAccessibleName("Resize changes");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("tabindex", "0");
  });

  it("reports incremental deltas while dragging", async () => {
    const { handle, onDelta } = setup();
    await fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    await fireEvent.pointerMove(handle, { clientX: 130, pointerId: 1 });
    await fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 });

    // Each move is relative to the previous one, not to the drag origin.
    expect(onDelta.mock.calls).toEqual([[30], [10]]);
  });

  it("ignores movement before a drag starts", async () => {
    const { handle, onDelta } = setup();
    await fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("stops reporting once the pointer is released", async () => {
    const { handle, onDelta, onCommit } = setup();
    await fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    await fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });
    await fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });

    expect(onDelta).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("commits once per drag, not once per move", async () => {
    const { handle, onCommit } = setup();
    await fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    await fireEvent.pointerMove(handle, { clientX: 120, pointerId: 1 });
    await fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    await fireEvent.pointerUp(handle, { clientX: 140, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("treats a cancelled pointer as the end of the drag", async () => {
    const { handle, onDelta } = setup();
    await fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    await fireEvent.pointerCancel(handle, { pointerId: 1 });
    await fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("skips zero-width moves", async () => {
    const { handle, onDelta } = setup();
    await fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    await fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("resizes from the keyboard, with a coarser shift step", async () => {
    const { handle, onDelta, onCommit } = setup();
    await fireEvent.keyDown(handle, { key: "ArrowRight" });
    await fireEvent.keyDown(handle, { key: "ArrowLeft" });
    await fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });

    expect(onDelta.mock.calls).toEqual([[8], [-8], [24]]);
    expect(onCommit).toHaveBeenCalledTimes(3);
  });

  it("resets on Home and on double click", async () => {
    const { handle, onReset } = setup();
    await fireEvent.keyDown(handle, { key: "Home" });
    await fireEvent.dblClick(handle);
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it("leaves other keys alone", async () => {
    const { handle, onDelta, onReset, onCommit } = setup();
    await fireEvent.keyDown(handle, { key: "ArrowUp" });
    await fireEvent.keyDown(handle, { key: "a" });
    expect(onDelta).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
