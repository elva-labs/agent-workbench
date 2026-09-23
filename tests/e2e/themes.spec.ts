import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

/**
 * Themes of the user's own: token values over the default palette, kept in
 * the settings file, chosen and deleted in the settings, and saved by an
 * agent through the theme_save tool with the user's say.
 */

const AGENT = "section[data-pane='agent']";
const MOD = "ControlOrMeta";

const DUSK = {
  label: "Dusk",
  light: { accent: "#7a4a8c", bg: "#f7f2f9" },
  dark: { accent: "#c39ad4" },
  shape: { radius: "10px" },
};

const token = (page: Page, name: string) =>
  page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim(),
    name,
  );

const file = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), SETTINGS_FILE);

interface Answer {
  id: string;
  content: string | null;
  error: string | null;
}

async function saveTheme(page: Page, id: string, args: Record<string, unknown>) {
  await page.evaluate(
    ({ project, id, args }) =>
      (window as unknown as { __settingsRequest: (call: unknown) => void }).__settingsRequest({
        id,
        tool: "theme_save",
        arguments: args,
        cwd: project,
        session: null,
      }),
    { project: PROJECT, id, args },
  );
}

const answerTo = async (page: Page, id: string): Promise<Answer | null> =>
  (
    await page.evaluate(
      () => (window as unknown as { __settingsAnswers?: Answer[] }).__settingsAnswers ?? [],
    )
  ).find((answer) => answer.id === id) ?? null;

test("paints a theme the settings file chooses, light and dark", async ({ page }) => {
  await installFakeCore(page, {
    settings: { palette: "dusk", appearance: "light", themes: { dusk: DUSK } },
  });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "dusk");
  expect(await token(page, "accent")).toBe("#7a4a8c");
  expect(await token(page, "bg")).toBe("#f7f2f9");
  expect(await token(page, "radius")).toBe("10px");
  // Left alone by the theme, a token keeps the default palette's value.
  expect(await token(page, "ink")).toBe("#14181a");

  // In the dark the theme's dark colours hold, and a colour set only for
  // light gives way to the default's dark one.
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await token(page, "accent")).toBe("#c39ad4");
  expect(await token(page, "bg")).toBe("#0e1112");
  const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(ground).toBe("rgb(14, 17, 18)");
});

test("an agent's theme is shown as swatches, and kept only when allowed", async ({ page }) => {
  await installFakeCore(page, { settings: {} });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  const before = await token(page, "accent");

  await saveTheme(page, "t-1", { name: "dusk", ...DUSK, reason: "A purple one, as asked." });
  const ask = page.getByTestId("settings-ask");
  await expect(ask).toBeVisible();
  await expect(page.getByTestId("settings-ask-reason")).toHaveText("A purple one, as asked.");
  const rows = page.getByTestId("settings-ask-change");
  await expect(rows.nth(0)).toContainText("Dusk, new");
  await expect(rows.nth(1)).toContainText("Palette");
  const light = page.locator("[data-testid='settings-ask-theme'] [data-appearance='light']");
  const dark = page.locator("[data-testid='settings-ask-theme'] [data-appearance='dark']");
  await expect(light).toHaveCSS("background-color", "rgb(247, 242, 249)");
  await expect(dark).toHaveCSS("background-color", "rgb(14, 17, 18)");
  await expect(light.locator(".bar")).toHaveCSS("background-color", "rgb(122, 74, 140)");
  // Nothing is painted while the user decides.
  expect(await token(page, "accent")).toBe(before);

  await page.getByTestId("settings-allow").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "dusk");
  await expect.poll(() => token(page, "accent")).not.toBe(before);
  await expect.poll(async () => (await file(page)).palette).toBe("dusk");
  expect((await file(page)).themes.dusk.light.accent).toBe("#7a4a8c");
  await expect.poll(() => answerTo(page, "t-1")).not.toBeNull();
  expect((await answerTo(page, "t-1"))!.error).toBeNull();

  // The pane's corners follow the theme's shape.
  const radius = await page
    .getByTestId("settings-undo")
    .evaluate((word) => getComputedStyle(word).borderTopLeftRadius);
  expect(radius).toBe("10px");

  await page.getByTestId("settings-undo-button").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-palette", /.+/);
  await expect.poll(async () => (await file(page)).themes).toEqual({});
  expect(await token(page, "accent")).toBe(before);
});

test("an agent's theme that cannot be read is refused without asking", async ({ page }) => {
  await installFakeCore(page, { settings: {} });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await saveTheme(page, "t-2", { name: "fog", light: { ink: "#dcdcdc" } });
  await expect.poll(() => answerTo(page, "t-2")).not.toBeNull();
  expect((await answerTo(page, "t-2"))!.error).toMatch(/ink on surface has a contrast of/);
  await expect(page.getByTestId("settings-ask")).toHaveCount(0);
});

test("the user's own themes are chosen and deleted in the settings", async ({ page }) => {
  await installFakeCore(page, { settings: { palette: "dusk", themes: { dusk: DUSK } } });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await page.keyboard.press(`${MOD}+,`);
  const swatch = page.getByTestId("palette-dusk");
  await expect(swatch).toBeVisible();
  await expect(swatch).toHaveText("Dusk");
  await expect(swatch).toHaveAttribute("aria-checked", "true");

  await page.getByTestId("palette-rose").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "rose");
  await swatch.click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "dusk");

  await page.getByTestId("theme-delete-dusk").click();
  await expect(swatch).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-palette", /.+/);
  await expect.poll(async () => (await file(page)).themes).toEqual({});
  expect((await file(page)).palette).toBe("teal");
});
