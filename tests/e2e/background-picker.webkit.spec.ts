import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

// The background picker by keyboard alone, in WebKit as well as Chromium:
// WebKit, the app's webview on macOS, passes over a control on Tab unless
// it is made a stop. The pad, each dot, the add and remove buttons and the
// sliders are stops; the harmonies and the ready-made row are one stop
// each, walked with the arrows.

const MOD = "ControlOrMeta";

const kept = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null")?.backgrounds?.teal ?? null, SETTINGS_FILE);

const focused = (page: Page) =>
  page.evaluate(() => {
    const owner = document.activeElement as HTMLElement | null;
    return owner?.getAttribute("data-testid") ?? owner?.tagName.toLowerCase() ?? null;
  });

async function open(page: Page, settings: Record<string, unknown> = {}) {
  await installFakeCore(page, { open: [PROJECT], settings: { appearance: "light", ...settings } });
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("background-picker")).toBeVisible();
}

test("places a colour from the pad and moves it with the arrows", async ({ page }) => {
  await open(page);
  // The tab before the pad: the pad is the next stop.
  await page.getByTestId("palette-mono").focus();
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("background-pad");
  await page.keyboard.press("Enter");
  const dot = page.getByTestId("background-dot");
  await expect(dot).toHaveCount(1);
  await expect(dot).toBeFocused();
  const before = await dot.getAttribute("aria-valuetext");
  const box = (await dot.boundingBox())!;

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(dot).not.toHaveAttribute("aria-valuetext", before ?? "");
  await expect(dot).toHaveAttribute("aria-valuetext", /, 75% colour$/);
  const moved = (await dot.boundingBox())!;
  expect(Math.hypot(moved.x - box.x, moved.y - box.y)).toBeGreaterThan(10);
  // Kept once the keys rest.
  await expect.poll(() => kept(page)).toMatchObject({ dots: [{ chroma: 0.75 }] });
});

test("adds a colour with plus and takes the focused one away with Delete", async ({ page }) => {
  await open(page, { backgrounds: { teal: { dots: [{ hue: 40, chroma: 0.6 }], harmony: "single" } } });
  await page.getByTestId("background-dot").focus();
  await page.keyboard.press("+");
  await expect(page.getByTestId("background-dot")).toHaveCount(2);
  await expect(page.getByTestId("background-dot").nth(1)).toBeFocused();
  await expect.poll(() => kept(page)).toMatchObject({ harmony: "complementary" });
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("background-dot")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("background-dot")).toHaveCount(0);
  await expect(page.getByTestId("background-pad")).toBeFocused();
  await expect.poll(() => kept(page)).toBeNull();
});

test("reaches every control in order and walks the rows with the arrows", async ({ page }) => {
  await open(page, { backgrounds: { teal: { dots: [{ hue: 40, chroma: 0.6 }], harmony: "single" } } });
  await page.getByTestId("background-dot").focus();
  const order: (string | null)[] = [];
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press("Tab");
    order.push(await focused(page));
  }
  expect(order).toEqual([
    "background-add",
    "background-remove",
    "harmony-single",
    "ready-none",
    "background-strength",
    "background-grain",
  ]);
  await page.getByTestId("harmony-single").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("harmony-complementary")).toBeFocused();
  await expect(page.getByTestId("harmony-complementary")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("background-dot")).toHaveCount(2);

  await page.getByTestId("ready-none").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("ready-lagoon")).toBeFocused();
  await expect(page.getByTestId("ready-lagoon")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("End");
  await expect(page.getByTestId("ready-fog")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => kept(page)).toMatchObject({ dots: [{ hue: 250, chroma: 0.3 }] });

  await page.getByTestId("background-strength").focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => kept(page)).toMatchObject({ strength: 0.55 });
});
