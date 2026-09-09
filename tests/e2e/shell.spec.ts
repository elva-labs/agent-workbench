import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

const SESSIONS = "section[data-pane='sessions']";
const AGENT = "section[data-pane='agent']";
const CHANGES = "section[data-pane='changes']";
const TREE = "[data-testid='file-tree']";

async function widthOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  return box.width;
}

/** Cmd on macOS, Ctrl elsewhere. */
const MOD = "ControlOrMeta";

/** Tree rows carry the basename, and only the changes pane has a tree. */
function row(page: Page, name: string) {
  return page.locator(TREE).getByText(name, { exact: true });
}

/** Scope and view live in the pane's menu: open it, pick, it closes. */
async function chooseAll(page: Page) {
  await page.getByTestId("changes-menu").click();
  await page.getByTestId("menu-scope-all").click();
}

async function chooseView(page: Page, view: "diff" | "content") {
  await page.getByTestId("changes-menu").click();
  await page.getByTestId(`menu-view-${view}`).click();
}

function rowNames(page: Page) {
  return page.locator(`${TREE} [role='treeitem'] .name`).allTextContents();
}

test.beforeEach(async ({ page }) => {
  // A repository to look at, so the tree and the viewer have real shapes.
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
});

test("opens with three panes and the agent focused", async ({ page }) => {
  await expect(page.locator(SESSIONS)).toBeVisible();
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator(CHANGES)).toBeVisible();
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  await expect(page.getByTestId("mode-readout")).toHaveText("working");
});

test("gives the agent pane the most room", async ({ page }) => {
  const [sessions, agent, changes] = await Promise.all([
    widthOf(page, SESSIONS),
    widthOf(page, AGENT),
    widthOf(page, CHANGES),
  ]);
  expect(agent).toBeGreaterThan(sessions);
  expect(agent).toBeGreaterThan(changes);
});

test("moves focus between panes by click and by keyboard", async ({ page }) => {
  await page.locator(SESSIONS).click();
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
  await expect(page.locator(SESSIONS)).toHaveClass(/focused/);

  await page.keyboard.press(`${MOD}+3`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");

  await page.keyboard.press(`${MOD}+2`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
});

test("drags the sessions splitter and keeps the width", async ({ page }) => {
  const before = await widthOf(page, SESSIONS);
  const handle = page.getByRole("separator", {
    name: "Resize projects and sessions",
  });
  const box = (await handle.boundingBox())!;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();

  const after = await widthOf(page, SESSIONS);
  expect(after).toBeGreaterThan(before + 60);

  await page.reload();
  await expect(page.locator(SESSIONS)).toBeVisible();
  expect(await widthOf(page, SESSIONS)).toBeCloseTo(after, 0);
});

test("resizes a pane from the keyboard and resets it", async ({ page }) => {
  const handle = page.getByRole("separator", {
    name: "Resize projects and sessions",
  });
  const before = await widthOf(page, SESSIONS);

  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(await widthOf(page, SESSIONS)).toBeCloseTo(before + 16, 0);

  await page.keyboard.press("Home");
  expect(await widthOf(page, SESSIONS)).toBeCloseTo(before, 0);
});

test("collapses and restores the side panes", async ({ page }) => {
  await page.keyboard.press(`${MOD}+b`);
  await expect(page.locator(SESSIONS)).toBeHidden();
  await expect(page.locator(AGENT)).toBeVisible();

  await page.keyboard.press(`${MOD}+\\`);
  await expect(page.locator(CHANGES)).toBeHidden();

  await page.keyboard.press(`${MOD}+b`);
  await expect(page.locator(SESSIONS)).toBeVisible();
});

test("cycles the theme and keeps the choice", async ({ page }) => {
  const html = page.locator("html");
  await page.keyboard.press(`${MOD}+Shift+T`);
  await expect(html).toHaveAttribute("data-theme", "light");

  await page.keyboard.press(`${MOD}+Shift+T`);
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.keyboard.press(`${MOD}+Shift+T`);
  await expect(html).not.toHaveAttribute("data-theme", /.*/);
});

test("repaints the panes when the theme changes", async ({ page }) => {
  const pane = page.locator(AGENT);
  const light = await pane.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await page.keyboard.press(`${MOD}+Shift+T`);
  await page.keyboard.press(`${MOD}+Shift+T`);
  const dark = await pane.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(dark).not.toBe(light);
});

test("does not scroll the window: the shell is chrome, not a document", async ({
  page,
}) => {
  const overflow = await page.evaluate(() => ({
    x:
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
    y:
      document.documentElement.scrollHeight >
      document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ x: false, y: false });
});

test.describe("responsive collapse", () => {
  test("folds the sessions pane away rather than squeezing the agent", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(page.locator(SESSIONS)).toBeHidden();
    await expect(page.locator(CHANGES)).toBeVisible();
    expect(await widthOf(page, AGENT)).toBeGreaterThanOrEqual(360);
  });

  test("folds the changes pane away too when the window is narrower still", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(page.locator(SESSIONS)).toBeHidden();
    await expect(page.locator(CHANGES)).toBeHidden();
    await expect(page.locator(AGENT)).toBeVisible();
    expect(await widthOf(page, AGENT)).toBeGreaterThanOrEqual(360);
  });

  // Half of a 1440 laptop. This is the case the window minimum has to allow.
  test("works at half of a 1440-wide display", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    await expect(page.locator(AGENT)).toBeVisible();
    expect(await widthOf(page, AGENT)).toBeGreaterThanOrEqual(360);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });

  test("brings the panes back when the window grows", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(page.locator(SESSIONS)).toBeHidden();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(SESSIONS)).toBeVisible();
    await expect(page.locator(CHANGES)).toBeVisible();
  });

  // A stint in split-screen must not permanently forget your preference.
  test("does not mistake a forced collapse for a choice", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(page.locator(SESSIONS)).toBeHidden();

    await page.reload();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(SESSIONS)).toBeVisible();
  });

  test("remembers a pane you actually closed", async ({ page }) => {
    await page.keyboard.press(`${MOD}+b`);
    await expect(page.locator(SESSIONS)).toBeHidden();

    await page.setViewportSize({ width: 600, height: 800 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(SESSIONS)).toBeHidden();
  });
});

