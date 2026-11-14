import { expect, test, type Page } from "@playwright/test";
import { installFakeCore } from "./fake";

/**
 * Editor mode: the file tree and an editor in the middle, the agent on the
 * right. What the user sees of the shape, the switch and what gives way.
 */

const SESSIONS = "section[data-pane='sessions']";
const AGENT = "section[data-pane='agent']";
const FILES = "section[data-pane='changes']";
const MOD = "ControlOrMeta";
const FOLDED = 50;

async function box(page: Page, selector: string) {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} is not visible`);
  return found;
}

/** Waits for the grid to hold still: two frames apart, it reads the same. */
async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const shell = document.querySelector("[data-testid='shell']")!;
            const read = () => getComputedStyle(shell).gridTemplateColumns;
            const first = read();
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(read() === first)));
          }),
      ),
    )
    .toBe(true);
}

/** Waits for the panes to arrive where a flip put them: the drawing of the
    way between the two layouts covers the window until it ends. */
async function arrived(page: Page) {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition"))
        .length === 0,
  );
  await settled(page);
}

async function flip(page: Page) {
  const was = await page.getByTestId("mode-readout").textContent();
  await page.keyboard.press(`${MOD}+Shift+E`);
  await expect(page.getByTestId("mode-readout")).not.toHaveText(was ?? "");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await arrived(page);
}

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
}

test.describe("the editing shape", () => {
  test("puts the files pane in the middle and the agent on the right", async ({ page }) => {
    await open(page, 1728);
    const before = await box(page, AGENT);
    await flip(page);
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");

    const agent = await box(page, AGENT);
    const files = await box(page, FILES);
    expect(files.x).toBeLessThan(agent.x);
    expect(agent.x + agent.width).toBeGreaterThan(1728 - 30);
    expect(Math.round(agent.width)).toBeGreaterThanOrEqual(419);
    expect(Math.round(agent.width)).toBeLessThanOrEqual(422);
    expect(agent.x).toBeGreaterThan(before.x);

    // The tree keeps a column on the left of the files pane, and the
    // editor takes the rest.
    const tree = await box(page, "[data-testid='tree-column']");
    const editor = await box(page, "[data-testid='editor-column']");
    expect(Math.round(tree.width)).toBe(240);
    expect(editor.x).toBeGreaterThan(tree.x + tree.width - 1);
    expect(editor.width).toBeGreaterThanOrEqual(640);
    // A comfortable window keeps the sessions pane open.
    expect((await box(page, SESSIONS)).width).toBeGreaterThan(FOLDED + 1);
  });

  test("folds the sessions pane at 1440 so the editor keeps its room", async ({ page }) => {
    await open(page, 1440);
    await flip(page);
    await expect.poll(async () => (await box(page, SESSIONS)).width).toBeLessThanOrEqual(FOLDED + 1);
    const editor = await box(page, "[data-testid='editor-column']");
    expect(editor.width).toBeGreaterThanOrEqual(640);
    await expect(page.locator("[data-testid='tree-column']")).toBeVisible();

    // Forced, not chosen: back in agent mode the pane is open again.
    await flip(page);
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await expect.poll(async () => (await box(page, SESSIONS)).width).toBeGreaterThan(FOLDED + 1);
  });

  test("gives up the tree's column, then hides the agent, as the window narrows", async ({ page }) => {
    await open(page, 1440);
    await flip(page);
    await page.setViewportSize({ width: 1200, height: 900 });
    await settled(page);
    await expect(page.locator("[data-testid='tree-column']")).toBeHidden();
    await expect(page.locator(AGENT)).toBeVisible();
    expect((await box(page, "[data-testid='editor-column']")).width).toBeGreaterThanOrEqual(640);

    await page.setViewportSize({ width: 1000, height: 900 });
    await settled(page);
    await expect(page.locator(AGENT)).toBeHidden();
    await expect(page.locator("[data-testid='editor-column']")).toBeVisible();

    await page.setViewportSize({ width: 1728, height: 900 });
    await settled(page);
    await expect(page.locator(AGENT)).toBeVisible();
    await expect(page.locator("[data-testid='tree-column']")).toBeVisible();
  });

  test("peeks the folded sessions pane over the files from its column", async ({ page }) => {
    await open(page, 1440);
    await flip(page);
    await expect.poll(async () => (await box(page, SESSIONS)).width).toBeLessThanOrEqual(FOLDED + 1);
    const files = await box(page, FILES);
    await page.getByTestId("unfold-sessions").click();
    await expect.poll(async () => (await box(page, SESSIONS)).width).toBeGreaterThan(FOLDED + 1);
    // Drawn over the files pane: nothing beside it moved.
    expect((await box(page, FILES)).x).toBe(files.x);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");

    await page.keyboard.press("Escape");
    await expect.poll(async () => (await box(page, SESSIONS)).width).toBeLessThanOrEqual(FOLDED + 1);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
  });
});

test.describe("the switch", () => {
  test("stands in the same place in both modes and flips on a click", async ({ page }) => {
    await open(page, 1728);
    const before = await box(page, "[data-testid='corner']");
    await expect(page.getByTestId("mode-agent")).toHaveAttribute("aria-checked", "true");

    await page.getByTestId("mode-editor").click();
    await settled(page);
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
    await expect(page.getByTestId("mode-editor")).toHaveAttribute("aria-checked", "true");
    const after = await box(page, "[data-testid='corner']");
    expect(Math.abs(after.x + after.width - (before.x + before.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    // In the agent's header now, which is the rightmost.
    await expect(page.locator(`${AGENT} [data-testid='corner']`)).toBeVisible();

    await page.getByTestId("mode-agent").click();
    await settled(page);
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await expect(page.locator(`${FILES} [data-testid='corner']`)).toBeVisible();
  });

  test("keeps the window's mode across a restart", async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    await page.reload();
    await expect(page.locator(AGENT)).toBeVisible();
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
    // Every file is listed, not only what changed.
    await expect(page.locator("[data-testid='file-tree']").getByText("README.md", { exact: true })).toBeVisible();
  });

  test("is in the command palette with its chord", async ({ page }) => {
    await open(page, 1728);
    await page.keyboard.press(`${MOD}+Shift+P`);
    await page.keyboard.type("editor mode");
    await page.keyboard.press("Enter");
    await settled(page);
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
  });
});

test.describe("the right pane", () => {
  test("is the agent while editing: the button and the chord hide and show it", async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    await page.getByTestId("toggle-right").click();
    await settled(page);
    await expect(page.locator(AGENT)).toBeHidden();
    // The corner moves to the files pane's header, at the same edge.
    const corner = await box(page, `${FILES} [data-testid='corner']`);
    expect(corner.x + corner.width).toBeGreaterThan(1728 - 40);

    await page.keyboard.press(`${MOD}+\\`);
    await settled(page);
    await expect(page.locator(AGENT)).toBeVisible();
  });

  test("is the changes pane in agent mode", async ({ page }) => {
    await open(page, 1728);
    await page.getByTestId("toggle-right").click();
    await settled(page);
    await expect(page.locator(FILES)).toBeHidden();
    await expect(page.locator(`${AGENT} [data-testid='corner']`)).toBeVisible();
  });

  test("drags wider and narrower, and keeps its own width", async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    const splitter = page.getByRole("separator", { name: "Resize the agent" });
    const handle = await splitter.boundingBox();
    if (!handle) throw new Error("no splitter");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
    await page.mouse.down();
    await page.mouse.move(handle.x - 80, handle.y + 200, { steps: 4 });
    await page.mouse.up();
    const agent = await box(page, AGENT);
    expect(Math.round(agent.width)).toBeGreaterThanOrEqual(495);

    // Agent mode keeps its own widths; editing gets this one back.
    await flip(page);
    await flip(page);
    expect(Math.round((await box(page, AGENT)).width)).toBe(Math.round(agent.width));
  });
});

test.describe("the agent across the flip", () => {
  test("is told one new size per flip", async ({ page }) => {
    await open(page, 1728);
    await page.getByTestId("start-agent").click();
    const cols = () =>
      page.evaluate(
        () =>
          (window as unknown as { __WORKBENCH_TERMINALS__?: Record<string, { cols: number }> })
            .__WORKBENCH_TERMINALS__?.["s1"]?.cols ?? 0,
      );
    const resizes = () =>
      page.evaluate(() => (window as unknown as { __resizes?: unknown[] }).__resizes?.length ?? 0);
    await expect.poll(cols).toBeGreaterThan(0);
    const wide = await cols();
    const told = await resizes();

    await flip(page);
    await expect.poll(cols).toBeLessThan(wide);
    await page.waitForTimeout(300);
    expect(await resizes()).toBe(told + 1);

    await flip(page);
    await expect.poll(cols).toBe(wide);
    await page.waitForTimeout(300);
    expect(await resizes()).toBe(told + 2);
  });
});

const TREE = "[data-testid='file-tree']";
const tab = (page: Page, path: string) => page.locator(`[data-testid='editor-tab'][data-path='${path}']`);
const treeRow = (page: Page, name: string) => page.locator(TREE).getByText(name, { exact: true });

/** The editor's text as it is drawn. */
function editorText(page: Page) {
  return page.locator(".cm-content").innerText();
}

test.describe("the editor and its tabs", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1728);
    await flip(page);
  });

  test("says what to do with nothing open", async ({ page }) => {
    await expect(page.getByTestId("editor-empty")).toContainText("No file open");
    await expect(page.getByTestId("editor-empty")).toContainText("start a new one");
  });

  test("opens a file looked at in an italic tab, reused for the next", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await expect(tab(page, "README.md")).toBeVisible();
    await expect(tab(page, "README.md").locator(".name")).toHaveCSS("font-style", "italic");
    await expect.poll(() => editorText(page)).toContain("// README.md");
    // The keyboard stays in the tree for the next file.
    await expect(page.locator(TREE)).toBeFocused();

    await treeRow(page, "Cargo.toml").click();
    await expect(tab(page, "Cargo.toml")).toBeVisible();
    await expect(tab(page, "README.md")).toHaveCount(0);

    // A double-click on the tab keeps it, so the next file gets its own.
    await tab(page, "Cargo.toml").dblclick();
    await expect(tab(page, "Cargo.toml").locator(".name")).toHaveCSS("font-style", "normal");
    await treeRow(page, "README.md").click();
    await expect(page.getByTestId("editor-tab")).toHaveCount(2);
  });

  test("marks the tab and the tree's row once edited, and keeps the tab", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await expect.poll(() => editorText(page)).toContain("// README.md");
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("more words");
    await expect(page.getByTestId("editor-tab-dirty")).toBeVisible();
    await expect(page.locator(`${TREE} [data-testid='tree-unsaved']`)).toBeVisible();
    await expect(page.getByTestId("editor-state")).toContainText("Unsaved");
    await expect(page.getByTestId("editor-position")).toHaveText(/Ln 4, Col 11/);
    await expect(tab(page, "README.md").locator(".name")).toHaveCSS("font-style", "normal");
    await expect(page.getByTestId("editor-foot")).toContainText("Markdown");
  });

  test("walks the views, and shows the diff and the rendering read only", async ({ page }) => {
    await treeRow(page, "mod.rs").click();
    await expect.poll(() => editorText(page)).toContain("// src/cache/mod.rs");
    // Preview is offered only for a file that has one.
    await expect(page.getByTestId("editor-view-preview")).toHaveCount(0);
    await page.getByTestId("editor-view-diff").click();
    await expect(page.getByTestId("viewer").getByText("@@ -1,9 +1,12 @@")).toBeVisible();
    await expect(page.getByTestId("editor-foot")).toContainText("Against HEAD, read only");
    await page.keyboard.press(`${MOD}+e`);
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(page.getByTestId("editor-view-edit")).toHaveAttribute("aria-checked", "true");
  });

  test("keeps each session's tabs", async ({ page }) => {
    await page.getByTestId("new-session").click();
    await expect(page.locator(AGENT)).toContainText("running");
    await treeRow(page, "README.md").dblclick();
    await expect(tab(page, "README.md")).toBeVisible();

    await page.getByTestId("new-session").click();
    await expect(page.locator("[data-testid='session-row']")).toHaveCount(2);
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
    await treeRow(page, "Cargo.toml").click();
    await expect(tab(page, "Cargo.toml")).toBeVisible();

    await page.locator("[data-testid='session-row']").first().click();
    await expect(tab(page, "README.md")).toBeVisible();
    await expect(tab(page, "Cargo.toml")).toHaveCount(0);
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
  });

  test("puts the keyboard in the editor and the tree on the focus chord and Escape", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await expect.poll(() => editorText(page)).toContain("// README.md");
    await page.keyboard.press(`${MOD}+2`);
    await page.keyboard.press(`${MOD}+3`);
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.press(`${MOD}+3`);
    await expect(page.locator(TREE)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".cm-content")).toBeFocused();
    // Escape in the editor is the editor's.
    await page.keyboard.press("Escape");
    await expect(page.locator(".cm-content")).toBeFocused();
  });

  test("finds in the file on the find chord while the editor has the keyboard", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await page.locator(".cm-content").click();
    await page.keyboard.press(`${MOD}+f`);
    await expect(page.getByTestId("find-field")).toBeFocused();
    await expect(page.getByTestId("search-field")).not.toBeFocused();
  });

  test("says why a file cannot be edited, and shows it as the viewer does", async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __fixture: { fixture: { files: string[] } } };
      w.__fixture.fixture.files = [...w.__fixture.fixture.files, "huge.log"];
      (window as unknown as { __gitChanged: () => void }).__gitChanged();
    });
    await treeRow(page, "huge.log").click();
    await expect(page.getByTestId("editor-reason")).toContainText("larger than 4 MB");
    await expect(page.getByTestId("viewer")).toContainText("// huge.log");
    await expect(page.locator(".cm-content")).toHaveCount(0);
  });
});

test.describe("from agent mode to the editor", () => {
  test("goes to the editor at the file and line from the viewer's Edit button", async ({ page }) => {
    await open(page, 1728);
    await page.evaluate(() =>
      (window as unknown as { __showRequest: (request: unknown) => void }).__showRequest({
        path: "/home/ada/dev/demo/src/main.rs",
        from: 3,
        to: 3,
        note: null,
        cwd: "/home/ada/dev/demo",
      }),
    );
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await page.getByTestId("viewer-edit").click();
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
    await expect(tab(page, "src/main.rs")).toBeVisible();
    await expect(page.getByTestId("editor-position")).toHaveText(/Ln 3, Col 1/);
    await expect(page.locator(".cm-content")).toBeFocused();
    // Kept: the Edit button is meant for editing.
    await expect(tab(page, "src/main.rs").locator(".name")).toHaveCSS("font-style", "normal");
  });

  test("leaves Cmd+D to the editor, which selects the next occurrence", async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    await treeRow(page, "README.md").click();
    await expect.poll(() => editorText(page)).toContain("// README.md");
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press(`${MOD}+d`);
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
    await expect(page.locator(".cm-content")).toBeFocused();
  });
});

test.describe("what a tool points at in editor mode", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1728);
    await flip(page);
  });

  test("opens a file as a tab at its line, with the note", async ({ page }) => {
    await page.evaluate(() =>
      (window as unknown as { __showRequest: (request: unknown) => void }).__showRequest({
        path: "/home/ada/dev/demo/src/main.rs",
        from: 3,
        to: 3,
        note: "The entry point.",
        cwd: "/home/ada/dev/demo",
      }),
    );
    await expect(tab(page, "src/main.rs")).toBeVisible();
    await expect(page.getByTestId("editor-note")).toHaveText("The entry point.");
    await expect(page.getByTestId("editor-position")).toHaveText(/Ln 3/);
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
  });

  test("opens a diff as the tab's Diff view", async ({ page }) => {
    await page.evaluate(() =>
      (window as unknown as { __diffRequest: (request: unknown) => void }).__diffRequest({
        path: "/home/ada/dev/demo/src/lib.rs",
        note: "What I changed.",
        cwd: "/home/ada/dev/demo",
      }),
    );
    await expect(tab(page, "src/lib.rs")).toBeVisible();
    await expect(page.getByTestId("editor-view-diff")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("viewer").getByText("@@ -1,9 +1,12 @@")).toBeVisible();
  });

  test("shows what was presented in the editor's place, and gives the editor back", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await page.evaluate(() =>
      (window as unknown as { __presentRequest: (request: unknown) => void }).__presentRequest({
        files: ["/tmp/shot.png"],
        caption: "The screenshot.",
        cwd: "/home/ada/dev/demo",
        session: null,
      }),
    );
    await expect(page.getByTestId("media-caption")).toHaveText("The screenshot.");
    await expect(page.locator(".cm-content")).toHaveCount(0);
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
    await page.getByTestId("viewer").getByRole("button", { name: "Close the viewer" }).click();
    await expect.poll(() => editorText(page)).toContain("// README.md");
  });
});

/** The writes the fake core took. */
function writes(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __writes?: { file: string; text: string; overwrite: boolean }[] }).__writes ?? [],
  );
}

/** Changes a file behind the editor's back, as the agent would. */
async function diskWrite(page: Page, file: string, text: string) {
  await page.evaluate(
    ({ file, text }) =>
      (window as unknown as { __disk: { write: (f: string, t: string) => void } }).__disk.write(file, text),
    { file, text },
  );
}

test.describe("saving and changes on disk", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    await treeRow(page, "README.md").click();
    await expect.poll(() => editorText(page)).toContain("// README.md");
  });

  test("writes nothing until saved, and saves on Cmd+S", async ({ page }) => {
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("mine");
    await expect(page.getByTestId("editor-tab-dirty")).toBeVisible();
    expect(await writes(page)).toEqual([]);
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.getByTestId("editor-state")).toHaveText("Saved");
    await expect(page.getByTestId("editor-tab-dirty")).toHaveCount(0);
    await expect(page.locator(`${TREE} [data-testid='tree-unsaved']`)).toHaveCount(0);
    expect(await writes(page)).toMatchObject([
      { file: "README.md", text: "use std::collections::HashMap;\n\n// README.md\nmine", overwrite: false },
    ]);
  });

  test("reads a change on disk in at once with no unsaved edits, keeping the cursor", async ({ page }) => {
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("editor-position")).toHaveText("Ln 3, Col 1");
    await diskWrite(page, "README.md", "use std::collections::HashMap;\n\n// README.md\nmore from the agent\n");
    await expect.poll(() => editorText(page)).toContain("more from the agent");
    await expect(page.getByTestId("editor-position")).toHaveText("Ln 3, Col 1");
    await expect(page.getByTestId("disk-bar")).toHaveCount(0);
    await expect(page.getByTestId("editor-state")).toHaveText("Saved");
  });

  test("raises the bar for a change on disk under unsaved edits, and compares", async ({ page }) => {
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("mine");
    await diskWrite(page, "README.md", "theirs\n");
    await expect(page.getByTestId("disk-bar")).toContainText("changed on disk while you have unsaved edits");
    await expect(page.getByTestId("editor-state")).toHaveText("Unsaved, and changed on disk");
    // The bar does not say who changed it.
    await expect(page.getByTestId("disk-bar")).not.toContainText("agent");

    await page.getByTestId("disk-compare").click();
    const compared = page.getByTestId("disk-compare-view");
    await expect(compared.locator("tr.del")).toHaveText(/theirs/);
    await expect(compared.locator("tr.add").last()).toHaveText(/mine/);
    await page.getByTestId("disk-compare").click();
    await expect(page.locator(".cm-content")).toBeVisible();

    // A save does not overwrite what changed underneath.
    await page.locator(".cm-content").click();
    await page.keyboard.press(`${MOD}+s`);
    expect(await writes(page)).toEqual([]);
  });

  test("writes mine over the disk on Keep mine", async ({ page }) => {
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("mine");
    await diskWrite(page, "README.md", "theirs\n");
    await page.getByTestId("disk-keep").click();
    await expect(page.getByTestId("disk-bar")).toHaveCount(0);
    await expect(page.getByTestId("editor-state")).toHaveText("Saved");
    expect((await writes(page)).at(-1)).toMatchObject({ file: "README.md", overwrite: true });
    expect((await writes(page)).at(-1)?.text).toContain("mine");
  });

  test("drops my edits for the disk's on Load from disk", async ({ page }) => {
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("mine");
    await diskWrite(page, "README.md", "theirs\n");
    await page.getByTestId("disk-load").click();
    await expect(page.getByTestId("disk-bar")).toHaveCount(0);
    await expect.poll(() => editorText(page)).toContain("theirs");
    expect(await editorText(page)).not.toContain("mine");
    await expect(page.getByTestId("editor-state")).toHaveText("Saved");
  });

  test("asks before closing a tab with unsaved edits", async ({ page }) => {
    await page.locator(".cm-content").click();
    await page.keyboard.type("mine");
    await tab(page, "README.md").hover();
    await page.getByTestId("editor-tab-close").click();
    await expect(page.getByTestId("close-unsaved")).toContainText("Close README.md with unsaved edits?");
    await expect(page.getByTestId("close-unsaved-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("close-unsaved")).toHaveCount(0);
    await expect(tab(page, "README.md")).toBeVisible();
    await expect(page.locator(".cm-content")).toBeFocused();

    await page.getByTestId("editor-tab-close").click();
    await page.getByTestId("close-unsaved-alternative").click();
    await expect(tab(page, "README.md")).toHaveCount(0);
    expect((await writes(page)).at(-1)?.text).toContain("mine");
    await expect(page.getByTestId("editor-empty")).toBeVisible();
  });
});

test.describe("the tree's own edits", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1728);
    await flip(page);
  });

  test("names a new file in place, in the cursor's folder, and opens it", async ({ page }) => {
    await treeRow(page, "store.rs").click();
    await page.keyboard.press(`${MOD}+Alt+n`);
    const field = page.getByTestId("name-field");
    await expect(field).toBeFocused();
    // In place: just under the cache folder's last file, a step in.
    const fieldBox = await box(page, "[data-testid='name-row']");
    const store = (await treeRow(page, "store.rs").boundingBox())!;
    expect(fieldBox.y).toBeGreaterThan(store.y);
    expect(fieldBox.y - store.y).toBeLessThan(store.height * 1.6);

    await page.keyboard.type("lru.rs");
    await page.keyboard.press("Enter");
    await expect(tab(page, "src/cache/lru.rs")).toBeVisible();
    await expect(treeRow(page, "lru.rs")).toBeVisible();
    await expect(page.locator(".cm-content")).toBeFocused();
    expect((await writes(page)).at(-1)).toMatchObject({ file: "src/cache/lru.rs", text: "" });
  });

  test("drops the field on Escape and keeps the keyboard in the tree", async ({ page }) => {
    await page.getByTestId("tree-new-file").click();
    await expect(page.getByTestId("name-field")).toBeFocused();
    await page.keyboard.type("nothing.rs");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("name-field")).toHaveCount(0);
    await expect(page.locator(TREE)).toBeFocused();
    expect(await writes(page)).toEqual([]);
  });

  test("shows a new folder open with a field for its first file, and makes both with it", async ({ page }) => {
    await treeRow(page, "cache").click({ button: "right" });
    await page.getByTestId("row-menu-new-folder").click();
    await page.keyboard.type("policy");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("pending-folder")).toHaveText(/policy/);
    expect(await writes(page)).toEqual([]);
    await page.keyboard.type("lfu.rs");
    await page.keyboard.press("Enter");
    await expect(tab(page, "src/cache/policy/lfu.rs")).toBeVisible();
    await expect(page.getByTestId("pending-folder")).toHaveCount(0);
    await expect(treeRow(page, "policy")).toBeVisible();
  });

  test("says why a name will not do, and keeps the field", async ({ page }) => {
    await page.getByTestId("tree-new-file").click();
    await page.keyboard.type("../out.rs");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("name-problem")).toHaveText("A name cannot step out of its folder.");
    await expect(page.getByTestId("name-field")).toBeFocused();
  });

  test("opens the row menu on a right-click, walked by the keyboard", async ({ page }) => {
    await treeRow(page, "store.rs").click({ button: "right" });
    const menu = page.getByTestId("row-menu");
    await expect(menu).toBeVisible();
    // The row the menu is for is marked while it is open.
    await expect(page.locator(`${TREE} [role='treeitem'].marked`)).toHaveText(/store\.rs/);
    await expect(menu.getByRole("menuitem")).toHaveText([
      /New file/,
      "New folder",
      "Rename",
      "Delete",
      "Copy path",
      /Reveal in Finder|Show in Explorer|Show in file manager/,
    ]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? []),
    ).toEqual(["src/cache/store.rs"]);
    await expect(menu).toHaveCount(0);

    await treeRow(page, "store.rs").click({ button: "right" });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.locator(TREE)).toBeFocused();
  });

  test("reveals a file of a local project in the platform's file manager", async ({ page }) => {
    await treeRow(page, "store.rs").click({ button: "right" });
    await page.getByTestId("row-menu-reveal").click();
    expect(
      await page.evaluate(() => (window as unknown as { __revealed?: string[] }).__revealed ?? []),
    ).toEqual(["/home/ada/dev/demo/src/cache/store.rs"]);
  });

  test("renames a row in place, and the tab on it follows", async ({ page }) => {
    await treeRow(page, "store.rs").dblclick();
    await expect(tab(page, "src/cache/store.rs")).toBeVisible();
    await treeRow(page, "store.rs").click({ button: "right" });
    await page.getByTestId("row-menu-rename").click();
    const field = page.getByTestId("name-field");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("store.rs");
    await page.keyboard.type("shelf");
    await page.keyboard.press("Enter");
    await expect(treeRow(page, "shelf.rs")).toBeVisible();
    await expect(tab(page, "src/cache/shelf.rs")).toBeVisible();
    await expect(tab(page, "src/cache/store.rs")).toHaveCount(0);
  });

  test("asks before deleting a folder, says what goes, and closes its tabs", async ({ page }) => {
    await treeRow(page, "store.rs").dblclick();
    await treeRow(page, "cache").click({ button: "right" });
    await page.getByTestId("row-menu-delete").click();
    const strip = page.getByTestId("delete-confirm");
    await expect(strip).toContainText("Delete src/cache and all 3 files?");
    await expect(strip).toContainText("not moved to the Trash");
    // The folder it is about is marked while the question is up.
    await expect(page.locator(`${TREE} [role='treeitem'].marked`)).toHaveText(/cache/);
    await expect(page.getByTestId("delete-confirm-cancel")).toBeFocused();
    await page.getByTestId("delete-confirm-confirm").click();
    await expect(treeRow(page, "cache")).toHaveCount(0);
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __deletes?: string[] }).__deletes ?? []),
    ).toEqual(["src/cache"]);
  });
});

/** Types at the end of the file in front. */
async function typeAtEnd(page: Page, text: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

function controls(page: Page) {
  return page.evaluate(() => (window as unknown as { __windowControls?: string[] }).__windowControls ?? []);
}

test.describe("questions before anything unsaved goes", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1728);
    await flip(page);
  });

  test("asks about the tab whose × was pressed, and puts the question away when another comes forward", async ({ page }) => {
    await treeRow(page, "README.md").dblclick();
    await typeAtEnd(page, "mine");
    await treeRow(page, "Cargo.toml").dblclick();
    await tab(page, "README.md").hover();
    await tab(page, "README.md").getByTestId("editor-tab-close").click();
    await expect(page.getByTestId("close-unsaved")).toContainText("Close README.md with unsaved edits?");
    // Save and close is the filled answer; Cancel has the keyboard.
    await expect(page.getByTestId("close-unsaved-alternative")).toHaveText("Save and close");
    await expect(page.getByTestId("close-unsaved-cancel")).toBeFocused();
    await tab(page, "Cargo.toml").click();
    await expect(page.getByTestId("close-unsaved")).toHaveCount(0);
    await expect(tab(page, "README.md").getByTestId("editor-tab-dirty")).toBeVisible();
  });

  test("asks before the window closes with unsaved edits, and closes once answered", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await typeAtEnd(page, "mine");
    await page.evaluate(() =>
      (window as unknown as { __WORKBENCH_CORE__: { windowControl: (a: string) => Promise<void> } }).__WORKBENCH_CORE__.windowControl("close"),
    );
    const strip = page.getByTestId("close-window");
    await expect(strip).toContainText("Close the window with unsaved edits?");
    await expect(strip).toContainText("README.md");
    expect(await controls(page)).toEqual([]);
    await page.getByTestId("close-window-cancel").click();
    await expect(strip).toHaveCount(0);

    await page.evaluate(() => (window as unknown as { __quit: () => void }).__quit());
    await expect(strip).toContainText("Quit with unsaved edits?");
    await page.getByTestId("close-window-alternative").click();
    await expect.poll(() => controls(page)).toEqual(["quit"]);
    expect((await writes(page)).at(-1)?.text).toContain("mine");
  });

  test("closes and quits at once with nothing unsaved", async ({ page }) => {
    await page.evaluate(() => (window as unknown as { __quit: () => void }).__quit());
    expect(await controls(page)).toEqual(["quit"]);
    await expect(page.getByTestId("close-window")).toHaveCount(0);
  });

  test("asks from agent mode too, over the whole window", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await typeAtEnd(page, "mine");
    await flip(page);
    await page.evaluate(() => (window as unknown as { __quit: () => void }).__quit());
    await expect(page.getByTestId("close-window")).toBeVisible();
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await page.getByTestId("close-window-confirm").click();
    await expect.poll(() => controls(page)).toEqual(["quit"]);
  });

  test("tells the core the question is up only once it is drawn", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await typeAtEnd(page, "mine");
    const leave = () =>
      page.evaluate(() => {
        const state = (window as unknown as { __leave: { asked: number; heard: number } }).__leave;
        return { asked: state.asked, heard: state.heard };
      });
    await page.evaluate(() => (window as unknown as { __quit: () => void }).__quit());
    await expect(page.getByTestId("leave-ask")).toBeVisible();
    await expect.poll(leave).toEqual({ asked: 1, heard: 1 });
  });

  test("stops a Save all and quit at a file that changed on disk, and says so", async ({ page }) => {
    await treeRow(page, "README.md").dblclick();
    await typeAtEnd(page, "mine");
    await diskWrite(page, "README.md", "theirs\n");
    await expect(page.getByTestId("disk-bar")).toBeVisible();
    await treeRow(page, "Cargo.toml").dblclick();
    await page.evaluate(() => (window as unknown as { __quit: () => void }).__quit());
    await page.getByTestId("close-window-alternative").click();
    await expect(page.getByTestId("flash-readout")).toHaveText("Quit stopped: README.md changed on disk");
    await expect(page.locator("[data-testid='editor-tab'][aria-selected='true']")).toHaveAttribute("data-path", "README.md");
    await expect(page.getByTestId("disk-bar")).toBeVisible();
    expect(await controls(page)).toEqual([]);
  });

  test("asks before a session with unsaved tabs is closed, in the sessions pane", async ({ page }) => {
    await page.getByTestId("new-session").click();
    await expect(page.locator(AGENT)).toContainText("running");
    await treeRow(page, "README.md").dblclick();
    await typeAtEnd(page, "mine");
    await page.locator("[data-testid='session-row']").first().hover();
    await page.locator(`${SESSIONS} [aria-label^='Close session']`).first().click();
    const strip = page.getByTestId("close-owner");
    await expect(strip).toContainText("with unsaved edits?");
    await expect(strip).toContainText("README.md");
    await page.getByTestId("close-owner-confirm").click();
    await expect(page.locator("[data-testid='session-row']")).toHaveCount(0);
    await expect(page.locator(`${TREE} [data-testid='tree-unsaved']`)).toHaveCount(0);
  });
});

test.describe("the File menu", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1728);
    await flip(page);
  });

  const menu = (page: Page, action: string) =>
    page.evaluate((action) => (window as unknown as { __menuAction: (a: string) => void }).__menuAction(action), action);

  test("closes the tab in front on Close Tab, and the tab on Cmd+W", async ({ page }) => {
    await treeRow(page, "README.md").dblclick();
    await treeRow(page, "Cargo.toml").dblclick();
    await menu(page, "file.close");
    await expect(tab(page, "Cargo.toml")).toHaveCount(0);
    await page.locator(".cm-content").click();
    await page.keyboard.press(`${MOD}+w`);
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
  });

  test("saves and starts a new file from its items", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await typeAtEnd(page, "mine");
    await menu(page, "file.save");
    await expect(page.getByTestId("editor-state")).toHaveText("Saved");
    await menu(page, "file.new");
    await expect(page.getByTestId("name-field")).toBeFocused();
  });

  test("shows the chords the table gives its items, and follows one the user moves", async ({ page }) => {
    const table = () =>
      page.evaluate(() => (window as unknown as { __menuKeys?: Record<string, { key: string; shift: boolean }> }).__menuKeys);
    await expect.poll(async () => (await table())?.["file.close"]?.key).toBe("w");
    await page.evaluate((file) => {
      const settings = JSON.parse(localStorage.getItem(file) ?? "{}");
      localStorage.setItem(file, JSON.stringify({ ...settings, keys: { "file.save": { key: "s", shift: true, alt: false } } }));
    }, "fake.settings");
    await page.reload();
    await expect(page.locator(AGENT)).toBeVisible();
    await expect.poll(async () => (await table())?.["file.save"]?.shift).toBe(true);
  });
});

test.describe("saving from the tree, and what the views say", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1728);
    await flip(page);
  });

  test("saves the file in front on Cmd+S with the keyboard in the tree", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await typeAtEnd(page, "mine");
    await page.keyboard.press(`${MOD}+3`);
    await expect(page.locator(TREE)).toBeFocused();
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.getByTestId("editor-state")).toHaveText("Saved");
  });

  test("says Diff shows the saved version while there are unsaved edits", async ({ page }) => {
    await treeRow(page, "mod.rs").click();
    await typeAtEnd(page, "mine");
    await page.getByTestId("editor-view-diff").click();
    await expect(page.getByTestId("saved-version")).toHaveText("The saved version");
  });

  test("leaves the viewer's views out of the tree's menu", async ({ page }) => {
    await page.getByTestId("changes-menu").click();
    await expect(page.getByTestId("menu-scope-all")).toBeVisible();
    await expect(page.getByTestId("menu-view-diff")).toHaveCount(0);
  });

  test("draws no tab in front while what was presented has the editor's place", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await page.evaluate(() =>
      (window as unknown as { __presentRequest: (request: unknown) => void }).__presentRequest({
        files: ["/tmp/shot.png"],
        caption: "The screenshot.",
        cwd: "/home/ada/dev/demo",
        session: null,
      }),
    );
    await expect(page.getByTestId("media-caption")).toBeVisible();
    await expect(page.locator("[data-testid='editor-tab'][aria-selected='true']")).toHaveCount(0);
    await expect(page.getByTestId("editor-views")).toHaveCount(0);
  });

  test("keeps the tab in front in view among many", async ({ page }) => {
    for (const name of ["Cargo.toml", "README.md", "main.rs", "lib.rs", "mod.rs", "store.rs", "eviction.rs"]) {
      await treeRow(page, name).dblclick();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await settled(page);
    await tab(page, "README.md").click();
    const strip = await box(page, "[data-testid='tab-row'] [role='tablist']");
    const front = await box(page, "[data-testid='editor-tab'][data-path='README.md']");
    expect(front.x).toBeGreaterThanOrEqual(strip.x - 1);
    expect(front.x + front.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
  });

  test("says the right pane has no room in a window too narrow for it", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await settled(page);
    await expect(page.locator(AGENT)).toBeHidden();
    await page.getByTestId("toggle-right").click();
    await expect(page.getByTestId("flash-readout")).toContainText("too narrow");
    await expect(page.getByTestId("toggle-right")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("the find bar", () => {
  test("is the app's own: its words, its toggles, and nothing to replace", async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    await treeRow(page, "README.md").click();
    await page.locator(".cm-content").click();
    await page.keyboard.press(`${MOD}+f`);
    const bar = page.getByTestId("find-bar");
    await expect(bar.getByRole("button", { name: "Previous" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Match case" })).toHaveAttribute("aria-pressed", "false");
    await expect(bar.locator("input[name='replace']")).toHaveCount(0);
    await page.keyboard.type("HashMap");
    await expect(page.getByTestId("find-count")).toHaveText("1 match");
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    await expect(page.locator(".cm-content")).toBeFocused();
  });
});

test.describe("a reload keeps the editor's place", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    await diskWrite(page, "README.md", `${lines}\n`);
    await treeRow(page, "README.md").click();
    await expect.poll(() => editorText(page)).toContain("line 1");
  });

  test("with a change above the cursor and one below it", async ({ page }) => {
    await page.locator(".cm-content").click();
    // Line 100, through the editor's own go-to-line.
    await page.keyboard.press(`${MOD}+Alt+g`);
    await page.keyboard.type("100");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("editor-position")).toHaveText("Ln 100, Col 1");
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    lines[1] = "line 2, from the agent";
    lines.splice(150, 0, "a new line from the agent");
    await diskWrite(page, "README.md", `${["import a", ...lines].join("\n")}\n`);
    // The cursor followed its line, one down for the line added above, and
    // the line under it is still line 100.
    await expect(page.getByTestId("editor-position")).toHaveText("Ln 101, Col 1");
    await expect(page.locator(".cm-activeLine")).toHaveText("line 100");
  });

  test("and leaves a preview tab a preview", async ({ page }) => {
    await expect(tab(page, "README.md").locator(".name")).toHaveCSS("font-style", "italic");
    await diskWrite(page, "README.md", "something else\n");
    await expect.poll(() => editorText(page)).toContain("something else");
    await expect(tab(page, "README.md").locator(".name")).toHaveCSS("font-style", "italic");
  });
});

test.describe("a file the disk no longer gives back", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    await treeRow(page, "README.md").dblclick();
    await typeAtEnd(page, "mine");
  });

  test("says deleted when it is gone, with Keep mine and Close without saving", async ({ page }) => {
    await page.evaluate(async () => {
      const core = (window as unknown as { __WORKBENCH_CORE__: { pathDelete: (r: string, p: string) => Promise<void> } }).__WORKBENCH_CORE__;
      await core.pathDelete("/home/ada/dev/demo", "README.md");
      (window as unknown as { __shownChanged: (files: string[]) => void }).__shownChanged(["/home/ada/dev/demo/README.md"]);
    });
    const bar = page.getByTestId("disk-bar");
    await expect(bar).toContainText("deleted on disk");
    await expect(page.getByTestId("disk-compare")).toHaveCount(0);
    await expect(page.getByTestId("disk-close")).toHaveText("Close without saving");
    await page.getByTestId("disk-keep").click();
    await expect(bar).toHaveCount(0);
    expect((await writes(page)).at(-1)).toMatchObject({ file: "README.md", overwrite: true });
  });

  test("says it could not be read, and why, when it is there but unreadable", async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as {
        __refusals: { binaryNow: Set<string> };
        __shownChanged: (files: string[]) => void;
      };
      w.__refusals.binaryNow.add("README.md");
      w.__shownChanged(["/home/ada/dev/demo/README.md"]);
    });
    const bar = page.getByTestId("disk-bar");
    await expect(bar).toContainText("could not be read from disk: README.md is a binary file");
    await expect(page.getByTestId("disk-retry")).toBeVisible();
    await expect(page.getByTestId("disk-close")).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __refusals: { binaryNow: Set<string> } }).__refusals.binaryNow.clear());
    await page.getByTestId("disk-retry").click();
    await expect(bar).toHaveCount(0);
  });

  test("says a save of a read-only file failed, on that file", async ({ page }) => {
    await page.evaluate(() => (window as unknown as { __refusals: { readOnly: Set<string> } }).__refusals.readOnly.add("README.md"));
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.getByTestId("editor-failed")).toHaveText("Could not save: README.md is read-only");
    await treeRow(page, "Cargo.toml").dblclick();
    await expect(page.getByTestId("editor-failed")).toHaveCount(0);
  });
});

test.describe("the tree's edits, round two", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, 1728);
    await flip(page);
  });

  test("puts a new file at the top until the cursor has been put somewhere", async ({ page }) => {
    await page.getByTestId("tree-new-file").click();
    await expect(page.getByTestId("name-field")).toHaveAttribute("placeholder", "Name of the new file");
    await page.keyboard.type("top.rs");
    await page.keyboard.press("Enter");
    await expect(tab(page, "top.rs")).toBeVisible();
  });

  test("makes the file when the field loses the keyboard with a name that will do", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await expect.poll(() => editorText(page)).toContain("// README.md");
    await page.getByTestId("tree-new-file").click();
    await page.keyboard.type("kept.md");
    await page.locator(".cm-content").click();
    await expect(tab(page, "kept.md")).toBeVisible();
  });

  test("says what the first file of a new folder is for", async ({ page }) => {
    await page.getByTestId("tree-new-folder").click();
    await page.keyboard.type("notes");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("name-field")).toHaveAttribute("placeholder", "Name of the first file");
  });

  test("opens the rename field at the row's own height", async ({ page }) => {
    const below = await box(page, `${TREE} [role='treeitem']:has-text('Cargo.toml')`);
    await treeRow(page, "README.md").click({ button: "right" });
    await page.getByTestId("row-menu-rename").click();
    await expect(page.getByTestId("name-field")).toBeFocused();
    const after = await box(page, `${TREE} [role='treeitem']:has-text('Cargo.toml')`);
    expect(Math.abs(after.y - below.y)).toBeLessThanOrEqual(1);
  });

  test("says why a delete was refused, over the tree", async ({ page }) => {
    await page.evaluate(() => (window as unknown as { __refusals: { nested: Set<string> } }).__refusals.nested.add("src/git"));
    await treeRow(page, "git").click({ button: "right" });
    await page.getByTestId("row-menu-delete").click();
    await page.getByTestId("delete-confirm-confirm").click();
    await expect(page.getByTestId("tree-failed")).toContainText("holds another repository or a worktree");
    await expect(treeRow(page, "git")).toBeVisible();
  });

  test("renames a file by its case alone", async ({ page }) => {
    await treeRow(page, "README.md").click({ button: "right" });
    await page.getByTestId("row-menu-rename").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("readme.md");
    await page.keyboard.press("Enter");
    await expect(treeRow(page, "readme.md")).toBeVisible();
  });

  test("keeps the cursor in the tree when the row under it goes", async ({ page }) => {
    await treeRow(page, "README.md").click({ button: "right" });
    await page.getByTestId("row-menu-delete").click();
    await page.getByTestId("delete-confirm-confirm").click();
    await expect(treeRow(page, "README.md")).toHaveCount(0);
    await page.locator(TREE).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-testid='processes-fold'].cursor")).toHaveCount(0);
  });
});

test.describe("unsaved edits in agent mode", () => {
  test("keep their dot in the tree", async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    await treeRow(page, "lib.rs").click();
    await typeAtEnd(page, "mine");
    await flip(page);
    await expect(page.locator(`${TREE} [data-testid='tree-unsaved']`)).toBeVisible();
  });
});

test.describe("the peek in editor mode", () => {
  test("covers the whole tree column", async ({ page }) => {
    await open(page, 1440);
    await flip(page);
    const tree = await box(page, "[data-testid='tree-column']");
    await page.getByTestId("unfold-sessions").click();
    await expect
      .poll(async () => {
        const sessions = await box(page, SESSIONS);
        return sessions.x + sessions.width;
      })
      .toBeGreaterThanOrEqual(tree.x + tree.width - 1);
  });
});

test.describe("the corner and the keyboard", () => {
  test("leaves the pane focus where it was when Tab reaches it", async ({ page }) => {
    await open(page, 1728);
    await page.keyboard.press(`${MOD}+3`);
    await page.getByTestId("toggle-right").focus();
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
  });
});

test.describe("the leave question with an orchestrator's board on screen", () => {
  test("is drawn over the board, and heard only then", async ({ page }) => {
    const ORCHESTRATOR = "/home/ada/.agent-workbench/orchestrator";
    await page.setViewportSize({ width: 1728, height: 1000 });
    await installFakeCore(page, { open: [ORCHESTRATOR, "/home/ada/dev/demo"] });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await page.getByTestId("start-agent").click();
    await expect(page.getByTestId("started-board")).toBeVisible();
    // Unsaved edits in the project, then back to the orchestrator in editor mode.
    await page.locator(`${SESSIONS} .project-row`).filter({ hasText: "demo" }).first().click();
    await flip(page);
    await treeRow(page, "README.md").click();
    await typeAtEnd(page, "mine");
    await page.locator(`${SESSIONS} [data-testid='session-row']`).first().click();
    await expect(page.getByTestId("started-board")).toBeVisible();
    await expect(page.getByTestId("editor-column")).toHaveCount(0);

    await page.evaluate(() => (window as unknown as { __quit: () => void }).__quit());
    await expect(page.getByTestId("leave-ask")).toBeVisible();
    await expect(page.getByTestId("leave-ask")).toContainText("Quit with unsaved edits?");
    expect(
      await page.evaluate(() => (window as unknown as { __leave: { heard: number } }).__leave.heard),
    ).toBe(1);
    await page.getByTestId("close-window-confirm").click();
    await expect.poll(() => controls(page)).toEqual(["quit"]);
  });
});

test.describe("the name field while the agent writes files", () => {
  test("stays the same field, text and all, and writes nothing", async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    await page.getByTestId("tree-new-file").click();
    await page.keyboard.type("half");
    await diskWrite(page, "aaa-new.rs", "fn new() {}\n");
    await expect(treeRow(page, "aaa-new.rs")).toBeVisible();
    const field = page.getByTestId("name-field");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("half");
    await page.keyboard.type("-done");
    await expect(field).toHaveValue("half-done");
    // The agent's file went to disk past the editor; the editor wrote nothing.
    expect(await writes(page)).toEqual([]);
  });

  test("leaves a folder's name as it is when the keyboard goes elsewhere", async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    await treeRow(page, "README.md").click();
    await expect.poll(() => editorText(page)).toContain("// README.md");
    await page.getByTestId("tree-new-folder").click();
    await page.keyboard.type("policy");
    await page.locator(".cm-content").click();
    await expect(page.getByTestId("name-field")).toHaveValue("policy");
    await expect(page.getByTestId("pending-folder")).toHaveCount(0);
  });
});

test.describe("Cmd+W with no tab in editor mode", () => {
  test("closes the window on macOS, as the menu's Close Tab does", async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await page.keyboard.press(`${MOD}+3`);
    await page.keyboard.press(`${MOD}+w`);
    expect(await controls(page)).toEqual(mac ? ["close"] : []);
  });
});

test.describe("the session question in a peek", () => {
  test("goes, closing nothing, when the peek is put away", async ({ page }) => {
    await open(page, 1440);
    await flip(page);
    await page.getByTestId("unfold-sessions").click();
    await page.getByTestId("new-session").click();
    await expect(page.locator(AGENT)).toContainText("running");
    await treeRow(page, "README.md").dblclick();
    await typeAtEnd(page, "mine");
    await page.getByTestId("unfold-sessions").click();
    await page.locator("[data-testid='session-row']").first().hover();
    await page.locator(`${SESSIONS} [aria-label^='Close session']`).first().click();
    await expect(page.getByTestId("close-owner")).toBeVisible();
    // The peek put away by its chord, from wherever the keyboard is.
    await page.keyboard.press(`${MOD}+1`);
    await expect.poll(async () => (await box(page, SESSIONS)).width).toBeLessThanOrEqual(FOLDED + 1);
    await page.getByTestId("unfold-sessions").click();
    await expect(page.getByTestId("close-owner")).toHaveCount(0);
    await expect(page.locator("[data-testid='session-row']")).toHaveCount(1);
  });
});

test.describe("many tabs, round two", () => {
  test("keep the whole name of the tab in front", async ({ page }) => {
    await open(page, 1440);
    await flip(page);
    for (const name of ["Cargo.toml", "README.md", "main.rs", "lib.rs", "mod.rs", "store.rs", "eviction.rs"]) {
      await treeRow(page, name).dblclick();
    }
    await tab(page, "README.md").click();
    const name = tab(page, "README.md").locator(".name");
    expect(await name.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    // A short name behind fits too.
    const short = tab(page, "src/cache/mod.rs").locator(".name");
    expect(await short.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  });
});

test.describe("the File menu's items", () => {
  test("say which can act", async ({ page }) => {
    await open(page, 1728);
    const state = () =>
      page.evaluate(() => (window as unknown as { __menuEnabled?: Record<string, boolean> }).__menuEnabled);
    await expect.poll(async () => (await state())?.["file.save"]).toBe(false);
    expect((await state())?.["file.new"]).toBe(true);
    await flip(page);
    await treeRow(page, "README.md").click();
    await expect.poll(async () => (await state())?.["file.save"]).toBe(true);
  });
});
