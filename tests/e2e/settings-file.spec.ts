import { expect, test, type Page } from "@playwright/test";
import { SETTINGS_FILE, installFakeCore } from "./fake";

/**
 * The settings live in one file per machine, which the core keeps. The fake
 * keeps that file in the page's storage, so a reload finds it the way a
 * restart finds the file.
 */

const MOD = "ControlOrMeta";
const AGENT = "section[data-pane='agent']";

const file = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    SETTINGS_FILE,
  );

const accent = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  );

test("paints the machine's settings, not the window's own copy", async ({
  page,
}) => {
  await installFakeCore(page, {
    settings: { palette: "amber", look: "terminal", appearance: "dark" },
  });
  await page.addInitScript(() => {
    // A window copy that disagrees: the file is what counts.
    localStorage.setItem("workbench.palette", "rose");
  });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-palette", "amber");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).not.toHaveAttribute("data-look", /.+/);
  // The pane borders are drawn as boxes: the terminal look, from the file.
  const border = await page
    .locator(AGENT)
    .evaluate((pane) => getComputedStyle(pane).borderTopStyle);
  expect(border).toBe("solid");
});

test("hands the window's own copy over once, on a machine with no file", async ({
  page,
}) => {
  await installFakeCore(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded") !== null) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("workbench.palette", "indigo");
    localStorage.setItem("workbench.mono", "jetbrains");
    localStorage.setItem(
      "workbench.hooks",
      JSON.stringify({ everywhere: false, overrides: { "/x": true } }),
    );
  });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await expect.poll(() => file(page)).not.toBeNull();
  const handed = await file(page);
  expect(handed.palette).toBe("indigo");
  expect(handed.terminalFont).toBe("jetbrains");
  expect(handed.hooks).toEqual({ everywhere: false, overrides: { "/x": true } });
  expect(handed.keys.review).toEqual({ key: "d", shift: false, alt: false });
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");

  // Handed over once: the window's copy changing after that is not news.
  const writes = await page.evaluate(
    () => (window as unknown as { __settingsWrites: unknown[] }).__settingsWrites.length,
  );
  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
  const after = await page.evaluate(
    () => (window as unknown as { __settingsWrites?: unknown[] }).__settingsWrites?.length ?? 0,
  );
  expect(after).toBe(0);
  expect(writes).toBe(1);
});

test("writes a choice made in the settings to the machine's file", async ({
  page,
}) => {
  await installFakeCore(page, { settings: {} });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("palette-rose").click();
  await page.getByTestId("look-terminal").click();
  await expect.poll(async () => (await file(page)).palette).toBe("rose");
  expect((await file(page)).look).toBe("terminal");

  await page.getByTestId("settings-tab-keys").click();
  await page.getByTestId("preset-vim").click();
  await expect
    .poll(async () => (await file(page)).keys["focus.sessions"])
    .toEqual({ key: "h", shift: false, alt: false });

  await page.getByTestId("settings-tab-live").click();
  await page.getByTestId("hooks-everywhere-off").click();
  await expect.poll(async () => (await file(page)).hooks.everywhere).toBe(false);
});

test("follows an edit to the file while the window is open", async ({ page }) => {
  await installFakeCore(page, { settings: {} });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  const before = await accent(page);

  // Something other than this window wrote the file: another window, the
  // user's editor, or an agent.
  await page.evaluate((key) => {
    const next = {
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      palette: "indigo",
      interfaceFont: "inter",
      keys: { review: { key: "g", shift: false, alt: false } },
    };
    localStorage.setItem(key, JSON.stringify(next));
    const w = window as unknown as { __settingsChanged: (s: unknown) => void };
    w.__settingsChanged({
      appearance: "system",
      look: "modern",
      terminalFont: "system",
      hooks: { everywhere: true, overrides: {} },
      ...next,
    });
  }, SETTINGS_FILE);

  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
  await expect(page.locator("html")).toHaveAttribute("data-sans", "inter");
  expect(await accent(page)).not.toBe(before);

  // The new chord works at once, and the old one no longer does.
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-keys").click();
  await expect(page.getByTestId("chord-review")).toContainText("G");
});
