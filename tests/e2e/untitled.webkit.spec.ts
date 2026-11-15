import { expect, test, type Page } from "@playwright/test";
import { installFakeCore, PROJECT } from "./fake";

/**
 * An untitled file in editor mode, in WebKit as well as Chromium: started
 * from a double-click on the empty tab row, the chord or the palette, typed
 * in, saved under a path asked for in a field over the editor, and closed
 * with and without text. What the user sees and where the keyboard is.
 */

const MOD = "ControlOrMeta";
const TREE = "[data-testid='file-tree']";
const SESSIONS = "section[data-pane='sessions']";
const ROW = "[data-testid='tab-row'] [role='tablist']";

const tab = (page: Page, path: string) => page.locator(`[data-testid='editor-tab'][data-path='${path}']`);
const treeRow = (page: Page, name: string) => page.locator(TREE).getByText(name, { exact: true });

async function open(page: Page, width = 1728) {
  await page.setViewportSize({ width, height: 900 });
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
}

async function flip(page: Page) {
  const was = await page.getByTestId("mode-readout").textContent();
  await page.keyboard.press(`${MOD}+Shift+E`);
  await expect(page.getByTestId("mode-readout")).not.toHaveText(was ?? "");
}

/** A double-click on the tab row near its end, where no tab is. */
async function doubleClickRow(page: Page) {
  const row = (await page.locator(ROW).boundingBox())!;
  await page.mouse.dblclick(row.x + row.width - 12, row.y + row.height / 2);
}

function writes(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __writes?: { file: string; text: string; overwrite: boolean }[] }).__writes ?? [],
  );
}

/** The tree each write went to, in order. */
function writeRoots(page: Page) {
  return page.evaluate(() => (window as unknown as { __writeRoots?: string[] }).__writeRoots ?? []);
}

function controls(page: Page) {
  return page.evaluate(() => (window as unknown as { __windowControls?: string[] }).__windowControls ?? []);
}

/** What has the keyboard: its test id, else its label, else its tag. */
function holder(page: Page) {
  return page.evaluate(() => {
    const owner = document.activeElement as HTMLElement | null;
    if (owner === null || owner === document.body) return null;
    return owner.getAttribute("data-testid") ?? owner.getAttribute("aria-label") ?? owner.tagName.toLowerCase();
  });
}

async function walk(page: Page, key: string, times: number) {
  const names: (string | null)[] = [];
  for (let at = 0; at < times; at++) {
    await page.keyboard.press(key);
    names.push(await holder(page));
  }
  return names;
}

test.describe("starting an untitled file", () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await flip(page);
  });

  test("keeps the tab row with nothing open, and says how to start one", async ({ page }) => {
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
    const row = (await page.locator(ROW).boundingBox())!;
    expect(row.width).toBeGreaterThan(200);
    expect(row.height).toBeGreaterThan(10);
    const empty = page.getByTestId("editor-empty");
    await expect(empty).toContainText("No file open");
    await expect(empty).toContainText(/(⌘N|Ctrl\+N)/);
    await expect(empty).toContainText("double-click on the tab row");
  });

  test("opens one on a double-click on the empty tab row, with the keyboard in it", async ({ page }) => {
    await doubleClickRow(page);
    await expect(tab(page, "Untitled")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".cm-content")).toBeFocused();
    await expect(page.getByTestId("editor-state")).toContainText("Not saved yet");
    await expect(page.getByTestId("editor-foot")).toContainText("Plain text");
    // Nothing typed: no dot, and nothing written.
    await expect(page.getByTestId("editor-tab-dirty")).toHaveCount(0);
    await page.keyboard.type("hello");
    await expect(tab(page, "Untitled").getByTestId("editor-tab-dirty")).toBeVisible();
    // The next is Untitled 2, after the one in front.
    await doubleClickRow(page);
    await expect(tab(page, "Untitled 2")).toHaveAttribute("aria-selected", "true");
    // A double-click on a tab keeps it, and makes no new one.
    await tab(page, "Untitled").dblclick();
    await expect(page.getByTestId("editor-tab")).toHaveCount(2);
    expect(await writes(page)).toEqual([]);
  });

  test("opens none on a double-click on the last tab's close button", async ({ page }) => {
    await treeRow(page, "README.md").dblclick();
    await expect(tab(page, "README.md")).toHaveAttribute("aria-selected", "true");
    const close = (await tab(page, "README.md").getByTestId("editor-tab-close").boundingBox())!;
    // The first press takes the tab away, and the second lands on the row
    // where it was.
    await page.mouse.dblclick(close.x + close.width / 2, close.y + close.height / 2);
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
    // A double-click on the row itself opens one, and it is the only one.
    await doubleClickRow(page);
    await expect(tab(page, "Untitled")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("editor-tab")).toHaveCount(1);
  });

  test("opens one on the chord from the tree, and from agent mode flips to the editor", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await expect(page.locator(TREE)).toBeFocused();
    await page.keyboard.press(`${MOD}+n`);
    await expect(tab(page, "Untitled")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".cm-content")).toBeFocused();

    await flip(page);
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    // The changes pane has the keyboard: on Windows and Linux the agent's
    // terminal keeps the chord.
    await page.keyboard.press(`${MOD}+3`);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
    await page.keyboard.press(`${MOD}+n`);
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
    await expect(tab(page, "Untitled 2")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".cm-content")).toBeFocused();
  });

  test("opens one from the command palette", async ({ page }) => {
    await page.keyboard.press(`${MOD}+Shift+P`);
    await page.keyboard.type("new untitled");
    await page.keyboard.press("Enter");
    await expect(tab(page, "Untitled")).toHaveAttribute("aria-selected", "true");
  });

  test("names no file to the agent while it is in front", async ({ page }) => {
    await treeRow(page, "README.md").click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __selection?: { selection: unknown } }).__selection?.selection))
      .toMatchObject({ file: expect.stringContaining("README.md") });
    await page.keyboard.press(`${MOD}+n`);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __selection?: { selection: unknown } }).__selection?.selection))
      .toBeNull();
  });
});

