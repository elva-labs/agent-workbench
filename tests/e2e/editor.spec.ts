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
