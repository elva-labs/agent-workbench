import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * The notes a session keeps of its conversation are read from its row's
 * menu, and only there: the item is offered for a session that keeps any,
 * and opens them in the viewer as a document.
 */

const ROW = "[data-testid='session-row']";

const row = (page: Page, name: string) => page.locator(ROW).filter({ hasText: name });

test("opens a session's notes in the viewer from its menu, offered only when it keeps some", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await page.getByTestId("new-session").click();
  await expect(row(page, "session 1")).toContainText("running");
  await page.getByTestId("new-session").click();
  await expect(page.locator(ROW)).toHaveCount(2);

  // None kept: the menu is as it was.
  await row(page, "session 1").click({ button: "right" });
  const menu = page.getByTestId("session-menu");
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  await expect(page.getByTestId("session-menu-notes")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await page.evaluate(() => {
    const fake = window as unknown as { __notes: unknown; __markdown: string };
    fake.__notes = { "session-1": { standing: 2, brief: true } };
    fake.__markdown = "# Notes\n\n## Brief\n\nA desktop app for agents.\n\n## Notes\n\n### Default model\n\nOne tier below the starter.\n";
  });
  await row(page, "session 1").click({ button: "right" });
  const item = page.getByTestId("session-menu-notes");
  await expect(item).toHaveText("Show notes");
  // Quiet: it sits above the stop, never first.
  await expect(menu.getByRole("menuitem").first()).not.toHaveText("Show notes");
  await expect(menu.getByRole("menuitem").last()).not.toHaveText("Show notes");
  await item.click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("media-caption")).toHaveText("Notes");
  const viewer = page.getByTestId("media-file");
  await expect(viewer.getByRole("heading", { name: "Default model" })).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "Notes.md" })).toBeVisible();
});

test("a terminal row goes on from its notes in its first prompt, and its menu resumes the old conversation whole", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const head =
    "From the workbench, not the user: this conversation goes on from an earlier one of yours, which was not read again, since reading all of it with its cache lapsed would cost far more. What you need to go on is below.";
  const briefing = `${head}\n\nNo notes were kept of the earlier conversation.\nEnd of the workbench's briefing.`;
  await installFakeCore(page, {
    open: [PROJECT],
    transcripts: [{ id: "past-1", modified: now - 7200, size: 100, title: "Count things" }],
  });
  await page.addInitScript(
    ({ project, briefing }) => {
      localStorage.setItem("chord.mine", JSON.stringify({ [project]: ["past-1"] }));
      (window as unknown as { __goingOn: unknown }).__goingOn = { context: 412_000, idle: 7200, goesOn: true, briefing };
    },
    { project: PROJECT, briefing },
  );
  await page.goto("/");
  const spawns = () =>
    page.evaluate(
      () => (window as unknown as { __spawns?: { session?: string; prompt?: string }[] }).__spawns ?? [],
    );
  await page.getByTestId("past-session").click();
  await expect.poll(async () => (await spawns()).length).toBe(1);
  const [fresh] = await spawns();
  expect(fresh.session).toBeUndefined();
  expect(fresh.prompt).toBe(`${briefing}\n\nTake in the above, say in one line that you have it, and wait for the user.`);
  // The same name, and the old conversation is the row's, not listed beside it.
  await expect(row(page, "Count things")).toHaveCount(1);
  await expect(page.getByTestId("past-session")).toHaveCount(0);

  await row(page, "Count things").click({ button: "right" });
  await expect(page.getByTestId("session-menu-whole")).toHaveText("Resume whole, reads 412k tokens");
  await page.getByTestId("session-menu-whole").click();
  await expect.poll(async () => (await spawns()).length, { timeout: 10_000 }).toBe(2);
  const whole = (await spawns())[1];
  expect(whole.session).toBe("past-1");
  expect(whole.prompt).toBeUndefined();
});