test.describe("saving an untitled file", () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await flip(page);
  });

  test("asks for a path over the editor, writes it there, and is that file from then on", async ({ page }) => {
    await page.keyboard.press(`${MOD}+3`);
    await page.keyboard.press(`${MOD}+n`);
    await page.keyboard.type("hello");
    await page.keyboard.press(`${MOD}+s`);
    const field = page.getByTestId("save-as-field");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Untitled");
    await expect(page.getByTestId("save-as")).toContainText("Save Untitled as");
    // Over the editor, above its text.
    const strip = (await page.getByTestId("save-as").boundingBox())!;
    const text = (await page.locator(".cm-content").boundingBox())!;
    expect(strip.y + strip.height).toBeLessThanOrEqual(text.y + 1);
    expect(await writes(page)).toEqual([]);

    // The name is selected: typing replaces it.
    await page.keyboard.type("notes.md");
    await page.keyboard.press("Enter");
    await expect(tab(page, "notes.md")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("save-as")).toHaveCount(0);
    expect(await writes(page)).toEqual([{ file: "notes.md", text: "hello", stamp: null, overwrite: false }]);
    await expect(treeRow(page, "notes.md")).toBeVisible();
    await expect(page.getByTestId("editor-state")).toHaveText("Saved");
    await expect(page.getByTestId("editor-foot")).toContainText("Markdown");
    await expect(page.locator(".cm-content")).toBeFocused();
    // An ordinary tab now: the next save writes the file in place.
    await page.keyboard.type(" again");
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.getByTestId("editor-state")).toHaveText("Saved");
    expect((await writes(page)).at(-1)).toMatchObject({ file: "notes.md", text: "hello again" });
  });

  test("starts in the folder the tree's cursor is in", async ({ page }) => {
    await treeRow(page, "store.rs").click();
    await page.keyboard.press(`${MOD}+n`);
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.getByTestId("save-as-field")).toHaveValue("src/cache/Untitled");
    await page.keyboard.type("lru.rs");
    await page.keyboard.press("Enter");
    await expect(tab(page, "src/cache/lru.rs")).toBeVisible();
    await expect(treeRow(page, "lru.rs")).toBeVisible();
  });

  test("says why a path will not do, and asks before replacing a file", async ({ page }) => {
    await page.keyboard.press(`${MOD}+3`);
    await page.keyboard.press(`${MOD}+n`);
    await page.keyboard.type("mine");
    await page.keyboard.press(`${MOD}+s`);
    const field = page.getByTestId("save-as-field");
    await field.fill("../outside.md");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("save-as-problem")).toHaveText(
      "The file is saved inside the project: give a path from its top.",
    );
    await expect(field).toBeFocused();
    // A path ending in a slash has no name.
    await field.fill("docs/");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("save-as-problem")).toHaveText("A name is needed.");
    await field.fill("README.md");
    await expect(page.getByTestId("save-as-problem")).toHaveCount(0);
    await page.keyboard.press("Enter");
    const replace = page.getByTestId("save-replace");
    await expect(replace).toContainText("Replace README.md?");
    await expect(page.getByTestId("save-replace-cancel")).toBeFocused();
    expect(await writes(page)).toEqual([]);
    // Escape goes back to the field, the path as it was.
    await page.keyboard.press("Escape");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("README.md");
    await page.keyboard.press("Enter");
    await page.getByTestId("save-replace-confirm").click();
    await expect(tab(page, "README.md")).toHaveAttribute("aria-selected", "true");
    expect(await writes(page)).toEqual([{ file: "README.md", text: "mine", stamp: null, overwrite: true }]);
  });

  test("puts the field away on Escape, the file still untitled", async ({ page }) => {
    await page.keyboard.press(`${MOD}+3`);
    await page.keyboard.press(`${MOD}+n`);
    await page.keyboard.type("draft");
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.getByTestId("save-as-field")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("save-as")).toHaveCount(0);
    await expect(tab(page, "Untitled")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await writes(page)).toEqual([]);
  });
});

