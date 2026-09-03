import { expect, test, type Page } from "@playwright/test";

const SESSIONS = "section[data-pane='sessions']";
const AGENT = "section[data-pane='agent']";
const CHANGES = "section[data-pane='changes']";

async function widthOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  return box.width;
}

/** Cmd on macOS, Ctrl elsewhere. */
const MOD = "ControlOrMeta";

/** Scoped to the changes pane: the agent placeholder prints paths too. */
function fileRow(page: Page, path: string) {
  return page.locator(CHANGES).getByText(path, { exact: true });
}

test.beforeEach(async ({ page }) => {
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
  const handle = page.getByRole("separator", { name: "Resize projects and sessions" });
  const box = (await handle.boundingBox())!;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  const after = await widthOf(page, SESSIONS);
  expect(after).toBeGreaterThan(before + 60);

  await page.reload();
  await expect(page.locator(SESSIONS)).toBeVisible();
  expect(await widthOf(page, SESSIONS)).toBeCloseTo(after, 0);
});

test("resizes a pane from the keyboard and resets it", async ({ page }) => {
  const handle = page.getByRole("separator", { name: "Resize projects and sessions" });
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
  const light = await pane.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.keyboard.press(`${MOD}+Shift+T`);
  await page.keyboard.press(`${MOD}+Shift+T`);
  const dark = await pane.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dark).not.toBe(light);
});

test("does not scroll the window: the shell is chrome, not a document", async ({ page }) => {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ x: false, y: false });
});

test.describe("responsive collapse", () => {
  test("folds the sessions pane away rather than squeezing the agent", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(page.locator(SESSIONS)).toBeHidden();
    await expect(page.locator(CHANGES)).toBeVisible();
    expect(await widthOf(page, AGENT)).toBeGreaterThanOrEqual(360);
  });

  test("folds the changes pane away too when the window is narrower still", async ({ page }) => {
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
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
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

test.describe("the file viewer", () => {
  test("opens by clicking a file, and the changes pane grows", async ({ page }) => {
    const before = await widthOf(page, CHANGES);
    await fileRow(page, "src/cache/mod.rs").click();

    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.getByTestId("viewer")).toBeVisible();
    expect(await widthOf(page, CHANGES)).toBeGreaterThan(before);
  });

  // The move that makes this not a modal: the room comes from the sessions
  // pane, and the agent stays exactly where it was.
  test("takes the room from the sessions pane, not the agent", async ({ page }) => {
    const agentBefore = await widthOf(page, AGENT);
    await fileRow(page, "src/cache/mod.rs").click();

    await expect(page.locator(SESSIONS)).toBeHidden();
    await expect(page.locator(AGENT)).toBeVisible();
    expect(await widthOf(page, AGENT)).toBeCloseTo(agentBefore, 0);
  });

  test("shows the diff first", async ({ page }) => {
    await fileRow(page, "src/cache/mod.rs").click();
    const viewer = page.getByTestId("viewer");
    await expect(viewer).toHaveAttribute("data-view", "diff");
    await expect(viewer.getByText("@@ -1,9 +1,12 @@")).toBeVisible();
  });

  test("switches to the whole file and back", async ({ page }) => {
    await fileRow(page, "src/cache/mod.rs").click();
    const viewer = page.getByTestId("viewer");

    await page.getByRole("button", { name: "Content" }).click();
    await expect(viewer).toHaveAttribute("data-view", "content");
    await expect(viewer.getByText("@@ -1,9 +1,12 @@")).toHaveCount(0);

    await page.getByRole("button", { name: "Diff" }).click();
    await expect(viewer).toHaveAttribute("data-view", "diff");
  });

  test("switches view from the keyboard", async ({ page }) => {
    await fileRow(page, "src/cache/mod.rs").click();
    await page.keyboard.press(`${MOD}+e`);
    await expect(page.getByTestId("viewer")).toHaveAttribute("data-view", "content");
  });

  test("keeps every file one click away in the strip", async ({ page }) => {
    await fileRow(page, "src/cache/mod.rs").click();
    await page.getByRole("tab", { name: /lib\.rs/ }).click();

    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.getByTestId("viewer").getByText("mod cache;")).toBeVisible();
  });

  test("does not move the layout when switching files", async ({ page }) => {
    await fileRow(page, "src/cache/mod.rs").click();
    const agentWidth = await widthOf(page, AGENT);

    await page.getByRole("tab", { name: /lib\.rs/ }).click();
    await page.getByRole("tab", { name: /token_cache\.rs/ }).click();

    expect(await widthOf(page, AGENT)).toBeCloseTo(agentWidth, 0);
  });

  test("widens the scope and falls back to content for an unchanged file", async ({ page }) => {
    await page.getByRole("button", { name: "All files" }).click();
    await fileRow(page, "Cargo.toml").click();

    await expect(page.getByTestId("viewer")).toHaveAttribute("data-view", "content");
    await expect(page.getByRole("button", { name: "Diff" })).toBeDisabled();
  });

  test("closes on Escape and restores the sessions pane", async ({ page }) => {
    await fileRow(page, "src/cache/mod.rs").click();
    await expect(page.locator(SESSIONS)).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await expect(page.locator(SESSIONS)).toBeVisible();
  });

  test("opens and closes on the keyboard too", async ({ page }) => {
    await page.keyboard.press(`${MOD}+d`);
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await page.keyboard.press(`${MOD}+d`);
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
  });

  test("hides the agent rather than squeezing it in a narrow window", async ({ page }) => {
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

  test("remembers the working and reviewing widths separately", async ({ page }) => {
    const working = await widthOf(page, CHANGES);
    await fileRow(page, "src/cache/mod.rs").click();
    const reviewing = await widthOf(page, CHANGES);
    expect(reviewing).toBeGreaterThan(working);

    await page.keyboard.press("Escape");
    expect(await widthOf(page, CHANGES)).toBeCloseTo(working, 0);

    await page.keyboard.press(`${MOD}+d`);
    expect(await widthOf(page, CHANGES)).toBeCloseTo(reviewing, 0);
  });
});
