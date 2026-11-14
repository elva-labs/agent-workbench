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
  });

  test("is in the command palette with its chord", async ({ page }) => {
    await open(page, 1728);
    await page.keyboard.press(`${MOD}+Shift+P`);
    await page.keyboard.type("editor in the middle");
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
    await expect(page.getByTestId("editor-view-preview")).toBeDisabled();
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
    await expect(page.locator(".cm-search input[name='search']")).toBeFocused();
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

  test("shows the file in front in the viewer beside the agent on the viewer's chord", async ({ page }) => {
    await open(page, 1728);
    await flip(page);
    await treeRow(page, "README.md").click();
    await expect.poll(() => editorText(page)).toContain("// README.md");
    await page.keyboard.press(`${MOD}+d`);
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.getByTestId("viewer")).toContainText("// README.md");
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