test.describe("an untitled file of another project", () => {
  const TWO = "/home/ada/dev/two";

  /** Untitled text started beside demo, in the folder of the file the
      tree's cursor is on, then two brought to the front. */
  async function startInDemo(page: Page) {
    await page.setViewportSize({ width: 1728, height: 900 });
    await installFakeCore(page, { open: [PROJECT, TWO] });
    await page.goto("/");
    await expect(page.locator("section[data-pane='agent']")).toBeVisible();
    await page.locator(SESSIONS).getByText("demo", { exact: true }).click();
    await flip(page);
    await treeRow(page, "store.rs").click();
    await page.keyboard.press(`${MOD}+n`);
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.type("from demo");
    await page.locator(SESSIONS).getByText("two", { exact: true }).click();
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
  }

  test("is written to its own project on quit from another", async ({ page }) => {
    await startInDemo(page);
    await page.evaluate(() => (window as unknown as { __quit: () => void }).__quit());
    await expect(page.getByTestId("close-window")).toContainText("Untitled");
    await page.getByTestId("close-window-alternative").click();
    const field = page.getByTestId("save-as-field");
    await expect(field).toBeFocused();
    await expect(page.getByTestId("save-as-root")).toHaveText("demo/");
    await expect(field).toHaveValue("src/cache/Untitled");
    await page.keyboard.type("note.md");
    await page.keyboard.press("Enter");
    await expect.poll(() => controls(page)).toEqual(["quit"]);
    expect(await writes(page)).toEqual([{ file: "src/cache/note.md", text: "from demo", stamp: null, overwrite: false }]);
    expect(await writeRoots(page)).toEqual([PROJECT]);
    // The tab shown beside two while its path was asked goes once written.
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
  });

  test("is written to its own project when that project is closed from another", async ({ page }) => {
    await startInDemo(page);
    const head = page.locator(`${SESSIONS} [data-row="project:${PROJECT}"]`);
    await head.hover();
    await head.getByTestId("project-more").click();
    await head.getByTestId("close-project").click();
    const strip = page.getByTestId("close-owner");
    await expect(strip).toContainText("Close demo with unsaved edits?");
    await expect(strip).toContainText("Untitled");
    await page.getByTestId("close-owner-alternative").click();
    const field = page.getByTestId("save-as-field");
    await expect(field).toBeFocused();
    await expect(page.getByTestId("save-as-root")).toHaveText("demo/");
    await field.fill("from-demo.md");
    await page.keyboard.press("Enter");
    await expect(head).toHaveCount(0);
    expect(await writes(page)).toEqual([{ file: "from-demo.md", text: "from demo", stamp: null, overwrite: false }]);
    expect(await writeRoots(page)).toEqual([PROJECT]);
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
  });
});

