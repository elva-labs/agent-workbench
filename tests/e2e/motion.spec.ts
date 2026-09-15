import { expect, test, type Page } from "@playwright/test";
import { installFakeCore } from "./fake";

/**
 * How the sessions pane folds and opens. Its column eases between its folded
 * width and its open one, what the pane holds keeps its place while the
 * column cuts it off, and the agent's terminal keeps its size until the
 * column arrives.
 */

const SLOT = ".sessions-slot";
const SESSIONS = "section[data-pane='sessions']";
const AGENT = "section[data-pane='agent']";
const FOLDED = 50;

type Frame = {
  slotWidth: number;
  slotRight: number;
  agentLeft: number;
  /** Where the first project's name stands, which folding must not move. */
  nameLeft: number;
  nameTop: number;
  cols: number;
  resizes: number;
};

/**
 * Every frame of one toggle of the sessions pane: recording starts before the
 * key is pressed and ends once the column has held still for a few frames
 * after moving, so no frame of the motion can fall between two samples.
 */
async function toggle(page: Page): Promise<Frame[]> {
  const recording = page.evaluate(
    () =>
      new Promise<Frame[]>((resolve) => {
        const frames: Frame[] = [];
        // A toggle that never moves the column still ends the recording.
        const deadline = performance.now() + 5000;
        const sample = () => {
          const slot = document.querySelector(".sessions-slot")!.getBoundingClientRect();
          const agent = document.querySelector("section[data-pane='agent']")!;
          const name = document.querySelector("section[data-pane='sessions'] .project-row .name")!;
          const left = document.querySelector(".shell")!.getBoundingClientRect().left;
          const w = window as unknown as {
            __WORKBENCH_TERMINALS__?: Record<string, { cols: number }>;
            __resizes?: unknown[];
          };
          frames.push({
            slotWidth: slot.width,
            slotRight: slot.right - left,
            agentLeft: agent.getBoundingClientRect().left - left,
            nameLeft: name.getBoundingClientRect().left,
            nameTop: name.getBoundingClientRect().top,
            cols: w.__WORKBENCH_TERMINALS__?.["s1"]?.cols ?? 0,
            resizes: w.__resizes?.length ?? 0,
          });
          const widths = frames.map((f) => f.slotWidth);
          const moved = widths.some((width) => width !== widths[0]);
          const still = widths.length > 3 && widths.slice(-4).every((width) => width === widths.at(-1));
          if ((moved && still) || performance.now() > deadline) resolve(frames);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  await page.keyboard.press("ControlOrMeta+b");
  return recording;
}

test.describe("the sessions pane's motion", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeCore(page);
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
  });

  test("folds as its column narrows, and the agent takes the room as it goes", async ({
    page,
  }) => {
    const frames = await toggle(page);
    const first = frames[0];
    const between = frames.filter((f) => f.slotWidth < first.slotWidth && f.slotWidth > FOLDED + 10);

    expect(between.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(Math.abs(f.slotRight - f.agentLeft)).toBeLessThan(1);
      expect(f.nameLeft).toBe(first.nameLeft);
      expect(f.nameTop).toBe(first.nameTop);
    }
    const lefts = between.map((f) => f.agentLeft);
    expect(lefts).toEqual([...lefts].sort((a, b) => b - a));

    const last = frames.at(-1)!;
    expect(last.slotWidth).toBeGreaterThanOrEqual(FOLDED);
    expect(last.slotWidth).toBeLessThan(FOLDED + 10);
  });

  test("opens as its column widens, and the agent gives the room back", async ({ page }) => {
    const open = await toggle(page).then((frames) => frames[0]);

    const frames = await toggle(page);
    const between = frames.filter((f) => f.slotWidth > FOLDED + 10 && f.slotWidth < open.slotWidth);
    expect(between.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(Math.abs(f.slotRight - f.agentLeft)).toBeLessThan(1);
      expect(f.nameTop).toBe(open.nameTop);
    }

    const last = frames.at(-1)!;
    expect(last.agentLeft).toBe(open.agentLeft);
    expect(last.slotWidth).toBe(open.slotWidth);
  });

  test("the agent's pty hears one size, once the column has arrived", async ({ page }) => {
    await page.getByTestId("start-agent").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __WORKBENCH_TERMINALS__?: Record<string, { cols: number }> })
              .__WORKBENCH_TERMINALS__?.["s1"]?.cols ?? 0,
        ),
      )
      .toBeGreaterThan(0);

    const frames = await toggle(page);
    const first = frames[0];
    const between = frames.filter((f) => f.slotWidth < first.slotWidth && f.slotWidth > FOLDED + 10);

    expect(between.length).toBeGreaterThan(0);
    for (const f of between) {
      expect(f.cols).toBe(first.cols);
      expect(f.resizes).toBe(first.resizes);
    }
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __resizes?: unknown[] }).__resizes?.length ?? 0),
      )
      .toBe(first.resizes + 1);
  });

  // The header row stays one row: the agent's title stands where it does
  // with the pane open out of the way, under no line from the column.
  test("keeps the header row whole while folded", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+b");
    await expect.poll(() => page.locator(SLOT).boundingBox().then((b) => b!.width)).toBeLessThan(FOLDED + 10);

    const head = await page.locator(`${SESSIONS} > header`).boundingBox();
    const beside = await page.locator(`${AGENT} > header`).boundingBox();
    expect(head!.height).toBeCloseTo(beside!.height, 0);
    await expect(page.locator(`${SESSIONS} > header .title`)).toBeHidden();
  });

  test("opens when the folded column is clicked, and takes the keyboard", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+b");
    const unfold = page.getByTestId("unfold-sessions");
    await expect(unfold).toBeVisible();

    const column = (await page.locator(SLOT).boundingBox())!;
    await page.mouse.click(column.x + column.width / 2, column.y + column.height / 2);
    await expect(unfold).toHaveCount(0);
    await expect.poll(() => page.locator(SESSIONS).boundingBox().then((b) => b!.width)).toBeGreaterThan(150);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
  });

  test("opens when the pane is focused by key", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByTestId("unfold-sessions")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+1");
    await expect(page.getByTestId("unfold-sessions")).toHaveCount(0);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
  });

  // Reviewing is what folds it there, so opening it closes the viewer.
  test("closes the viewer when it is opened from its fold while reviewing", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+d");
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.getByTestId("unfold-sessions")).toBeVisible();

    await page.getByTestId("unfold-sessions").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await expect(page.getByTestId("unfold-sessions")).toHaveCount(0);
  });
});
