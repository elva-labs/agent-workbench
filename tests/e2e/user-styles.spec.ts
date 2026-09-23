import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, STYLES_FILE, installFakeCore } from "./fake";

/**
 * The user's own stylesheet: laid over the app's while it is on, set aside
 * while the settings are open or the app asks something, and written by an
 * agent through styles_write with the user's say.
 */

const AGENT = "section[data-pane='agent']";
const MOD = "ControlOrMeta";
const SHEET = "section[data-pane='agent'] > header { letter-spacing: 7px; }";

const spacing = (page: Page) =>
  page
    .locator(`${AGENT} > header`)
    .evaluate((header) => getComputedStyle(header).letterSpacing);

const file = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), SETTINGS_FILE);

interface Answer {
  id: string;
  content: string | null;
  error: string | null;
}

async function writeStyles(page: Page, id: string, css: string) {
  await page.evaluate(
    ({ project, id, css }) =>
      (window as unknown as { __settingsRequest: (call: unknown) => void }).__settingsRequest({
        id,
        tool: "styles_write",
        arguments: { css, reason: "Wider headers, as asked." },
        cwd: project,
        session: null,
      }),
    { project: PROJECT, id, css },
  );
}

const answerTo = async (page: Page, id: string): Promise<Answer | null> =>
  (
    await page.evaluate(
      () => (window as unknown as { __settingsAnswers?: Answer[] }).__settingsAnswers ?? [],
    )
  ).find((answer) => answer.id === id) ?? null;

test("lays the sheet over the app's only while it is on", async ({ page }) => {
  await installFakeCore(page, { settings: { userStyles: true }, styles: SHEET });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await expect.poll(() => spacing(page)).toBe("7px");

  // Turned off from outside the page, the way the app's menu does it.
  await page.evaluate((key) => {
    const next = { ...JSON.parse(localStorage.getItem(key) ?? "{}"), userStyles: false };
    localStorage.setItem(key, JSON.stringify(next));
    (window as unknown as { __settingsChanged: (s: unknown) => void }).__settingsChanged({
      appearance: "system",
      look: "modern",
      palette: "teal",
      terminalFont: "system",
      interfaceFont: "system",
      keys: {},
      hooks: { everywhere: true, overrides: {} },
      themes: {},
      ...next,
    });
  }, SETTINGS_FILE);
  await expect.poll(() => spacing(page)).not.toBe("7px");
});

test("is set aside while the settings are open, where it is turned on and off", async ({
  page,
}) => {
  await installFakeCore(page, { settings: {}, styles: SHEET });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  expect(await spacing(page)).not.toBe("7px");

  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("styles-off")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("styles-note")).toContainText("It has 1 line.");
  await page.getByTestId("styles-on").click();
  await expect.poll(async () => (await file(page)).userStyles).toBe(true);
  // Still aside: the settings are open.
  expect(await spacing(page)).not.toBe("7px");
  await page.keyboard.press("Escape");
  await expect.poll(() => spacing(page)).toBe("7px");

  await page.keyboard.press(`${MOD}+,`);
  await expect.poll(() => spacing(page)).not.toBe("7px");
  await page.getByTestId("styles-off").click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await file(page)).userStyles).toBe(false);
  expect(await spacing(page)).not.toBe("7px");
});

test("says why a sheet on disk is not used", async ({ page }) => {
  await installFakeCore(page, {
    settings: { userStyles: true },
    styles: "body { background: url(https://evil.example/p.png); }",
  });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  const sheet = await page.evaluate(
    () => document.getElementById("workbench-user-styles")?.textContent ?? "",
  );
  expect(sheet).toBe("");
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("styles-problem")).toContainText("not a data: url");
});

test("an agent's sheet is shown as it is, set aside while asked, and kept only when allowed", async ({
  page,
}) => {
  await installFakeCore(page, {
    settings: { userStyles: true },
    styles: "section[data-pane='agent'] > header { letter-spacing: 3px; }",
  });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await expect.poll(() => spacing(page)).toBe("3px");

  await writeStyles(page, "s-1", SHEET);
  await expect(page.getByTestId("settings-ask")).toBeVisible();
  await expect(page.getByTestId("settings-ask-css")).toHaveText(SHEET);
  // While the app asks, no sheet of the user's dresses the page.
  await expect.poll(() => spacing(page)).not.toBe("3px");
  expect(await spacing(page)).not.toBe("7px");

  await page.getByTestId("settings-allow").click();
  await expect.poll(() => spacing(page)).toBe("7px");
  expect(await page.evaluate((key) => localStorage.getItem(key), STYLES_FILE)).toBe(SHEET);
  await expect.poll(() => answerTo(page, "s-1")).not.toBeNull();
  expect((await answerTo(page, "s-1"))!.error).toBeNull();

  await page.getByTestId("settings-undo-button").click();
  await expect.poll(() => spacing(page)).toBe("3px");
});

test("an agent's sheet that would load anything is refused without asking", async ({
  page,
}) => {
  await installFakeCore(page, { settings: {} });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await writeStyles(page, "s-2", "@import 'https://evil.example/x.css';");
  await expect.poll(() => answerTo(page, "s-2")).not.toBeNull();
  expect((await answerTo(page, "s-2"))!.error).toMatch(/imports another/);
  await expect(page.getByTestId("settings-ask")).toHaveCount(0);
});
