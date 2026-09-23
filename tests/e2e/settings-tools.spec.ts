import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

/**
 * The tools an agent reads and changes the workbench's own settings with.
 *
 * The core carries a call to the window as a request. A change is put to
 * the user, and made only if they allow it, with an undo offered after.
 * Here the request is pushed straight at the handler the app registered,
 * and the answers are read back off the fake.
 */

const AGENT = "section[data-pane='agent']";
const MOD = "ControlOrMeta";

interface Answer {
  id: string;
  content: string | null;
  error: string | null;
}

async function push(
  page: Page,
  request: { id: string; tool: string; arguments?: Record<string, unknown> },
) {
  await page.evaluate(
    ({ project, request }) =>
      (
        window as unknown as { __settingsRequest: (call: unknown) => void }
      ).__settingsRequest({
        id: request.id,
        tool: request.tool,
        arguments: request.arguments ?? {},
        cwd: project,
        session: null,
      }),
    { project: PROJECT, request },
  );
}

const answerTo = async (page: Page, id: string): Promise<Answer | null> =>
  (
    await page.evaluate(
      () =>
        (window as unknown as { __settingsAnswers?: Answer[] })
          .__settingsAnswers ?? [],
    )
  ).find((answer) => answer.id === id) ?? null;

const file = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    SETTINGS_FILE,
  );

test.beforeEach(async ({ page }) => {
  await installFakeCore(page, { settings: {} });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
});

test("reads the settings for the agent without asking the user", async ({
  page,
}) => {
  await push(page, { id: "r-1", tool: "settings" });
  await expect.poll(() => answerTo(page, "r-1")).not.toBeNull();
  const answer = (await answerTo(page, "r-1"))!;
  expect(answer.error).toBeNull();
  expect(answer.content).toContain("palette: teal");
  expect(answer.content).toContain("review: d");
  await expect(page.getByTestId("settings-ask")).toHaveCount(0);
});

test("puts a change to the user, makes it when allowed, and offers an undo", async ({
  page,
}) => {
  await push(page, {
    id: "c-1",
    tool: "settings_change",
    arguments: { palette: "amber", look: "terminal", reason: "The user asked for warmer colours." },
  });
  const ask = page.getByTestId("settings-ask");
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("wants to change the settings");
  await expect(page.getByTestId("settings-ask-reason")).toHaveText(
    "The user asked for warmer colours.",
  );
  const rows = page.getByTestId("settings-ask-change");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Look");
  await expect(rows.nth(0)).toContainText("Modern");
  await expect(rows.nth(0)).toContainText("Terminal");
  await expect(rows.nth(1)).toContainText("Palette");
  await expect(rows.nth(1)).toContainText("Amber");

  // Nothing has changed while the user decides, and the agent is waiting.
  await expect(page.locator("html")).not.toHaveAttribute("data-palette", /.+/);
  expect(await answerTo(page, "c-1")).toBeNull();

  // The dialog sits over the agent pane, in view.
  const box = (await ask.boundingBox())!;
  const pane = (await page.locator(AGENT).boundingBox())!;
  expect(box.y).toBeLessThan(pane.y + pane.height);
  expect(box.width).toBeGreaterThan(200);

  await page.getByTestId("settings-allow").click();
  await expect(ask).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "amber");
  await expect(page.locator("html")).not.toHaveAttribute("data-look", /.+/);
  await expect.poll(async () => (await file(page)).palette).toBe("amber");
  expect((await file(page)).look).toBe("terminal");
  await expect.poll(() => answerTo(page, "c-1")).not.toBeNull();
  const answer = (await answerTo(page, "c-1"))!;
  expect(answer.error).toBeNull();
  expect(answer.content).toMatch(/allowed the change/);

  // Undo puts back what the change moved, in the window and in the file.
  const undo = page.getByTestId("settings-undo");
  await expect(undo).toBeVisible();
  await expect(undo).toContainText("An agent changed the settings");
  await page.getByTestId("settings-undo-button").click();
  await expect(undo).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-palette", /.+/);
  await expect(page.locator("html")).toHaveAttribute("data-look", "modern");
  await expect.poll(async () => (await file(page)).palette).toBe("teal");
  expect((await file(page)).look).toBe("modern");
});

test("changes nothing when the user declines, and tells the agent", async ({
  page,
}) => {
  await push(page, {
    id: "c-2",
    tool: "settings_change",
    arguments: { appearance: "dark" },
  });
  await expect(page.getByTestId("settings-ask")).toBeVisible();
  await page.getByTestId("settings-decline").click();
  await expect(page.getByTestId("settings-ask")).toHaveCount(0);
  await expect.poll(() => answerTo(page, "c-2")).not.toBeNull();
  expect((await answerTo(page, "c-2"))!.error).toBe(
    "The user declined the change. Nothing changed.",
  );
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  await expect(page.getByTestId("settings-undo")).toHaveCount(0);
  expect(await file(page)).not.toHaveProperty("appearance", "dark");
});

test("refuses a change that will not do without troubling the user", async ({
  page,
}) => {
  await push(page, {
    id: "c-3",
    tool: "settings_change",
    arguments: { hooks: { everywhere: false } },
  });
  await expect.poll(() => answerTo(page, "c-3")).not.toBeNull();
  expect((await answerTo(page, "c-3"))!.error).toMatch(/user's to change/);
  await push(page, {
    id: "c-4",
    tool: "settings_change",
    arguments: { keys: { review: "c" } },
  });
  await expect.poll(() => answerTo(page, "c-4")).not.toBeNull();
  expect((await answerTo(page, "c-4"))!.error).toMatch(/stays with the agent/);
  await expect(page.getByTestId("settings-ask")).toHaveCount(0);
});

test("a chord changed by an agent works at once", async ({ page }) => {
  await push(page, {
    id: "k-1",
    tool: "settings_change",
    arguments: { keys: { review: "g" } },
  });
  const rows = page.getByTestId("settings-ask-change");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Open or close the file viewer");
  await page.getByTestId("settings-allow").click();
  await expect.poll(async () => (await file(page)).keys.review).toEqual({
    key: "g",
    shift: false,
    alt: false,
  });

  await page.locator(AGENT).click();
  await page.keyboard.press(`${MOD}+g`);
  await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+d`);
  await expect(page.getByTestId("mode-readout")).not.toHaveText("reviewing");
});

test("asks one change at a time", async ({ page }) => {
  await push(page, { id: "q-1", tool: "settings_change", arguments: { palette: "rose" } });
  await push(page, { id: "q-2", tool: "settings_change", arguments: { palette: "mono" } });
  const row = page.getByTestId("settings-ask-change");
  await expect(row).toContainText("Rose");
  await page.getByTestId("settings-allow").click();
  // The second is read against the settings the first left.
  await expect(row).toContainText("Mono");
  await expect(row.locator(".from")).toHaveText("Rose");
  // The word offering the first one's undo waits while a question is up.
  await expect(page.getByTestId("settings-undo")).toHaveCount(0);
  await page.getByTestId("settings-decline").click();
  await expect(page.getByTestId("settings-undo")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "rose");
  await expect.poll(() => answerTo(page, "q-2")).not.toBeNull();
  expect((await answerTo(page, "q-1"))!.error).toBeNull();
  expect((await answerTo(page, "q-2"))!.error).toMatch(/declined/);
});
