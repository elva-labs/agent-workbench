import { expect, test } from "@playwright/test";
import { installFakeCore } from "./fake";

/**
 * How the sessions pane leaves and comes back. The grid never animates: the
 * pane on its way out is held at the box it had, out of the flow and above
 * the panes that take its ground, while the columns snap at once.
 */

const SLOT = ".sessions-slot";

test.describe("the sessions pane's motion", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeCore(page);
    await page.goto("/");
    await expect(page.locator("section[data-pane='agent']")).toBeVisible();
  });

  test("leaves at the box it had, above the panes that stay, while the columns snap", async ({
    page,
  }) => {
    const before = await page.evaluate(() => {
      const slot = document.querySelector(".sessions-slot")!;
      const box = slot.getBoundingClientRect();
      return { left: box.left, width: box.width, height: box.height };
    });

    await page.keyboard.press("Control+b");

    // Caught on its way out: the columns have given its width to the
    // agent, and the slot stands where it was, over what took its ground.
    const during = await page.evaluate(() => {
      const slot = document.querySelector(".sessions-slot") as HTMLElement;
      const style = getComputedStyle(slot);
      const box = slot.getBoundingClientRect();
      const shell = document.querySelector(".shell") as HTMLElement;
      const agent = document.querySelector("section[data-pane='agent']")!;
      const layers = [agent, ...agent.querySelectorAll("*")]
        .map((node) => getComputedStyle(node))
        .filter((s) => s.position !== "static" && s.zIndex !== "auto")
        .map((s) => Number(s.zIndex));
      return {
        position: style.position,
        width: box.width,
        height: box.height,
        z: Number(style.zIndex),
        highest: Math.max(0, ...layers),
        columns: getComputedStyle(shell).gridTemplateColumns.split(" ").length,
      };
    });
    expect(during.position).toBe("absolute");
    expect(during.width).toBe(before.width);
    expect(during.height).toBe(before.height);
    expect(during.z).toBeGreaterThan(during.highest);
    expect(during.columns).toBe(3);

    await expect(page.locator(SLOT)).toHaveCount(0);
  });

  test("comes back in the flow, at the width its column gives it", async ({
    page,
  }) => {
    await page.keyboard.press("Control+b");
    await expect(page.locator(SLOT)).toHaveCount(0);

    await page.keyboard.press("Control+b");
    const slot = page.locator(SLOT);
    await expect(slot).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const slot = document.querySelector(".sessions-slot") as HTMLElement;
          const style = getComputedStyle(slot);
          return [style.position, style.zIndex, slot.style.width];
        }),
      )
      .toEqual(["static", "auto", ""]);
  });
});
