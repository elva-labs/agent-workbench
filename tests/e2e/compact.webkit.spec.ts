import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

/**
 * Compact mode: the sessions pane out of the layout, slid in over the
 * panes from the window's left edge or by the chord that goes to it. Runs
 * in WebKit as well, the app's own webview on macOS.
 */

const SESSIONS = "[data-testid='sessions-slot'] section[data-pane='sessions']";
const AGENT = "section[data-pane='agent']";
const CHANGES = "section[data-pane='changes']";
const MOD = "ControlOrMeta";
/** How long the pointer is away before the pane goes, as the app has it. */
const AWAY_AFTER = 400;

/** The chord bound to going to the sessions pane in these tests, which is
    not the default, so the tests press the binding and not a key of
    their own. */
const BOUND = { key: "y", shift: false, alt: false };
const PRESS_BOUND = `${MOD}+y`;

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} is not drawn`);
  return box;
}

/** Waits until the slid-in pane stands all the way in, at the window's
    left edge or the frame's padding. */
async function slidIn(page: Page) {
  await expect(page.locator(SESSIONS)).toBeVisible();
  await expect.poll(async () => (await boxOf(page, SESSIONS)).x).toBeLessThanOrEqual(10);
}

async function slidOut(page: Page) {
  await expect(page.locator(SESSIONS)).toBeHidden();
}

async function start(page: Page, settings: Record<string, unknown> = {}) {
  await installFakeCore(page, { settings: { compact: true, keys: { "focus.sessions": BOUND }, ...settings } });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await slidOut(page);
}

/** Brings the pane in by the bound chord and starts a session from it, so
    there is a row to pick; the pane goes as the session starts. */
async function startSession(page: Page) {
  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  await page.getByTestId("new-session").click();
  await slidOut(page);
}

test("leaves the sessions pane out of the layout and gives the others its width", async ({ page }) => {
  await start(page);
  await slidOut(page);
  const agent = await boxOf(page, AGENT);
  const changes = await boxOf(page, CHANGES);
  // Only the edge before the panes is left: the gap at the right edge in
  // the modern look, the frame's padding in the terminal look.
  expect(agent.x).toBeLessThanOrEqual(10);
  const width = page.viewportSize()!.width;
  expect(changes.x + changes.width).toBeGreaterThan(width - 12);
  // Nothing of the hidden pane takes the keyboard on Tab.
  await expect(page.locator("[data-testid='sessions-slot']")).toHaveAttribute("inert", "");
});

test("slides the pane in at the left edge, and back a moment after the pointer leaves it", async ({ page }) => {
  await start(page);
  await page.mouse.move(600, 400);
  await page.mouse.move(2, 400, { steps: 4 });
  await slidIn(page);
  // Over the panes, pushing nothing.
  expect((await boxOf(page, AGENT)).x).toBeLessThanOrEqual(10);

  // Into the pane and away again: it waits a moment before it goes.
  await page.mouse.move(120, 400, { steps: 3 });
  const away = Date.now();
  await page.mouse.move(900, 400, { steps: 3 });
  await slidOut(page);
  expect(Date.now() - away).toBeGreaterThanOrEqual(AWAY_AFTER - 50);
  // The keyboard never moved.
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
});

test("slides the pane in when the pointer leaves the window by its left edge", async ({ page }) => {
  await start(page);
  await page.mouse.move(400, 400);
  await page.mouse.move(14, 400, { steps: 4 });
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, clientX: 14, clientY: 400, relatedTarget: null }),
    ),
  );
  await slidIn(page);
  // Back in the window, over the pane, it stays; away from it, it goes.
  await page.mouse.move(100, 400, { steps: 2 });
  await page.mouse.move(900, 400, { steps: 3 });
  await slidOut(page);
});

test("holds the pane while a menu is open in it, wherever the pointer goes", async ({ page }) => {
  await page.clock.install();
  await start(page);
  await page.mouse.move(2, 400, { steps: 2 });
  await slidIn(page);
  await page.getByTestId("project-sort").click();
  await page.mouse.move(900, 400, { steps: 3 });
  await page.clock.runFor(AWAY_AFTER * 3);
  await expect(page.locator(SESSIONS)).toBeVisible();

  // The menu put away, the pointer still away, the pane goes.
  await page.keyboard.press("Escape");
  await page.clock.runFor(AWAY_AFTER * 3);
  await slidOut(page);
});

test("slides in with the keyboard by the bound chord, and Escape returns the keyboard", async ({ page }) => {
  await page.clock.install();
  await start(page);
  await page.mouse.move(900, 400);

  // The default chord is not the one bound.
  await page.keyboard.press(`${MOD}+1`);
  await page.clock.runFor(200);
  await slidOut(page);

  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
  expect(await page.evaluate(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane"))).toBe(
    "sessions",
  );
  // The keyboard holds it while the pointer is away.
  await page.mouse.move(1000, 300, { steps: 2 });
  await page.clock.runFor(AWAY_AFTER * 3);
  await expect(page.locator(SESSIONS)).toBeVisible();

  await page.keyboard.press("Escape");
  await slidOut(page);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");

  // The chord again sends it back too.
  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  await page.keyboard.press(PRESS_BOUND);
  await slidOut(page);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
});

test("picking a session sends the pane back, the keyboard in its agent", async ({ page }) => {
  await start(page);
  await startSession(page);
  await startSession(page);
  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  const rows = page.locator(`${SESSIONS} [data-testid='session-row']`);
  await expect(rows).toHaveCount(2);
  await rows.last().click();
  await slidOut(page);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");

  // Picking the project sends it back too, the keyboard where it was.
  await page.keyboard.press(`${MOD}+3`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  await page.locator(`${SESSIONS} [data-row="project:${PROJECT}"]`).click();
  await slidOut(page);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
});

test("goes to a session from the palette without showing the pane", async ({ page }) => {
  await start(page);
  await startSession(page);
  await startSession(page);
  await page.keyboard.press(`${MOD}+p`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  await slidOut(page);
});

test("marks the edge while a session waits for you, and the status bar counts it", async ({ page }) => {
  await start(page);
  await startSession(page);
  await startSession(page);
  await expect(page.getByTestId("compact-mark")).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { __notifyRequest: (request: unknown) => void }).__notifyRequest({
      text: "Tests green, ready to merge.",
      cwd: "/home/ada/dev/demo",
      session: "session-1",
    }),
  );
  await expect(page.getByTestId("compact-mark")).toBeVisible();
  await expect(page.getByTestId("waiting-readout")).toHaveText("1 waiting for you");
  const mark = await boxOf(page, "[data-testid='compact-mark']");
  expect(mark.x).toBeLessThan(8);
});

test("keeps the setting across a reload, and leaves the fold and the width as they were", async ({ page }) => {
  await installFakeCore(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("laid") !== null) return;
    sessionStorage.setItem("laid", "yes");
    localStorage.setItem("workbench.layout", JSON.stringify({ sessions: 340 }));
  });
  await page.goto("/");
  const pane = "section[data-pane='sessions']";
  await expect.poll(async () => Math.round((await boxOf(page, pane)).width)).toBe(340);
  // Folded by its toggle before compact mode comes on.
  await page.keyboard.press(`${MOD}+b`);
  await expect.poll(async () => (await boxOf(page, pane)).width).toBeLessThan(100);

  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("compact-on").click();
  await page.keyboard.press("Escape");
  await slidOut(page);
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").compact, SETTINGS_FILE))
    .toBe(true);

  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await slidOut(page);
  expect((await boxOf(page, AGENT)).x).toBeLessThanOrEqual(10);

  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("compact-on")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("compact-off").click();
  await page.keyboard.press("Escape");
  // Still folded, and open again at the width it had.
  await expect.poll(async () => (await boxOf(page, pane)).width).toBeLessThan(100);
  await page.keyboard.press(`${MOD}+b`);
  await expect.poll(async () => Math.round((await boxOf(page, pane)).width)).toBe(340);
});
