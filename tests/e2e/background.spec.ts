import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

/**
 * A background of the user's own: painted behind the chrome from the
 * settings file, kept with each palette, read on start with no frame of the
 * plain chrome, set aside when the system asks for more contrast, and
 * changed by an agent with the user's say.
 */

const SESSIONS = "section[data-pane='sessions']";
const AGENT = "section[data-pane='agent']";
const MOD = "ControlOrMeta";

const LAGOON = {
  dots: [
    { hue: 192, chroma: 0.9 },
    { hue: 252, chroma: 0.8 },
  ],
  harmony: "free",
  strength: 0.6,
  grain: 0.25,
};

/** The colour the page shows at a point, read from a screenshot of it. */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const shot = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, shot.toString("base64"));
}

/** A point inside an element, as a fraction of its box. */
async function at(page: Page, selector: string, fx: number, fy: number) {
  const box = (await page.locator(selector).first().boundingBox())!;
  return [Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy)] as const;
}

const blueish = ([r, , b]: [number, number, number]) => b - r;

async function open(page: Page, settings: Record<string, unknown>) {
  await installFakeCore(page, { open: [PROJECT], settings });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
}

test("tints the chrome with the palette's background and leaves the panes that hold text solid", async ({ page }) => {
  await open(page, { appearance: "light", backgrounds: { teal: LAGOON } });
  await page.getByTestId("start-agent").click();
  await expect(page.locator(AGENT)).toContainText("running");

  const side = await pixel(page, ...(await at(page, SESSIONS, 0.5, 0.8)));
  const header = await pixel(page, ...(await at(page, `${AGENT} > header`, 0.6, 0.5)));
  const status = await pixel(page, ...(await at(page, "[data-testid='status-bar']", 0.7, 0.5)));
  const body = await pixel(page, ...(await at(page, `${AGENT} .xterm-screen`, 0.5, 0.8)));
  // The plain light chrome is a neutral grey; the lagoon leans blue.
  expect(blueish(side)).toBeGreaterThan(8);
  expect(blueish(header)).toBeGreaterThan(8);
  expect(blueish(status)).toBeGreaterThan(8);
  expect(body).toEqual([255, 255, 255]);
});

test("in the terminal look tints only the ground between the boxes and the status bar", async ({ page }) => {
  await open(page, { appearance: "light", look: "terminal", backgrounds: { teal: LAGOON } });
  const sessions = (await page.locator(SESSIONS).boundingBox())!;
  const ground = await pixel(page, Math.round(sessions.x + sessions.width + 3), Math.round(sessions.y + sessions.height / 2));
  const inside = await pixel(page, ...(await at(page, SESSIONS, 0.5, 0.8)));
  expect(blueish(ground)).toBeGreaterThan(4);
  expect(inside).toEqual([255, 255, 255]);
});

test("each palette keeps its own background, and one without has the plain chrome", async ({ page }) => {
  await open(page, { appearance: "light", backgrounds: { teal: LAGOON } });
  const plain = await pixel(page, ...(await at(page, SESSIONS, 0.5, 0.8)));
  expect(blueish(plain)).toBeGreaterThan(8);
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("palette-amber").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toBeHidden();
  const amber = await pixel(page, ...(await at(page, SESSIONS, 0.5, 0.8)));
  expect(Math.abs(amber[0] - amber[2])).toBeLessThan(12);
});

test("comes back on a reload with no frame of the plain chrome", async ({ page }) => {
  await open(page, { appearance: "light", backgrounds: { teal: LAGOON } });
  await expect.poll(() => pixel(page, ...[150, 500] as const).then(blueish)).toBeGreaterThan(8);
  // Every frame from the first that draws the sessions pane says whether
  // the background was on it.
  await page.addInitScript(() => {
    const seen: boolean[] = [];
    (window as unknown as { __frames: boolean[] }).__frames = seen;
    const look = () => {
      if (document.querySelector("section[data-pane='sessions']") !== null) {
        seen.push(document.documentElement.dataset.background !== undefined);
      }
      if (seen.length < 30) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __frames: boolean[] }).__frames.length)).toBeGreaterThan(5);
  const frames = await page.evaluate(() => (window as unknown as { __frames: boolean[] }).__frames);
  expect(frames.every(Boolean)).toBe(true);
});

test("is set aside while the system asks for more contrast", async ({ page }) => {
  await open(page, { appearance: "light", backgrounds: { teal: LAGOON } });
  const point = await at(page, SESSIONS, 0.5, 0.8);
  expect(blueish(await pixel(page, ...point))).toBeGreaterThan(8);
  await page.emulateMedia({ contrast: "more" });
  await expect.poll(async () => blueish(await pixel(page, ...point))).toBeLessThan(4);
  await page.emulateMedia({ contrast: "no-preference" });
  await expect.poll(async () => blueish(await pixel(page, ...point))).toBeGreaterThan(8);
});

test("an agent's background is shown on the palette's swatches, and kept only when allowed", async ({ page }) => {
  await open(page, { appearance: "light" });
  await page.evaluate(
    ({ project, background }) =>
      (window as unknown as { __settingsRequest: (call: unknown) => void }).__settingsRequest({
        id: "bg-1",
        tool: "settings_change",
        arguments: { background, reason: "A blue tint, as asked." },
        cwd: project,
        session: null,
      }),
    { project: PROJECT, background: LAGOON },
  );
  const ask = page.getByTestId("settings-ask");
  await expect(ask).toContainText("Lagoon, strength 60%, grain 25%");
  await expect(page.getByTestId("settings-ask-theme")).toBeVisible();
  await page.getByTestId("settings-allow").click();
  await expect.poll(async () => blueish(await pixel(page, ...(await at(page, SESSIONS, 0.5, 0.8))))).toBeGreaterThan(8);
  const file = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), SETTINGS_FILE);
  expect(file.backgrounds).toEqual({ teal: LAGOON });
});
