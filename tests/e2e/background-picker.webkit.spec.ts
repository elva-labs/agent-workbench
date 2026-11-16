import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, backgroundAtRest, installFakeCore } from "./fake";

// The background picker by keyboard alone, in WebKit, the app's webview on
// macOS, as well as Chromium. The pad, each dot, the add and remove buttons
// and the sliders are stops; the harmonies and the ready-made row are one
// stop each, walked with the arrows.

const MOD = "ControlOrMeta";

const kept = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null")?.backgrounds?.teal ?? null, SETTINGS_FILE);

const focused = (page: Page) =>
  page.evaluate(() => {
    const owner = document.activeElement as HTMLElement | null;
    return owner?.getAttribute("data-testid") ?? owner?.tagName.toLowerCase() ?? null;
  });

/** How many pixels differ between two screenshots of the same size. */
const differing = (page: Page, a: Buffer, b: Buffer) =>
  page.evaluate(
    async ([first, second]) => {
      const read = async (data: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [x, y] = [await read(first), await read(second)];
      let count = 0;
      for (let at = 0; at < x.length; at += 4) {
        if (Math.abs(x[at] - y[at]) + Math.abs(x[at + 1] - y[at + 1]) + Math.abs(x[at + 2] - y[at + 2]) > 60) count++;
      }
      return count;
    },
    [a.toString("base64"), b.toString("base64")],
  );

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

for (const look of ["terminal", "modern"]) {
  test(`marks a slider focused from the keyboard, in the ${look} look`, async ({ page }) => {
    await open(page, {
      look,
      backgrounds: { teal: { dots: [{ hue: 40, chroma: 0.6 }], harmony: "single", strength: 0.6 } },
    });
    const slider = page.getByTestId("background-strength");
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    const clip = { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 };
    await backgroundAtRest(page);
    // From the ready-made row the next stop is the slider; back again
    // leaves it at rest.
    await page.getByTestId("ready-none").focus();
    await page.keyboard.press("Tab");
    await expect(slider).toBeFocused();
    const focusedShot = await page.screenshot({ clip });
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("ready-none")).toBeFocused();
    const restShot = await page.screenshot({ clip });
    expect(await differing(page, focusedShot, restShot)).toBeGreaterThan(20);
  });
}
