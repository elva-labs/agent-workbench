import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

const MOD = "ControlOrMeta";
const AGENT = "section[data-pane='agent']";
const DAY = 24 * 60 * 60;

const file = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    SETTINGS_FILE,
  );

/** Two sessions of the app's own on disk: one changed yesterday, one left
    for ten days. */
async function withTwo(page: Page, settings: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await installFakeCore(page, {
    open: [PROJECT],
    settings,
    transcripts: [
      { id: "fresh-1", modified: now - DAY, size: 100, title: "fresh work" },
      { id: "stale-1", modified: now - 10 * DAY, size: 100, title: "stale work" },
    ],
  });
  await page.addInitScript(
    ({ project }) => {
      localStorage.setItem(
        "workbench.mine",
        JSON.stringify({ [project]: ["fresh-1", "stale-1"] }),
      );
    },
    { project: PROJECT },
  );
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
}

test("lists every past session of its own until a span is chosen", async ({ page }) => {
  await withTwo(page);
  await expect(page.getByTestId("past-session")).toHaveCount(2);
  await expect(page.getByTestId("outside-fold")).toHaveCount(0);

  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-sessions").click();
  await expect(page.getByTestId("past-sessions-forever")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("past-sessions-week").click();
  await expect.poll(async () => (await file(page)).pastSessions).toBe("week");
  await page.keyboard.press("Escape");

  // The stale one is behind the fold, counted there, and still ours to
  // bring back by widening the span.
  await expect(page.getByTestId("past-session")).toHaveCount(1);
  await expect(page.getByTestId("past-session")).toContainText("fresh work");
  await expect(page.getByTestId("outside-fold")).toContainText("1");

  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("past-sessions-month").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("past-session")).toHaveCount(2);
});

test("reads the span from the machine's settings", async ({ page }) => {
  await withTwo(page, { pastSessions: "week" });
  await expect(page.getByTestId("past-session")).toHaveCount(1);
  await expect(page.getByTestId("outside-fold")).toContainText("1");
});
