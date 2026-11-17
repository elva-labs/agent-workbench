import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * Switching how an agent's sessions run moves the sessions already open:
 * one at rest on screen at once, and one at work or asking only once it is
 * at rest and on screen, each in its own row, as the same conversation.
 * One that would lose a command in the background stays, and says so.
 */

const ROW = "[data-testid='session-row']";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

function spawns(page: Page): Promise<{ session?: string; token?: string }[]> {
  return page.evaluate(() => (window as unknown as { __spawns?: never[] }).__spawns ?? []);
}

function stops(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (
      window as unknown as { __integrated: { calls: { method: string; id?: string }[] } }
    ).__integrated.calls
      .filter((call) => call.method === "stop")
      .map((call) => call.id ?? ""),
  );
}

/** The composer of the conversation on screen: those of the others stay
    mounted out of sight. */
function composer(page: Page) {
  return page.locator("[data-testid='composer-input']:visible");
}

/** The rows' names, in the order the pane lists them. */
async function names(page: Page): Promise<string[]> {
  return (await page.locator(`${ROW} .label`).allInnerTexts()).map((text) => text.trim());
}

function row(page: Page, name: string) {
  return page.locator(ROW).filter({ hasText: name });
}

/** A new conversation in the project, named by its first message and
    answered, so it rests. */
async function conversation(page: Page, handle: string, words: string) {
  await page.locator(`[data-row="project:${PROJECT}"]`).getByTestId("project-new-session").click();
  await expect(composer(page)).toBeVisible();
  await composer(page).fill(words);
  await page.keyboard.press("Enter");
  await agent(page, `f.startTurn("${handle}"); f.turn("${handle}", "Done."); `);
  await expect(row(page, words)).toHaveCount(1);
}

async function switchTo(page: Page, kind: "terminal" | "integrated") {
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByTestId("settings-tab-sessions").click();
  await page
    .locator("[data-testid='session-kind'][data-agent='claude-code']")
    .getByTestId(`session-kind-${kind}`)
    .click();
  await page.getByTestId("settings-close").click();
}

test("moves a session at rest at once, and one at work or asking once it is at rest and shown", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await conversation(page, "int-1", "Resting");
  await conversation(page, "int-2", "Working");
  await conversation(page, "int-3", "Asking");
  // One goes back to work, another asks a question.
  await row(page, "Working").click();
  await composer(page).fill("Once more");
  await page.keyboard.press("Enter");
  await agent(page, `f.startTurn("int-2");`);
  await row(page, "Asking").click();
  await composer(page).fill("Which one?");
  await page.keyboard.press("Enter");
  await agent(
    page,
    `f.startTurn("int-3"); f.question("int-3", [{ header: "Stage", question: "Which stage?", options: [{ label: "dev", description: null }, { label: "prod", description: null }], multiple: false }]);`,
  );
  await expect(page.getByTestId("question-dock")).toContainText("Which stage?");
  await row(page, "Resting").click();
  const before = await names(page);

  await switchTo(page, "terminal");

  // The one on screen, at rest, goes on in a terminal in its own row,
  // where it was in the list.
  await expect.poll(async () => (await spawns(page)).map((spawned) => spawned.session)).toEqual(["integrated-session-1"]);
  await expect(page.locator("[data-testid='conversation']:visible")).toHaveCount(0);
  expect(await names(page)).toEqual(before);
  expect(await stops(page)).toEqual(["int-1"]);

  // One asking stays a conversation, its question still there, while it
  // asks, on screen or not.
  await row(page, "Asking").click();
  await expect(page.getByTestId("question-dock")).toContainText("Which stage?");
  // One at work stays a conversation, at work.
  await row(page, "Working").click();
  await expect(page.locator("[data-testid='conversation']:visible")).toBeVisible();
  await expect(row(page, "Working").locator(".dot.working")).toHaveCount(1);
  expect((await spawns(page)).length).toBe(1);
  expect(await stops(page)).toEqual(["int-1"]);

  // The question answered and the turn over, it moves once shown.
  await row(page, "Asking").click();
  await page.getByTestId("question-option").first().click();
  await agent(page, `f.turn("int-3", "Went with dev.");`);
  await expect.poll(async () => (await spawns(page)).map((spawned) => spawned.session)).toEqual([
    "integrated-session-1",
    "integrated-session-3",
  ]);

  // The one at work comes to rest out of sight, and moves once shown.
  await agent(page, `f.turn("int-2", "Fixed.");`);
  await expect(row(page, "Working").locator(".dot.working")).toHaveCount(0);
  expect((await spawns(page)).length).toBe(2);
  const rested = await names(page);
  await row(page, "Working").click();
  await expect.poll(async () => (await spawns(page)).map((spawned) => spawned.session)).toEqual([
    "integrated-session-1",
    "integrated-session-3",
    "integrated-session-2",
  ]);
  await expect(page.locator("[data-testid='conversation']:visible")).toHaveCount(0);

  // Every row where it was, under its name, and none of them ended.
  expect(await names(page)).toEqual(rested);
  await expect(page.locator(".session .dot:not(.live)")).toHaveCount(0);
});

test("leaves a session that would lose a command in the background, saying so, until it is reopened from its menu", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await conversation(page, "int-1", "Serving");
  await agent(page, `f.task("int-1", null, { kind: "shell", background: true, description: "npm run dev" });`);

  await switchTo(page, "terminal");

  const stays = row(page, "Serving").getByTestId("session-stays");
  await expect(stays).toHaveText("Stays a conversation: moving ends npm run dev");
  expect(await spawns(page)).toEqual([]);
  await expect(page.locator("[data-testid='conversation']:visible")).toBeVisible();

  await row(page, "Serving").click({ button: "right" });
  await page.getByTestId("session-menu-reopen").click();
  const strip = page.getByTestId("reopen-session");
  await expect(strip).toContainText("in a terminal?");
  await expect(strip).toContainText("Reopening ends npm run dev.");
  await strip.getByRole("button", { name: "Stop and reopen" }).click();
  await expect.poll(async () => (await spawns(page)).map((spawned) => spawned.session)).toEqual(["integrated-session-1"]);
  await expect(page.locator("[data-testid='conversation']:visible")).toHaveCount(0);
  await expect(page.getByTestId("session-stays")).toHaveCount(0);
});