test.describe("the file tree", () => {
  test("nests changed files under their folders", async ({ page }) => {
    await expect
      .poll(() => rowNames(page))
      .toEqual(["src", "cache", "mod.rs", "lib.rs", "token_cache.rs"]);
  });

  // Why the tree scales: widening the scope adds folders, not hundreds of rows.
  test("leaves folders with nothing changed shut", async ({ page }) => {
    await chooseAll(page);
    await expect.poll(() => rowNames(page)).toContain("docs");
    const names = await rowNames(page);

    expect(names).not.toContain("architecture.md");
    expect(names).toContain("store.rs");
  });

  test("opens and shuts a folder on click", async ({ page }) => {
    await chooseAll(page);

    await row(page, "docs").click();
    expect(await rowNames(page)).toContain("architecture.md");

    await row(page, "docs").click();
    expect(await rowNames(page)).not.toContain("architecture.md");
  });

  test("takes the keyboard on Cmd+3, so the arrows work at once", async ({
    page,
  }) => {
    await page.keyboard.press(`${MOD}+3`);
    await expect(page.locator(TREE)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
  });

  test("walks with the keyboard and opens with Enter", async ({ page }) => {
    await page.locator(TREE).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(
      page.getByTestId("viewer").getByText("@@ -1,9 +1,12 @@"),
    ).toBeVisible();
  });

  test("shuts a folder with the left arrow", async ({ page }) => {
    await page.locator(TREE).focus();
    await page.keyboard.press("ArrowLeft");
    expect(await rowNames(page)).toEqual(["src"]);
  });

  test("does not scroll the pane sideways on a deep path", async ({ page }) => {
    await chooseAll(page);
    const overflow = await page
      .locator(TREE)
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
  });
});

test.describe("the file viewer", () => {
  // The agent's show tool: the file opens where it pointed, the lines
  // marked, its note above them, whatever git thinks of the file.
  test("opens where the agent asked to show, with the note", async ({
    page,
  }) => {
    await page.evaluate(() =>
      (
        window as unknown as { __showRequest: (request: unknown) => void }
      ).__showRequest({
        path: "/home/ada/dev/demo/src/main.rs",
        from: 2,
        to: 3,
        note: "The entry point.",
        cwd: "/home/ada/dev/demo",
      }),
    );
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.getByTestId("viewer-note")).toHaveText(
      "The entry point.",
    );
    const marked = page.getByTestId("viewer").locator("tr.target");
    await expect(marked).toHaveCount(2);
    await expect(marked.first().locator(".num")).toHaveText("2");
  });

  // The agent's present tool: the first file on screen with the caption,
  // every file as a preview beneath, arrows and clicks to move, and the
  // item kept on the pane's media list to open again.
  test("presents the agent's files in a modal and keeps them on the list", async ({
    page,
  }) => {
    await page.evaluate(
      (project) =>
        (
          window as unknown as {
            __presentRequest: (request: unknown) => void;
          }
        ).__presentRequest({
          files: [
            `${project}/shots/one.png`,
            `${project}/shots/two.png`,
            `${project}/docs/plan.pdf`,
          ],
          caption: "Before, after, and the plan.",
          cwd: project,
        }),
      PROJECT,
    );
    const modal = page.getByTestId("media");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("media-caption")).toHaveText(
      "Before, after, and the plan.",
    );
    await expect(page.getByTestId("media-count")).toHaveText("1 of 3");
    await expect(modal.locator(".stage img")).toBeVisible();
    await expect(page.getByTestId("media-preview")).toHaveCount(3);

    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("media-count")).toHaveText("2 of 3");
    await page.getByTestId("media-preview").nth(2).click();
    await expect(page.getByTestId("media-count")).toHaveText("3 of 3");
    await expect(modal.locator(".stage embed")).toHaveAttribute(
      "type",
      "application/pdf",
    );
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("media-count")).toHaveText("3 of 3");

    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId("media-fold")).toContainText("Media (1)");
    await expect(page.getByTestId("media-item")).toContainText(
      "Before, after, and the plan.",
    );
    await page.getByTestId("media-item").click();
    await expect(page.getByTestId("media")).toBeVisible();
    await expect(page.getByTestId("media-count")).toHaveText("1 of 3");
  });

  test("opens by clicking a file, and the changes pane grows", async ({
    page,
  }) => {
    const before = await widthOf(page, CHANGES);
    await row(page, "mod.rs").click();

    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.getByTestId("viewer")).toBeVisible();
    expect(await widthOf(page, CHANGES)).toBeGreaterThan(before);
  });

  // The tree keeps the pane's left column; the content takes the rest.
  test("puts the tree beside the content, not above it", async ({ page }) => {
    await row(page, "mod.rs").click();

    const tree = (await page.locator(TREE).boundingBox())!;
    const viewer = (await page.getByTestId("viewer").boundingBox())!;
    expect(viewer.x).toBeGreaterThanOrEqual(tree.x + tree.width);
    expect(Math.abs(viewer.y - tree.y)).toBeLessThan(2);
  });

  test("folds the sessions pane away and keeps the agent visible", async ({
    page,
  }) => {
    await row(page, "mod.rs").click();
    await expect(page.locator(SESSIONS)).toBeHidden();
    await expect(page.locator(AGENT)).toBeVisible();
    expect(await widthOf(page, AGENT)).toBeGreaterThanOrEqual(360);
  });

  test("closes on Escape and leaves the keyboard in the tree", async ({
    page,
  }) => {
    await page.locator(TREE).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("viewer")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await expect(page.getByTestId("viewer")).toHaveCount(0);
    await expect(page.locator(TREE)).toBeFocused();
    // The arrows still walk the tree; nothing went to the agent.
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(TREE)).toBeFocused();
  });

  test("shows the diff first", async ({ page }) => {
    await row(page, "mod.rs").click();
    const viewer = page.getByTestId("viewer");
    await expect(viewer).toHaveAttribute("data-view", "diff");
    await expect(viewer.getByText("@@ -1,9 +1,12 @@")).toBeVisible();
  });

  test("switches to the whole file and back", async ({ page }) => {
    await row(page, "mod.rs").click();
    const viewer = page.getByTestId("viewer");

    await chooseView(page, "content");
    await expect(viewer).toHaveAttribute("data-view", "content");
    await expect(viewer.getByText("@@ -1,9 +1,12 @@")).toHaveCount(0);

    await chooseView(page, "diff");
    await expect(viewer).toHaveAttribute("data-view", "diff");
  });

  test("switches view from the keyboard", async ({ page }) => {
    await row(page, "mod.rs").click();
    await page.keyboard.press(`${MOD}+e`);
    await expect(page.getByTestId("viewer")).toHaveAttribute(
      "data-view",
      "content",
    );
  });

  test("switches files from the tree without moving the layout", async ({
    page,
  }) => {
    await row(page, "mod.rs").click();
    const agentWidth = await widthOf(page, AGENT);
    const treeWidth = await widthOf(page, TREE);

    await row(page, "lib.rs").click();
    await expect(
      page.getByTestId("viewer").getByText("// src/lib.rs"),
    ).toBeVisible();

    expect(await widthOf(page, AGENT)).toBeCloseTo(agentWidth, 0);
    expect(await widthOf(page, TREE)).toBeCloseTo(treeWidth, 0);
  });

  test("resizes the tree against the content", async ({ page }) => {
    await row(page, "mod.rs").click();
    const before = await widthOf(page, TREE);

    const handle = page.getByRole("separator", {
      name: "Resize the file tree",
    });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, {
      steps: 6,
    });
    await page.mouse.up();

    expect(await widthOf(page, TREE)).toBeGreaterThan(before + 40);
  });

  test("resizes the whole pane against the agent", async ({ page }) => {
    await row(page, "mod.rs").click();
    const before = await widthOf(page, CHANGES);

    const handle = page.getByRole("separator", { name: "Resize the viewer" });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();

    expect(await widthOf(page, CHANGES)).toBeGreaterThan(before + 60);
    expect(await widthOf(page, AGENT)).toBeGreaterThanOrEqual(360);
  });

  test("widens the scope and falls back to content for an unchanged file", async ({
    page,
  }) => {
    await chooseAll(page);
    await row(page, "Cargo.toml").click();

    await expect(page.getByTestId("viewer")).toHaveAttribute(
      "data-view",
      "content",
    );
    await page.getByTestId("changes-menu").click();
    await expect(page.getByTestId("menu-view-diff")).toBeDisabled();
    await page.keyboard.press("Escape");
  });

  test("closes on Escape and restores the sessions pane", async ({ page }) => {
    await row(page, "mod.rs").click();
    await expect(page.locator(SESSIONS)).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await expect(page.locator(SESSIONS)).toBeVisible();
    await expect(page.locator(TREE)).toBeVisible();
    // Done with the file: nothing stays highlighted.
    await expect(page.locator(`${TREE} [aria-selected='true']`)).toHaveCount(0);
  });

  test("lets the file go on a click below the tree, and closes the viewer", async ({
    page,
  }) => {
    await row(page, "mod.rs").click();
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");

    const tree = await page.locator(TREE).boundingBox();
    if (!tree) throw new Error("no tree");
    await page.mouse.click(tree.x + tree.width / 2, tree.y + tree.height - 10);
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await expect(page.locator(`${TREE} [aria-selected='true']`)).toHaveCount(0);

    // Without the viewer open it just clears the highlight.
    await row(page, "mod.rs").click();
    await page.keyboard.press("Escape");
    await expect(page.locator(`${TREE} [aria-selected='true']`)).toHaveCount(0);
  });

  test("opens and closes on the keyboard too", async ({ page }) => {
    await page.keyboard.press(`${MOD}+d`);
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await page.keyboard.press(`${MOD}+d`);
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
  });

  test("hides the agent rather than squeezing it in a narrow window", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    await page.keyboard.press(`${MOD}+d`);

    await expect(page.getByTestId("viewer")).toBeVisible();
    await expect(page.locator(AGENT)).toBeHidden();
  });

  test("gives the agent back at exactly its old width", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    const before = await widthOf(page, AGENT);

    await page.keyboard.press(`${MOD}+d`);
    await expect(page.locator(AGENT)).toBeHidden();
    await page.keyboard.press(`${MOD}+d`);

    await expect(page.locator(AGENT)).toBeVisible();
    expect(await widthOf(page, AGENT)).toBeCloseTo(before, 0);
  });

  test("remembers the working and reviewing widths separately", async ({
    page,
  }) => {
    const working = await widthOf(page, CHANGES);
    await row(page, "mod.rs").click();
    const reviewing = await widthOf(page, CHANGES);
    expect(reviewing).toBeGreaterThan(working);

    await page.keyboard.press("Escape");
    expect(await widthOf(page, CHANGES)).toBeCloseTo(working, 0);

    await page.keyboard.press(`${MOD}+d`);
    expect(await widthOf(page, CHANGES)).toBeCloseTo(reviewing, 0);
  });
});

