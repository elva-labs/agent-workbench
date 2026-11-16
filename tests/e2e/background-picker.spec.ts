import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

/**
 * The background picker by pointer: placing a colour on the pad and
 * dragging it, with the window following as it moves and the choice kept
 * when it is let go; the harmonies, the ready-made row, adding and removing
 * a colour, strength and grain, and the way back to none.
 */

const MOD = "ControlOrMeta";
const SESSIONS = "section[data-pane='sessions']";

const file = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), SETTINGS_FILE);

const kept = async (page: Page) => (await file(page))?.backgrounds?.teal ?? null;

async function open(page: Page, settings: Record<string, unknown> = {}) {
  await installFakeCore(page, { open: [PROJECT], settings: { appearance: "light", ...settings } });
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("background-picker")).toBeVisible();
  await page.getByTestId("background-pad").scrollIntoViewIfNeeded();
}

/** The pad's centre and radius on screen. */
async function pad(page: Page) {
  const box = (await page.getByTestId("background-pad").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, r: box.width / 2 };
}

/** Where a dot's centre is, relative to the pad's centre, in radii. */
async function dotAt(page: Page, index: number) {
  const centre = await pad(page);
  const box = (await page.getByTestId("background-dot").nth(index).boundingBox())!;
  return { x: (box.x + box.width / 2 - centre.x) / centre.r, y: (box.y + box.height / 2 - centre.y) / centre.r };
}

/** The sessions pane's ground in the window behind the settings. */
const tinted = (page: Page) =>
  page.evaluate(
    (selector) => getComputedStyle(document.querySelector(selector)!).backgroundImage !== "none",
    SESSIONS,
  );

test("places a colour where the pad is clicked, and keeps it", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("background-dot")).toHaveCount(0);
  expect(await tinted(page)).toBe(false);
  const centre = await pad(page);
  await page.mouse.click(centre.x + centre.r * 0.5, centre.y);
  await expect(page.getByTestId("background-dot")).toHaveCount(1);
  const at = await dotAt(page, 0);
  expect(at.x).toBeCloseTo(0.5, 1);
  expect(at.y).toBeCloseTo(0, 1);
  expect(await tinted(page)).toBe(true);
  await expect.poll(() => kept(page)).toMatchObject({ dots: [{ hue: 0, chroma: 0.5 }], harmony: "single" });
});

test("repaints the window as a dot is dragged, and keeps it when let go", async ({ page }) => {
  await open(page, { backgrounds: { teal: { dots: [{ hue: 0, chroma: 0.5 }], harmony: "single" } } });
  const centre = await pad(page);
  const start = await dotAt(page, 0);
  await page.mouse.move(centre.x + start.x * centre.r, centre.y + start.y * centre.r);
  await page.mouse.down();
  // Straight down from the centre is a quarter turn of hue.
  await page.mouse.move(centre.x, centre.y + centre.r * 0.8, { steps: 6 });
  const painting = await page.evaluate(() => document.getElementById("workbench-background")?.textContent ?? "");
  expect(await kept(page)).toMatchObject({ dots: [{ hue: 0, chroma: 0.5 }] });
  await page.mouse.move(centre.x, centre.y + centre.r * 0.9);
  const later = await page.evaluate(() => document.getElementById("workbench-background")?.textContent ?? "");
  expect(later).not.toBe(painting);
  await page.mouse.up();
  await expect.poll(() => kept(page)).toMatchObject({ dots: [{ hue: 90, chroma: 0.9 }] });
  // Past the rim the dot stays on it, and says why.
  await page.mouse.move(centre.x, centre.y + centre.r * 0.9);
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y + centre.r * 1.6, { steps: 4 });
  await expect(page.getByTestId("background-word")).toContainText("Held at the rim");
  const held = await dotAt(page, 0);
  expect(Math.hypot(held.x, held.y)).toBeCloseTo(1, 1);
  await page.mouse.up();
  await expect.poll(() => kept(page)).toMatchObject({ dots: [{ hue: 90, chroma: 1 }] });
});

