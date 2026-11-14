import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { COUNT_AFTER, LARGE_FILE, stateFor } from "$lib/codeEditor";

/** An editor in the page with the find bar open on `text`. */
function withFind(text: string) {
  const view = new EditorView({ parent: document.body, state: stateFor(text) });
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>("[data-testid='find-field']")!;
  const count = () => view.dom.querySelector("[data-testid='find-count']")!.textContent;
  const find = (query: string) => {
    field.value = query;
    field.dispatchEvent(new Event("input"));
  };
  return { view, find, count };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("the find bar", () => {
  it("counts a small file's matches as the query is typed", () => {
    const { view, find, count } = withFind("one two one\nthree one\n");
    find("one");
    expect(count()).toBe("3 matches");
    find("four");
    expect(count()).toBe("No matches");
    view.destroy();
  });

  it("counts again only once typing in the file pauses", () => {
    vi.useFakeTimers();
    const { view, find, count } = withFind("one two one\n");
    find("one");
    expect(count()).toBe("2 matches");
    view.dispatch({ changes: { from: 0, insert: "one " } });
    view.dispatch({ changes: { from: 0, insert: "one " } });
    expect(count()).toBe("2 matches");
    vi.advanceTimersByTime(COUNT_AFTER);
    expect(count()).toBe("4 matches");
    view.destroy();
  });

  it("counts a large file only once the query stops changing", () => {
    vi.useFakeTimers();
    const big = `${"x".repeat(LARGE_FILE)}\nneedle\n`;
    const { view, find, count } = withFind(big);
    find("needl");
    find("needle");
    expect(count()).toBe("");
    vi.advanceTimersByTime(COUNT_AFTER);
    expect(count()).toBe("1 match");
    view.destroy();
  });
});