test.describe("the search field", () => {
  test("narrows the tree as you type, and clears on Escape", async ({
    page,
  }) => {
    const field = page.getByTestId("search-field");
    await field.fill("cache");
    await expect
      .poll(() => rowNames(page))
      .toEqual(["src", "cache", "mod.rs", "token_cache.rs"]);
    await field.press("Escape");
    await expect(field).toHaveValue("");
    await expect.poll(() => rowNames(page)).toContain("lib.rs");
  });

  test("searches inside files and opens a file at the line", async ({
    page,
  }) => {
    await page.getByTestId("mode-lines").click();
    await page.getByTestId("search-field").fill("struct cache");
    await expect(page.getByTestId("search-hit")).toHaveCount(1);
    await expect(page.getByTestId("search-file")).toContainText(
      "src/cache/mod.rs",
    );
    await expect(page.getByTestId("search-hit").locator("mark")).toHaveText(
      "struct Cache",
    );

    await page.getByTestId("search-hit").click();
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.getByTestId("viewer")).toHaveAttribute(
      "data-view",
      "content",
    );
    const marked = page.locator("[data-testid='viewer'] tr.target");
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText("// src/cache/mod.rs");
    await expect(marked).toBeInViewport();
  });

  test("says when the list was cut", async ({ page }) => {
    await page.getByTestId("mode-lines").click();
    await page.getByTestId("search-field").fill("flood");
    await expect(page.getByTestId("search-truncated")).toBeVisible();
  });

  test("takes the keyboard on its chords", async ({ page }) => {
    // Shift+mod+F from the agent: the field, in lines mode.
    await page.keyboard.press(`${MOD}+Shift+f`);
    await expect(page.getByTestId("search-field")).toBeFocused();
    await expect(page.getByTestId("mode-lines")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Plain mod+F only counts outside the terminals.
    await page.keyboard.press(`${MOD}+2`);
    await page.keyboard.press(`${MOD}+f`);
    await expect(page.getByTestId("search-field")).not.toBeFocused();
    await page.keyboard.press(`${MOD}+3`);
    await page.keyboard.press(`${MOD}+f`);
    await expect(page.getByTestId("search-field")).toBeFocused();
    await expect(page.getByTestId("mode-files")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("closes the viewer from its own bar", async ({ page }) => {
    await row(page, "mod.rs").click();
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await page.locator("[data-testid='viewer'] .close").click();
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
  });
});

// Off macOS the window is undecorated: the controls are the app's, at the end
// of whichever pane is rightmost, and the settings have a button in the bar.
test.describe("the window's own controls", () => {
  test("sit at the rightmost header and follow it", async ({ page }) => {
    await expect(
      page.locator(`${CHANGES} [data-testid='window-controls']`),
    ).toBeVisible();
    await page.keyboard.press(`${MOD}+\\`);
    await expect(page.locator(CHANGES)).toBeHidden();
    await expect(
      page.locator(`${AGENT} [data-testid='window-controls']`),
    ).toBeVisible();
  });

  test("drive the window through the core", async ({ page }) => {
    const controls = page.locator(`${CHANGES} [data-testid='window-controls']`);
    await controls.getByRole("button", { name: "Minimize" }).click();
    await controls.getByRole("button", { name: "Maximize" }).click();
    await controls.getByRole("button", { name: "Close" }).click();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __windowControls?: string[] })
            .__windowControls,
      ),
    ).toEqual(["minimize", "maximize", "close"]);
  });

  test("put a menu button at the leftmost header that asks the core for the native menu", async ({
    page,
  }) => {
    await page.locator(`${SESSIONS} [data-testid='app-menu']`).click();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __windowControls?: string[] })
            .__windowControls,
      ),
    ).toEqual(["menu"]);
    await page.keyboard.press(`${MOD}+b`);
    await expect(
      page.locator(`${AGENT} [data-testid='app-menu']`),
    ).toBeVisible();
  });
});