test.describe("closing an untitled file", () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await flip(page);
    await page.keyboard.press(`${MOD}+3`);
    await page.keyboard.press(`${MOD}+n`);
    await expect(tab(page, "Untitled")).toBeVisible();
  });

  test("closes at once with nothing typed", async ({ page }) => {
    await tab(page, "Untitled").getByTestId("editor-tab-close").click();
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
    await expect(page.getByTestId("close-unsaved")).toHaveCount(0);
  });

  test("asks with text, and Save and close asks for the path, then closes", async ({ page }) => {
    await page.keyboard.type("draft");
    await tab(page, "Untitled").getByTestId("editor-tab-close").click();
    await expect(page.getByTestId("close-unsaved")).toContainText("Close Untitled with unsaved edits?");
    await page.getByTestId("close-unsaved-alternative").click();
    await expect(page.getByTestId("close-unsaved")).toHaveCount(0);
    await expect(page.getByTestId("save-as-field")).toBeFocused();
    await page.keyboard.type("kept.md");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
    expect(await writes(page)).toEqual([{ file: "kept.md", text: "draft", stamp: null, overwrite: false }]);
    await expect(treeRow(page, "kept.md")).toBeVisible();
  });

  test("drops the text on Close without saving, writing nothing", async ({ page }) => {
    await page.keyboard.type("draft");
    await tab(page, "Untitled").getByTestId("editor-tab-close").click();
    await page.getByTestId("close-unsaved-confirm").click();
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);
    expect(await writes(page)).toEqual([]);
  });

  test("asks on quit, then the path, and quits once it is written", async ({ page }) => {
    await page.keyboard.type("draft");
    await page.evaluate(() => (window as unknown as { __quit: () => void }).__quit());
    const strip = page.getByTestId("close-window");
    await expect(strip).toContainText("Quit with unsaved edits?");
    await expect(strip).toContainText("Untitled");
    await page.getByTestId("close-window-alternative").click();
    await expect(page.getByTestId("save-as-field")).toBeFocused();
    expect(await controls(page)).toEqual([]);
    await page.keyboard.type("draft.md");
    await page.keyboard.press("Enter");
    await expect.poll(() => controls(page)).toEqual(["quit"]);
    expect((await writes(page)).at(-1)).toMatchObject({ file: "draft.md", text: "draft" });
  });
});

test.describe("the keyboard", () => {
  test("keeps the tab row one stop, the untitled tab among the files", async ({ page }) => {
    await open(page);
    await flip(page);
    await treeRow(page, "README.md").dblclick();
    await page.keyboard.press(`${MOD}+n`);
    await expect(page.getByTestId("editor-tab")).toHaveCount(2);
    await page.locator(TREE).focus();
    const names = await walk(page, "Shift+Tab", 7);
    expect(names.filter((name) => name === "editor-tab")).toHaveLength(1);
    // Its stop is the tab in front, the untitled one; the arrows walk the
    // tabs, and Delete closes the empty one without a question.
    await page.getByTestId("search-field").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(tab(page, "Untitled")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "README.md")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "Untitled")).toBeFocused();
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("editor-tab")).toHaveCount(1);
    await expect(tab(page, "README.md")).toBeFocused();
  });

  test("goes round the path field and its buttons on Tab", async ({ page }) => {
    await open(page);
    await flip(page);
    await page.keyboard.press(`${MOD}+3`);
    await page.keyboard.press(`${MOD}+n`);
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.getByTestId("save-as-field")).toBeFocused();
    expect(await walk(page, "Tab", 3)).toEqual(["save-as-cancel", "save-as-save", "save-as-field"]);
    expect(await walk(page, "Shift+Tab", 1)).toEqual(["save-as-save"]);
  });

  test("lists the chord in the keys settings, where it can be moved", async ({ page }) => {
    await open(page);
    await page.keyboard.press(`${MOD}+,`);
    await page.getByTestId("settings-tab-keys").click();
    const chord = page.getByTestId("chord-file.untitled");
    await expect(chord).toHaveText(/^(⌘N|Ctrl\+N)$/);
    await chord.click();
    await page.keyboard.press(`${MOD}+Shift+u`);
    await expect(chord).toHaveText(/^(⌘⇧U|Ctrl\+Shift\+U)$/);
    await page.keyboard.press("Escape");
    await page.keyboard.press(`${MOD}+3`);
    await page.keyboard.press(`${MOD}+Shift+u`);
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
    await expect(tab(page, "Untitled")).toBeVisible();
  });
});

test.describe("on Windows and Linux", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" }));
  });

  test("leaves Ctrl+N to a terminal, and takes it from the tree", async ({ page }) => {
    await open(page);
    await page.keyboard.press("Control+j");
    await expect(page.getByTestId("terminal-row")).toHaveCount(1);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: terminal");
    await expect(page.locator("section[data-pane='terminal'] .xterm-helper-textarea").first()).toBeFocused();
    await page.keyboard.press("Control+n");
    await expect
      .poll(() =>
        page.evaluate(() =>
          ((window as unknown as { __written?: [string, string][] }).__written ?? []).map(([, data]) => data),
        ),
      )
      .toContain("\u000e");
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await expect(page.getByTestId("editor-tab")).toHaveCount(0);

    await page.keyboard.press("Control+Shift+E");
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
    await treeRow(page, "README.md").click();
    await page.keyboard.press("Control+n");
    await expect(tab(page, "Untitled")).toHaveAttribute("aria-selected", "true");
  });
});
