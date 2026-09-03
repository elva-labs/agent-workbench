import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/svelte";
import SessionsPane from "$lib/panes/SessionsPane.svelte";
import AgentPane from "$lib/panes/AgentPane.svelte";
import ChangesPane from "$lib/panes/ChangesPane.svelte";
import { DEFAULT, layout, togglePane } from "$lib/layout.svelte";
import { files } from "$lib/files.svelte";

beforeEach(() => {
  layout.sessions = DEFAULT.sessions;
  layout.changes = DEFAULT.changes;
  layout.review = DEFAULT.review;
  layout.sessionsChosen = true;
  layout.changesChosen = true;
  layout.sessionsForced = false;
  layout.changesForced = false;
  layout.agentHidden = false;
  layout.mode = "working";
  layout.focus = "agent";
  layout.width = 1600;

  files.scope = "changed";
  files.view = "diff";
  files.selected = null;
});

describe("Pane shell", () => {
  it("takes focus when pointed at", async () => {
    render(SessionsPane);
    await fireEvent.pointerDown(screen.getByRole("region", { name: /projects/i }));
    expect(layout.focus).toBe("sessions");
  });

  it("marks only the focused pane", async () => {
    render(ChangesPane);
    const pane = screen.getByRole("region", { name: /changes/i });
    expect(pane).not.toHaveClass("focused");
    await fireEvent.pointerDown(pane);
    expect(pane).toHaveClass("focused");
  });

  it("will not take focus while its pane is closed", async () => {
    togglePane("changes");
    render(ChangesPane);
    await fireEvent.pointerDown(screen.getByRole("region", { name: /changes/i }));
    expect(layout.focus).toBe("agent");
  });
});

describe("SessionsPane", () => {
  it("lists projects and their sessions", () => {
    render(SessionsPane);
    expect(screen.getByText("coretura-platform")).toBeInTheDocument();
    expect(screen.getByText("auth-refactor")).toBeInTheDocument();
    expect(screen.getByText("hass-mcp-server")).toBeInTheDocument();
  });
});

describe("AgentPane", () => {
  it("says plainly that no agent is running yet", () => {
    render(AgentPane);
    expect(screen.getByText("not running")).toBeInTheDocument();
  });
});

describe("ChangesPane head", () => {
  it("carries both controls in one head", () => {
    render(ChangesPane);
    expect(screen.getByRole("group", { name: /which files/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /how to show/i })).toBeInTheDocument();
  });

  it("starts on changed files", () => {
    render(ChangesPane);
    expect(screen.getByRole("button", { name: "Changed" })).toHaveClass("on");
    expect(screen.getByRole("button", { name: "All files" })).not.toHaveClass("on");
  });

  it("widens the scope to show unchanged files", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByRole("button", { name: "All files" }));
    expect(screen.getByText("Cargo.toml")).toBeInTheDocument();
  });

  it("leaves the view controls disabled until a file is picked", () => {
    render(ChangesPane);
    expect(screen.getByRole("button", { name: "Diff" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Content" })).toBeDisabled();
  });

  // The connection between the two controls: no changes means no diff.
  it("disables Diff for a file that has no changes", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByRole("button", { name: "All files" }));
    await fireEvent.click(screen.getByText("Cargo.toml"));
    expect(screen.getByRole("button", { name: "Diff" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Content" })).toHaveClass("on");
  });
});

describe("ChangesPane list", () => {
  it("shows a status letter and line counts per file", () => {
    render(ChangesPane);
    const row = screen.getByText("src/cache/mod.rs").closest("button")!;
    expect(within(row).getByText("M")).toBeInTheDocument();
    expect(within(row).getByText("+18")).toBeInTheDocument();
    expect(within(row).getByText("−6")).toBeInTheDocument();
  });

  it("opens the viewer when a file is clicked", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByText("src/cache/mod.rs"));
    expect(layout.mode).toBe("reviewing");
    expect(files.selected).toBe("src/cache/mod.rs");
    expect(screen.getByTestId("viewer")).toBeInTheDocument();
  });
});

describe("ChangesPane while reviewing", () => {
  it("turns the list into a strip and keeps every file one click away", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByText("src/cache/mod.rs"));

    const strip = screen.getByRole("tablist");
    expect(within(strip).getAllByRole("tab")).toHaveLength(3);
    expect(within(strip).getByRole("tab", { name: /mod\.rs/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("switches files from the strip without leaving review", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByText("src/lib.rs"));
    await fireEvent.click(screen.getByRole("tab", { name: /token_cache\.rs/ }));
    expect(files.selected).toBe("src/token_cache.rs");
    expect(layout.mode).toBe("reviewing");
  });

  it("closes back to the list", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByText("src/lib.rs"));
    await fireEvent.click(screen.getByRole("button", { name: /close the viewer/i }));
    expect(layout.mode).toBe("working");
    expect(screen.queryByTestId("viewer")).not.toBeInTheDocument();
  });
});

describe("FileViewer", () => {
  it("shows the diff by default", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByText("src/cache/mod.rs"));

    const viewer = screen.getByTestId("viewer");
    expect(viewer).toHaveAttribute("data-view", "diff");
    expect(within(viewer).getByText("@@ -1,9 +1,12 @@")).toBeInTheDocument();
    expect(within(viewer).getByText("pub struct Cache {")).toBeInTheDocument();
  });

  it("switches to the whole file", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByText("src/cache/mod.rs"));
    await fireEvent.click(screen.getByRole("button", { name: "Content" }));

    const viewer = screen.getByTestId("viewer");
    expect(viewer).toHaveAttribute("data-view", "content");
    expect(within(viewer).queryByText("@@ -1,9 +1,12 @@")).not.toBeInTheDocument();
    expect(within(viewer).getByText("use std::collections::HashMap;")).toBeInTheDocument();
  });

  it("falls back to content for a file with no diff", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByRole("button", { name: "All files" }));
    await fireEvent.click(screen.getByText("Cargo.toml"));
    expect(screen.getByTestId("viewer")).toHaveAttribute("data-view", "content");
  });

  it("refuses to render a binary file", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByRole("button", { name: "All files" }));
    await fireEvent.click(screen.getByText("assets/icon.png"));
    expect(screen.getByText(/binary file/i)).toBeInTheDocument();
  });

  it("says so when a deleted file has no content to show", async () => {
    render(ChangesPane);
    await fireEvent.click(screen.getByText("src/token_cache.rs"));
    await fireEvent.click(screen.getByRole("button", { name: "Content" }));
    expect(screen.getByText(/deleted/i)).toBeInTheDocument();
  });
});
