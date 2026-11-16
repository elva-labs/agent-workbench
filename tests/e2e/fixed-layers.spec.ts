import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * A background of the user's own is painted fixed to the window on each
 * tinted part and each see-through card, so every part shows its own piece
 * of one picture. Each such part is painted on its own and again whenever
 * anything over it moves, so they are kept few: the parts, never what is
 * listed in them.
 */

const MOD = "ControlOrMeta";

/** The elements on screen painting a background fixed to the window, and
    the area they cover, in windows. */
function fixedLayers(page: Page) {
  return page.evaluate(() => {
    let count = 0;
    let area = 0;
    for (const element of document.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      if (!style.backgroundAttachment.includes("fixed") || style.visibility === "hidden") continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      count += 1;
      area += box.width * box.height;
    }
    return { count, windows: area / (innerWidth * innerHeight) };
  });
}

for (const look of ["modern", "terminal"] as const) {
  test(`keeps the window-fixed layers to the parts, in the ${look} look`, async ({ page }) => {
    await installFakeCore(page, {
      open: [PROJECT],
      settings: {
        appearance: "dark",
        look,
        backgrounds: {
          teal: {
            dots: [
              { hue: 185, chroma: 0.85 },
              { hue: 305, chroma: 0.85 },
              { hue: 65, chroma: 0.85 },
            ],
            harmony: "triad",
            strength: 0.75,
            grain: 0.25,
          },
        },
        cards: { teal: 0.1 },
      },
    });
    await page.goto("/");
    for (let i = 1; i <= 4; i++) await page.getByTestId("new-session").click();
    await expect(page.locator("[data-testid='session-row']")).toHaveCount(4);
    await expect(page.locator("html")).toHaveAttribute("data-cards", "");

    const window = await fixedLayers(page);
    expect(window.count).toBeGreaterThan(0);
    expect(window.count).toBeLessThanOrEqual(12);
    expect(window.windows).toBeLessThanOrEqual(3);

    await page.keyboard.press(`${MOD}+,`);
    await expect(page.getByTestId("settings")).toBeVisible();
    const settings = await fixedLayers(page);
    expect(settings.count).toBeLessThanOrEqual(14);
    expect(settings.windows).toBeLessThanOrEqual(3.5);
  });
}