test("spreads a harmony from the first colour, and carries the others with it", async ({ page }) => {
  await open(page, { backgrounds: { teal: { dots: [{ hue: 0, chroma: 0.8 }], harmony: "single" } } });
  await page.getByTestId("harmony-complementary").click();
  await expect(page.getByTestId("background-dot")).toHaveCount(2);
  const second = await dotAt(page, 1);
  expect(second.x).toBeCloseTo(-0.8, 1);
  await page.getByTestId("harmony-triad").click();
  await expect(page.getByTestId("background-dot")).toHaveCount(3);
  await expect(page.getByTestId("harmony-triad")).toHaveAttribute("aria-checked", "true");
  // Dragging the first turns the triad.
  const centre = await pad(page);
  await page.mouse.move(centre.x + centre.r * 0.8, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y + centre.r * 0.8, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => kept(page).then((bg) => bg?.dots.map((dot: { hue: number }) => dot.hue))).toEqual([90, 210, 330]);
  // Dragging another sets it free.
  const other = await dotAt(page, 1);
  await page.mouse.move(centre.x + other.x * centre.r, centre.y + other.y * centre.r);
  await page.mouse.down();
  await page.mouse.move(centre.x + centre.r * 0.3, centre.y - centre.r * 0.3, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("background-word")).toContainText("Free");
  await expect(page.getByTestId("harmony-triad")).toHaveAttribute("aria-checked", "false");
});

test("adds and removes a colour, and the last one taken away leaves none", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("background-remove")).toBeDisabled();
  await page.getByTestId("background-add").click();
  await expect(page.getByTestId("background-dot")).toHaveCount(1);
  await page.getByTestId("background-add").click();
  await page.getByTestId("background-add").click();
  await expect(page.getByTestId("background-dot")).toHaveCount(3);
  await expect(page.getByTestId("background-add")).toBeDisabled();
  // The one the minus takes is marked on the pad and named by the minus.
  await expect(page.getByTestId("background-dot").nth(2)).toHaveClass(/chosen/);
  await expect(page.getByTestId("background-remove")).toHaveAccessibleName("Remove colour 3");
  await expect(page.getByTestId("background-word")).toContainText("Minus removes the marked colour");
  for (const left of [2, 1, 0]) {
    await page.getByTestId("background-remove").click();
    await expect(page.getByTestId("background-dot")).toHaveCount(left);
  }
  await expect(page.getByTestId("ready-none")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => kept(page)).toBeNull();
});

test("chooses a ready-made background keeping the strength, and None takes it away", async ({ page }) => {
  await open(page, { backgrounds: { teal: { dots: [{ hue: 0, chroma: 0.8 }], harmony: "single", strength: 0.3, grain: 0 } } });
  await page.getByTestId("ready-aurora").click();
  await expect(page.getByTestId("ready-aurora")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("background-dot")).toHaveCount(3);
  await expect.poll(() => kept(page)).toMatchObject({ harmony: "triad", strength: 0.3, grain: 0 });
  await page.getByTestId("ready-none").click();
  await expect(page.getByTestId("background-dot")).toHaveCount(0);
  await expect(page.getByTestId("background-strength")).toBeDisabled();
  expect(await tinted(page)).toBe(false);
  await expect.poll(() => kept(page)).toBeNull();
});

test("sets the strength and grain, and holds the terminal look to half strength with no grain", async ({ page }) => {
  await open(page, { backgrounds: { teal: { dots: [{ hue: 200, chroma: 0.8 }], harmony: "single", strength: 0.6, grain: 0.25 } } });
  await page.getByTestId("background-strength").fill("90");
  await expect.poll(() => kept(page)).toMatchObject({ strength: 0.9 });
  await page.getByTestId("background-grain").fill("0");
  await expect.poll(() => kept(page)).toMatchObject({ grain: 0 });
  await page.getByTestId("look-terminal").click();
  await expect(page.getByTestId("background-grain")).toBeDisabled();
  await expect(page.getByTestId("background-picker")).toContainText("90%, held at 50% here");
  await expect(page.getByTestId("background-picker")).toContainText("None in this look");
});

test("each palette has a background of its own", async ({ page }) => {
  await open(page, { backgrounds: { teal: { dots: [{ hue: 200, chroma: 0.8 }], harmony: "single" } } });
  await expect(page.getByTestId("background-note")).toContainText("Kept with Teal");
  await page.getByTestId("palette-rose").click();
  await expect(page.getByTestId("background-note")).toContainText("Kept with Rose");
  await expect(page.getByTestId("background-dot")).toHaveCount(0);
  await page.getByTestId("ready-ember").click();
  await expect.poll(() => file(page).then((f) => Object.keys(f.backgrounds).sort())).toEqual(["rose", "teal"]);
});

