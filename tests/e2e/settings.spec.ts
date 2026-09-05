import { expect, test } from "@playwright/test";
import { installFakeCore } from "./fake";

const MOD = "ControlOrMeta";
const AGENT = "section[data-pane='agent']";

test.beforeEach(async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
});

test("opens on the chord and from the menu, and closes on Escape", async ({ page }) => {
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("settings")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toBeHidden();

  // What the native menu's Settings item does.
  await page.evaluate(() => (window as unknown as { __openSettings?: () => void }).__openSettings?.());
  await expect(page.getByTestId("settings")).toBeVisible();
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("settings")).toBeHidden();
});

test("changes the theme and keeps it", async ({ page }) => {
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("changes the colour palette, which repaints the panes, and keeps it", async ({ page }) => {
  const accentOf = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  const before = await accentOf();

  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("palette-indigo").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
  expect(await accentOf()).not.toBe(before);
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
});

// The vim preset moves between panes on h, j, k and l. The status bar and the
// keys themselves follow at once, and the choice survives a reload.
test("switches to the vim preset and the keys follow", async ({ page }) => {
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("preset-vim").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toBeHidden();

  await page.keyboard.press(`${MOD}+l`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
  await page.keyboard.press(`${MOD}+h`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  // The default chord for the same thing no longer does it.
  await page.keyboard.press(`${MOD}+3`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");

  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await page.keyboard.press(`${MOD}+l`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
});

test("records a chord of one's own", async ({ page }) => {
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("chord-review").click();
  await expect(page.getByTestId("chord-review")).toHaveText(/Press keys/);
  await page.keyboard.press(`${MOD}+g`);
  await expect(page.getByTestId("chord-review")).not.toHaveText(/Press keys/);
  await expect(page.getByTestId("preset-custom")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press(`${MOD}+g`);
  await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+d`);
  await expect(page.getByTestId("mode-readout")).toHaveText("working");
});
