import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

const openUrl = vi.fn(() => Promise.resolve());
vi.mock("$lib/core", () => ({ core: () => ({ openUrl }) }));

import Markdown from "$lib/components/conversation/Markdown.svelte";

describe("a run mark inside a link", () => {
  it("runs its command and leaves the link closed, while the link's text still opens it", async () => {
    const onrun = vi.fn();
    render(Markdown, { text: "See [`! ls -la`](https://example.com/docs).", onrun });
    const mark = await screen.findByTestId("run-command");
    expect(mark.closest("a")).not.toBeNull();

    await fireEvent.click(mark);
    expect(onrun).toHaveBeenCalledWith("ls -la");
    expect(openUrl).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByText("! ls -la"));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
    expect(onrun).toHaveBeenCalledTimes(1);
  });
});
