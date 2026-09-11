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

/** A section as a plugin sends one, for the project the fixture opens. */
async function pushSection(
  page: Page,
  sent: { rows: unknown[]; actions?: unknown[] },
) {
  await page.evaluate(
    ({ project, sent }) =>
      (
        window as unknown as { __pluginSection: (event: unknown) => void }
      ).__pluginSection({
        source: "src-1",
        plugin: "github",
        section: "Pull request",
        title: "Pull request",
        project,
        rows: sent.rows,
        actions: sent.actions ?? [],
      }),
    { project: PROJECT, sent },
  );
}

/** Every action the fake core was asked for, as action and row. */
function actionsTaken(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __pluginActions?: { action: string; row: string | null }[];
        }
      ).__pluginActions?.map((call) => [call.action, call.row]) ?? [],
  );
}

const CHECKS = [
  {
    id: "lint",
    label: "lint",
    detail: "passed in 42s",
    state: "ok",
    actions: [{ id: "open", label: "Open", input: null }],
    default: "open",
  },
  {
    id: "test",
    label: "test",
    detail: "running on ubuntu",
    state: "busy",
    actions: [{ id: "rerun", label: "Rerun", input: null }],
    default: null,
  },
];

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

  // The agent's terminal tool: a shell opens with the command at the prompt,
  // typed and not run.
  test("opens a terminal with the agent's command typed, not run", async ({
    page,
  }) => {
    await page.evaluate(() =>
      (
        window as unknown as { __terminalRequest: (request: unknown) => void }
      ).__terminalRequest({
        command: "npm run dev",
        cwd: "/home/ada/dev/demo/packages/web",
      }),
    );
    await expect(page.locator("section[data-pane='terminal']")).toBeVisible();
    await expect(page.locator("[data-testid='terminal-slot'].on")).toHaveCount(
      1,
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __written?: [string, string][] })
              .__written ?? [],
        ),
      )
      .toContainEqual([
        expect.stringMatching(/^pty-/),
        "cd 'packages/web' && npm run dev",
      ]);
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
  });

  // The agent's notify tool: its line sits under the session's name, and
  // the row wants attention, until the session is looked at.
  test("leaves the agent's line on its session's row until it is looked at", async ({
    page,
  }) => {
    await page.getByTestId("new-session").click();
    await expect(page.locator(AGENT)).toContainText("running");
    await page.getByTestId("new-session").click();
    await expect(page.locator("[data-testid='session-row']")).toHaveCount(2);
    // The first session, by its id, while the second is on screen.
    await page.evaluate(() =>
      (
        window as unknown as { __notifyRequest: (request: unknown) => void }
      ).__notifyRequest({
        text: "Tests green, ready to merge.",
        cwd: "/home/ada/dev/demo",
        session: "session-1",
      }),
    );
    const note = page.getByTestId("session-note");
    await expect(note).toHaveText("Tests green, ready to merge.");
    const first = page.locator("[data-testid='session-row']").first();
    await expect(first.locator(".dot")).toHaveClass(/unread/);
    await first.click();
    await expect(note).toHaveCount(0);
    await expect(first.locator(".dot")).not.toHaveClass(/unread/);
  });

  // A page runs in a frame with no origin; a diagram is drawn in the window.
  test("presents an HTML page in a frame of its own and a Mermaid diagram drawn", async ({
    page,
  }) => {
    await page.evaluate(
      (project) =>
        (
          window as unknown as { __presentRequest: (request: unknown) => void }
        ).__presentRequest({
          files: [`${project}/out/report.html`, `${project}/out/flow.mmd`],
          caption: "The report and the flow.",
          cwd: project,
        }),
      PROJECT,
    );
    const frame = page.getByTestId("media-page");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const inner = page.frameLocator("[data-testid='media-page']");
    await expect(inner.locator("#page")).toHaveText("A page");
    await expect(inner.locator("#ran")).toHaveText("ran");
    // The frame grew to the page's height, from what the page reported.
    await expect
      .poll(async () => (await frame.boundingBox())!.height)
      .toBeLessThan(300);
    await expect(
      page.getByTestId("media-diagram").locator("svg"),
    ).toBeVisible();
    await expect(page.getByTestId("media-diagram")).toContainText("Start");
  });

  // Lines selected with the mouse stay marked once the keyboard has gone to
  // the agent, and are what the selection tool is told; a click in the
  // viewer lets them go.
  test("keeps the lines selected in the viewer marked, and on record, after focus leaves", async ({
    page,
  }) => {
    await page.getByTestId("file-tree").getByText("mod.rs").click();
    const row = (line: number) =>
      page.locator(`[data-testid='viewer'] tr[data-line='${line}'] td.text`);
    await expect(row(6)).toBeVisible();
    const start = (await row(1).boundingBox())!;
    const end = (await row(6).boundingBox())!;
    await page.mouse.move(start.x + 4, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width - 4, end.y + end.height / 2, {
      steps: 6,
    });
    await page.mouse.up();
    // The numbers are not part of what was selected.
    expect(
      await page.evaluate(() => document.getSelection()?.toString() ?? ""),
    ).not.toMatch(/^\s*1\b/);
    await expect(page.locator("[data-testid='viewer'] tr.picked")).toHaveCount(
      3,
    );
    const record = () =>
      page.evaluate(
        () => (window as unknown as { __selection: unknown }).__selection,
      );
    await expect.poll(record).toMatchObject({ selection: { from: 1, to: 6 } });

    // To the agent, and the marks and the record stay.
    await page.locator(AGENT).click();
    await expect(page.locator("[data-testid='viewer'] tr.picked")).toHaveCount(
      3,
    );
    await expect.poll(record).toMatchObject({ selection: { from: 1, to: 6 } });

    // A click in the viewer lets the selection go.
    await row(5).click();
    await expect(page.locator("[data-testid='viewer'] tr.picked")).toHaveCount(
      0,
    );
    await expect
      .poll(record)
      .toMatchObject({ selection: { from: null, to: null } });
  });

  // The agent's diff tool: the file's diff opens with the note above it.
  test("opens a file's diff where the agent asked, with the note", async ({
    page,
  }) => {
    await page.evaluate(() =>
      (
        window as unknown as { __diffRequest: (request: unknown) => void }
      ).__diffRequest({
        path: "/home/ada/dev/demo/src/cache/mod.rs",
        note: "The cache keeps its keys now.",
        cwd: "/home/ada/dev/demo",
      }),
    );
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.getByTestId("viewer")).toHaveAttribute(
      "data-view",
      "diff",
    );
    await expect(page.getByTestId("viewer-note")).toHaveText(
      "The cache keeps its keys now.",
    );
    await expect(page.getByTestId("viewer").locator("tr.target")).toHaveCount(
      0,
    );
  });

  // What the agent's selection tool reads: the record follows the viewer.
  test("keeps what is on screen on record for the agent", async ({ page }) => {
    const record = () =>
      page.evaluate(
        () => (window as unknown as { __selection: unknown }).__selection,
      );
    await expect
      .poll(record)
      .toEqual({ project: "/home/ada/dev/demo", selection: null });

    await page.getByTestId("file-tree").getByText("mod.rs").click();
    await expect.poll(record).toEqual({
      project: "/home/ada/dev/demo",
      selection: {
        project: "/home/ada/dev/demo",
        file: "/home/ada/dev/demo/src/cache/mod.rs",
        view: "diff",
        from: null,
        to: null,
        media: null,
      },
    });

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
    await expect.poll(record).toMatchObject({
      selection: {
        file: "/home/ada/dev/demo/src/main.rs",
        view: "file",
        from: 2,
        to: 3,
      },
    });

    await page.evaluate(
      (project) =>
        (
          window as unknown as { __presentRequest: (request: unknown) => void }
        ).__presentRequest({
          files: [`${project}/shots/one.png`],
          caption: "One.",
          cwd: project,
        }),
      PROJECT,
    );
    await expect.poll(record).toMatchObject({
      selection: {
        file: null,
        media: { files: [`${PROJECT}/shots/one.png`], caption: "One." },
      },
    });

    await page.keyboard.press("Escape");
    await expect
      .poll(record)
      .toEqual({ project: "/home/ada/dev/demo", selection: null });
  });

  // The agent's present tool: one row per call under the tree, with the
  // caption; opening it shows every file of the call down the viewer.
  test("presents the agent's files in the viewer, from a section under the tree", async ({
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
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.getByTestId("viewer")).toHaveAttribute(
      "data-view",
      "media",
    );
    await expect(page.getByTestId("media-caption")).toHaveText(
      "Before, after, and the plan.",
    );
    const files = page.getByTestId("media-file");
    await expect(files).toHaveCount(3);
    await expect(files.nth(0).locator("img")).toBeVisible();
    await expect(files.nth(2).locator("embed")).toHaveAttribute(
      "type",
      "application/pdf",
    );

    // The section under the tree counts the call in its header, folded
    // until asked, and lists it when opened.
    const section = page.getByTestId("media-section");
    await expect(page.getByTestId("media-fold")).toContainText("Media (1)");
    await expect(page.getByTestId("media-item")).toHaveCount(0);
    await page.getByTestId("media-fold").click();
    await expect(page.getByTestId("media-item")).toContainText(
      "Before, after, and the plan.",
    );
    await expect(page.getByTestId("media-item")).toContainText("3 files");
    await page.getByTestId("media-fold").click();
    await expect(page.getByTestId("media-item")).toHaveCount(0);
    await page.getByTestId("media-fold").click();
    await expect(page.getByTestId("media-item")).toHaveCount(1);

    // Escape closes the viewer as it closes a file; the row opens it again.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await page.getByTestId("media-item").click();
    await expect(page.getByTestId("media-file")).toHaveCount(3);
    await expect(section).toBeVisible();
  });

  // One cursor for the column: the arrows walk off the end of the tree
  // onto the media rows, and the keys there are the folder's.
  test("walks the tree's cursor into the media rows and drives them by key", async ({
    page,
  }) => {
    await page.evaluate(
      (project) =>
        (
          window as unknown as {
            __presentRequest: (request: unknown) => void;
          }
        ).__presentRequest({
          files: [`${project}/shots/one.png`, `${project}/shots/two.png`],
          caption: "Two shots.",
          cwd: project,
        }),
      PROJECT,
    );
    await expect(page.getByTestId("media-file")).toHaveCount(2);
    // The section is folded until asked: open it, then a call that opens
    // puts the cursor on its row, and Escape leaves the keyboard on the
    // tree with the cursor still there.
    await page.getByTestId("media-fold").click();
    await page.getByTestId("media-item").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await expect(page.getByTestId("file-tree")).toBeFocused();
    await expect(page.getByTestId("media-item")).toHaveClass(/cursor/);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("media-file")).toHaveCount(2);
    await page.keyboard.press("Escape");

    // Left folds the section and lands on its header; Right opens it again.
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("media-item")).toHaveCount(0);
    await expect(page.getByTestId("media-fold")).toHaveClass(/cursor/);
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("media-item")).toHaveCount(1);

    // Home is the top of the tree; End is the processes header, the last
    // row of the column, with the media row just above it.
    await page.keyboard.press("Home");
    await expect(page.getByTestId("media-fold")).not.toHaveClass(/cursor/);
    await expect(page.getByTestId("file-tree")).toHaveAttribute(
      "aria-activedescendant",
      /^tree-/,
    );
    await page.keyboard.press("End");
    await expect(page.getByTestId("processes-fold")).toHaveClass(/cursor/);
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("media-item")).toHaveClass(/cursor/);
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("media-fold")).toHaveClass(/cursor/);
  });

  // What runs under the sessions: counted in the header while folded,
  // listed when opened, and stopped from the row.
  test("lists what runs under the sessions, folded to a count until opened", async ({
    page,
  }) => {
    await expect(page.getByTestId("processes-fold")).toHaveText(
      /^\s*▸\s*Processes\s*$/,
    );
    await page.getByTestId("new-session").click();
    await expect(page.locator(AGENT)).toContainText("running");
    await page.evaluate(() => {
      const now = Math.floor(Date.now() / 1000);
      (window as unknown as { __processes: unknown }).__processes = {
        "pty-1": [
          {
            pid: 4242,
            parent: 4000,
            name: "node",
            command: "node server.js",
            cpu: 3.5,
            memory: 52428800,
            started: now - 125,
          },
          {
            pid: 4243,
            parent: 4242,
            name: "esbuild",
            command: "esbuild --watch",
            cpu: 0.2,
            memory: 10485760,
            started: now - 120,
          },
        ],
      };
    });
    // Counted at the next reading, which comes slower while folded.
    await expect(page.getByTestId("processes-fold")).toContainText(
      "Processes (2)",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("process-row")).toHaveCount(0);
    await page.getByTestId("processes-fold").click();
    const rows = page.getByTestId("process-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("node server.js");
    await expect(rows.first()).toContainText("session 1");
    await expect(rows.first()).toContainText("2m");
    await expect(rows.first()).toContainText("50 MB");
    // The keyboard reaches the rows from the tree; End is the last one.
    await page.getByTestId("file-tree").focus();
    await page.keyboard.press("End");
    await expect(rows.last()).toHaveClass(/cursor/);
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("process-row")).toHaveCount(0);
    await expect(page.getByTestId("processes-fold")).toHaveClass(/cursor/);
    await page.keyboard.press("ArrowRight");
    await expect(rows).toHaveCount(2);
    // Stopping one asks the core for that pid under that pty.
    await rows.first().hover();
    await rows.first().getByTestId("process-stop").click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __stopped?: unknown }).__stopped,
        ),
      )
      .toEqual([["pty-1", 4242]]);
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId("processes-fold")).toContainText(
      "Processes (1)",
    );
  });

  // A plugin's section: counted in its header while folded, its rows with
  // their states and details when opened, and its actions taken from the
  // header, from a row, and by opening the row itself.
  test("lists a plugin's section under the tree and takes its actions", async ({
    page,
  }) => {
    await pushSection(page, {
      rows: CHECKS,
      actions: [
        { id: "refresh", label: "Refresh", input: null },
        {
          id: "comment",
          label: "Comment",
          input: [
            {
              id: "body",
              label: "Body",
              kind: "text",
              options: null,
              placeholder: "a line",
            },
            {
              id: "as",
              label: "As",
              kind: "choice",
              options: [
                { id: "me", label: "Me" },
                { id: "bot", label: "The bot" },
              ],
              placeholder: null,
            },
          ],
        },
      ],
    });

    const fold = page.getByTestId("plugin-fold");
    await expect(fold).toContainText("Pull request (2)");
    await expect(page.getByTestId("plugin-row")).toHaveCount(0);
    await fold.click();
    const rows = page.getByTestId("plugin-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("lint");
    await expect(rows.first()).toContainText("passed in 42s");
    await expect(rows.first().locator(".dot")).toHaveAttribute(
      "data-state",
      "ok",
    );
    await expect(rows.nth(1).locator(".dot")).toHaveAttribute(
      "data-state",
      "busy",
    );

    // A row's own action, the header's, and the row itself, which runs the
    // action the plugin made its default.
    await rows.nth(1).hover();
    await rows.nth(1).getByTestId("plugin-row-action").click();
    await page.getByTestId("plugin-section-action").first().click();
    await rows.first().click();
    await expect
      .poll(() => actionsTaken(page))
      .toEqual([
        ["rerun", "test"],
        ["refresh", null],
        ["open", "lint"],
      ]);

    // An action with fields asks in a dialog of its own first.
    await page.getByTestId("plugin-section-action").nth(1).click();
    const dialog = page.getByTestId("action-input");
    await expect(dialog).toContainText("Comment");
    await expect(page.getByTestId("action-text")).toBeFocused();
    await expect(page.getByTestId("action-text")).toHaveAttribute(
      "placeholder",
      "a line",
    );
    await page.getByTestId("action-text").fill("looks good to me");
    await page.getByTestId("action-choice").selectOption("bot");
    await page.getByTestId("action-run").click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const calls = (
            window as unknown as { __pluginActions: Record<string, unknown>[] }
          ).__pluginActions;
          return calls[calls.length - 1];
        }),
      )
      .toMatchObject({
        action: "comment",
        row: null,
        input: { body: "looks good to me", as: "bot" },
        project: PROJECT,
      });

    // The plugin stopped: no rows left, and the section goes with them.
    await pushSection(page, { rows: [] });
    await expect(page.getByTestId("plugin-section")).toHaveCount(0);
  });

  test("walks the tree's cursor onto a plugin's rows and folds them", async ({
    page,
  }) => {
    await pushSection(page, { rows: CHECKS });
    await page.getByTestId("plugin-fold").click();
    const rows = page.getByTestId("plugin-row");
    await expect(rows).toHaveCount(2);

    // The column ends on the last of the plugin's rows; Left folds the
    // section and leaves the cursor on its header.
    await page.getByTestId("file-tree").focus();
    await page.keyboard.press("End");
    await expect(rows.last()).toHaveClass(/cursor/);
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("plugin-row")).toHaveCount(0);
    await expect(page.getByTestId("plugin-fold")).toHaveClass(/cursor/);
    await page.keyboard.press("ArrowRight");
    await expect(rows).toHaveCount(2);

    // Enter on the header folds it too; on a row it runs the row's default.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("plugin-row")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(2);
    await page.keyboard.press("ArrowDown");
    await expect(rows.first()).toHaveClass(/cursor/);
    await page.keyboard.press("Enter");
    await expect.poll(() => actionsTaken(page)).toEqual([["open", "lint"]]);
  });

  test("says what a plugin refused, under its section's header", async ({
    page,
  }) => {
    await pushSection(page, {
      rows: CHECKS,
      actions: [{ id: "explode", label: "Boom", input: null }],
    });
    await page.getByTestId("plugin-section-action").click();
    await expect(page.getByTestId("plugin-notice")).toContainText(
      "the plugin is not running",
    );
  });

  test("resizes the media section by its divider and keeps the size", async ({
    page,
  }) => {
    await page.evaluate(
      (project) =>
        (
          window as unknown as {
            __presentRequest: (request: unknown) => void;
          }
        ).__presentRequest({
          files: [`${project}/shots/one.png`],
          caption: null,
          cwd: project,
        }),
      PROJECT,
    );
    await page.getByTestId("media-fold").click();
    const section = page.getByTestId("media-section");
    const before = (await section.boundingBox())!.height;
    const handle = page.getByRole("separator", {
      name: "Resize the sections under the tree",
    });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 80, {
      steps: 8,
    });
    await page.mouse.up();
    const after = (await section.boundingBox())!.height;
    expect(after).toBeGreaterThan(before + 40);
    const stored = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("workbench.layout") ?? "{}").mediaShare,
    );
    expect(stored).toBeGreaterThan(0.3);
  });

  // A document the agent drafted, rendered, with its own HTML shown as text.
  test("presents a Markdown document rendered", async ({ page }) => {
    await page.evaluate(
      (project) =>
        (
          window as unknown as {
            __presentRequest: (request: unknown) => void;
          }
        ).__presentRequest({
          files: [`${project}/docs/draft.md`],
          caption: "The draft.",
          cwd: project,
        }),
      PROJECT,
    );
    const document = page.getByTestId("media-document");
    await expect(page.getByTestId("viewer")).toHaveAttribute(
      "data-view",
      "media",
    );
    await expect(document.locator("h1")).toHaveText("Draft");
    await expect(document.locator("em")).toHaveText("there");
    await expect(document).toContainText("<b>plain</b>");
    await expect(document.locator("b")).toHaveCount(0);
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