test.describe("cards", () => {
  const AGENT_CARD = "section[data-pane='agent'] > .body";
  const cardPainted = (page: Page) =>
    page.evaluate((selector) => getComputedStyle(document.querySelector(selector)!).backgroundImage !== "none", AGENT_CARD);
  const LAGOON = {
    dots: [
      { hue: 192, chroma: 0.9 },
      { hue: 252, chroma: 0.8 },
    ],
    harmony: "free",
    strength: 0.6,
    grain: 0.25,
  };

  test("is none at first, greyed until there is a background, and keeps a share beside it", async ({ page }) => {
    await open(page);
    const cards = page.getByTestId("background-cards");
    await expect(cards).toBeDisabled();
    await page.getByTestId("ready-lagoon").click();
    await expect(cards).toBeEnabled();
    await expect(cards).toHaveValue("0");
    await expect(page.getByTestId("background-cards-value")).toHaveText("None");
    expect(await cardPainted(page)).toBe(false);
    await cards.fill("20");
    await expect(page.getByTestId("background-cards-value")).toHaveText("20%");
    await expect.poll(() => file(page).then((f) => f.cards)).toEqual({ teal: 0.2 });
    // Kept beside the background, never inside it.
    expect(Object.keys(await kept(page)).sort()).toEqual(["dots", "grain", "harmony", "strength"]);
    expect(await cardPainted(page)).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-cards", "");
    // The small windows show the card tinted.
    const mini = page.locator(".mini .card").first();
    expect(await mini.evaluate((card) => getComputedStyle(card).backgroundImage)).toContain("gradient");
    await cards.fill("0");
    await expect.poll(() => file(page).then((f) => f.cards)).toEqual({});
    await expect(page.locator("html")).not.toHaveAttribute("data-cards", "");
    expect(await cardPainted(page)).toBe(false);
  });

  test("says in plain words where the guard holds it back", async ({ page }) => {
    await open(page, {
      palette: "mono",
      backgrounds: { mono: { ...LAGOON, dots: [{ hue: 185, chroma: 0.85 }, { hue: 305, chroma: 0.85 }, { hue: 65, chroma: 0.85 }], harmony: "triad", strength: 1 } },
      cards: { mono: 0.25 },
    });
    await expect(page.getByTestId("background-cards-value")).toHaveText("25%, held at 14% in light");
    await expect(page.getByTestId("background-cards")).toHaveAttribute(
      "aria-valuetext",
      "25% of the strength, held at 14% in light",
    );
    await expect(page.getByTestId("background-note")).toContainText(
      "Held at 14% in light, since more would leave a terminal colour hard to read.",
    );
  });

  test("says when in dark the cards would melt into the ground", async ({ page }) => {
    await open(page, {
      appearance: "dark",
      backgrounds: { teal: { dots: [{ hue: 250, chroma: 0.3 }], harmony: "single", strength: 0.6, grain: 0.25 } },
      cards: { teal: 0.2 },
    });
    await expect(page.getByTestId("background-cards-value")).toHaveText("20%, none in dark");
    await expect(page.getByTestId("background-note")).toContainText(
      "None shows through in dark, since any would melt the cards into the ground.",
    );
    // Held at none, the window is as it is with none asked.
    await expect(page.locator("html")).not.toHaveAttribute("data-cards", "");
    expect(await cardPainted(page)).toBe(false);
  });

  test("is greyed with the reason while the system asks for more contrast", async ({ page }) => {
    await open(page, { backgrounds: { teal: LAGOON }, cards: { teal: 0.2 } });
    await expect(page.getByTestId("background-cards")).toBeEnabled();
    await page.emulateMedia({ contrast: "more" });
    await expect(page.getByTestId("background-cards")).toBeDisabled();
    await expect(page.getByTestId("background-note")).toContainText("Off while the system asks for more contrast.");
    await expect(page.locator("html")).not.toHaveAttribute("data-cards", "");
    expect(await cardPainted(page)).toBe(false);
  });

  test("repaints the cards as the slider moves, and keeps the share once let go", async ({ page }) => {
    await open(page, { backgrounds: { teal: LAGOON } });
    const cards = page.getByTestId("background-cards");
    await cards.evaluate((input: HTMLInputElement) => {
      input.value = "12";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(page.locator("html")).toHaveAttribute("data-cards", "");
    expect((await file(page))?.cards ?? {}).toEqual({});
    await cards.evaluate((input: HTMLInputElement) => input.dispatchEvent(new Event("change", { bubbles: true })));
    await expect.poll(() => file(page).then((f) => f.cards)).toEqual({ teal: 0.12 });
  });
});
