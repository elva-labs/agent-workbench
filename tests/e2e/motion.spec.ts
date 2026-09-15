import { expect, test, type Page } from "@playwright/test";
import { installFakeCore } from "./fake";

/**
 * How the sessions pane leaves and comes back. Its column eases shut and
 * open, the pane keeps its own width against the column's right edge, and the
 * agent's terminal keeps its size until the column arrives.
 */

const SLOT = ".sessions-slot";

type Frame = {
  slotWidth: number;
  slotRight: number;
  paneWidth: number;
  agentLeft: number;
  cols: number;
  resizes: number;
};

/**
 * Every frame of one toggle of the sessions pane: recording starts before the
 * key is pressed and ends once the column has stopped moving, so no frame of
 * the slide can fall between two samples.
 */
async function slide(page: Page): Promise<Frame[]> {
  const recording = page.evaluate(
    () =>
      new Promise<Frame[]>((resolve) => {
        const frames: Frame[] = [];
        let moved = false;
        // A toggle that never moves the column still ends the recording.
        const deadline = performance.now() + 5000;
        const sample = () => {
          const slot = document.querySelector(".sessions-slot") as HTMLElement | null;
          const pane = document.querySelector("section[data-pane='sessions']");
          const agent = document.querySelector("section[data-pane='agent']")!;
          const left = document.querySelector(".shell")!.getBoundingClientRect().left;
          const w = window as unknown as {
            __WORKBENCH_TERMINALS__?: Record<string, { cols: number }>;
            __resizes?: unknown[];
          };
          frames.push({
            slotWidth: slot?.getBoundingClientRect().width ?? 0,
            slotRight: (slot?.getBoundingClientRect().right ?? left) - left,
            paneWidth: pane?.getBoundingClientRect().width ?? 0,
            agentLeft: agent.getBoundingClientRect().left - left,
            cols: w.__WORKBENCH_TERMINALS__?.["s1"]?.cols ?? 0,
            resizes: w.__resizes?.length ?? 0,
          });
          const moving = slot?.classList.contains("sliding") ?? false;
          moved ||= moving;
          if ((moved && !moving) || performance.now() > deadline) {
            // Two frames more, for the fit that follows the column arriving.
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(frames)));
          } else {
            requestAnimationFrame(sample);
          }
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
    await expect(page.locator("section[data-pane='agent']")).toBeVisible();
  });

  test("slides off as its column shuts, and the agent takes the room as it goes", async ({
    page,
  }) => {
    const frames = await slide(page);
    const first = frames[0];
    const between = frames.filter((f) => f.slotWidth > 0 && f.slotWidth < first.slotWidth);

    expect(between.length).toBeGreaterThan(0);
    for (const f of between) {
      expect(f.paneWidth).toBe(first.paneWidth);
      expect(Math.abs(f.slotRight - f.agentLeft)).toBeLessThan(1);
    }
    const lefts = between.map((f) => f.agentLeft);
    expect(lefts).toEqual([...lefts].sort((a, b) => b - a));

    await expect(page.locator(SLOT)).toHaveCount(0);
    expect(frames.at(-1)!.agentLeft).toBe(0);
  });

  test("slides back in as its column opens, and the agent gives the room back", async ({
    page,
  }) => {
    const shown = await slide(page).then((frames) => frames[0]);
    await expect(page.locator(SLOT)).toHaveCount(0);

    const frames = await slide(page);
    const between = frames.filter((f) => f.slotWidth > 0 && f.slotWidth < shown.slotWidth);
    expect(between.length).toBeGreaterThan(0);
    for (const f of between) {
      expect(f.paneWidth).toBe(shown.paneWidth);
      expect(Math.abs(f.slotRight - f.agentLeft)).toBeLessThan(1);
    }

    const last = frames.at(-1)!;
    expect(last.agentLeft).toBe(shown.agentLeft);
    expect(last.slotWidth).toBe(shown.slotWidth);
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

    const frames = await slide(page);
    const first = frames[0];
    const between = frames.filter((f) => f.slotWidth > 0 && f.slotWidth < first.slotWidth);

    expect(between.length).toBeGreaterThan(0);
    for (const f of between) {
      expect(f.cols).toBe(first.cols);
      expect(f.resizes).toBe(first.resizes);
    }
    const last = frames.at(-1)!;
    expect(last.cols).toBeGreaterThan(first.cols);
    expect(last.resizes).toBe(first.resizes + 1);
  });
});
