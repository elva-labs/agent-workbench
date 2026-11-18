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

test("moves a session at rest at once, one at work or asking once shown at rest, and none under its reader", async ({ page }) => {
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

  // The question answered and the turn over while it is read, it is not
  // moved under the reader: it says it moves next time.
  await row(page, "Asking").click();
  await page.getByTestId("question-option").first().click();
  await agent(page, `f.turn("int-3", "Went with dev.");`);
  await expect(row(page, "Asking").getByTestId("session-stays")).toHaveText("Moves to a terminal next time");
  expect((await spawns(page)).length).toBe(1);
  await expect(page.locator("[data-testid='conversation']:visible")).toBeVisible();

  // The one at work comes to rest out of sight, and moves once shown, at
  // once.
  await agent(page, `f.turn("int-2", "Fixed.");`);
  await expect(row(page, "Working").locator(".dot.working")).toHaveCount(0);
  expect((await spawns(page)).length).toBe(1);
  const rested = await names(page);
  await row(page, "Working").click();
  await expect.poll(async () => (await spawns(page)).map((spawned) => spawned.session)).toEqual([
    "integrated-session-1",
    "integrated-session-2",
  ]);
  await expect(page.locator("[data-testid='conversation']:visible")).toHaveCount(0);
  // Shown again, the one that rested under its reader moves too.
  await row(page, "Asking").click();
  await expect.poll(async () => (await spawns(page)).map((spawned) => spawned.session)).toEqual([
    "integrated-session-1",
    "integrated-session-2",
    "integrated-session-3",
  ]);
  await expect(page.locator("[data-testid='conversation']:visible")).toHaveCount(0);

  // Every row where it was, under its name, and none of them ended.
  expect(await names(page)).toEqual(rested);
  await expect(page.locator(".session .dot:not(.live)")).toHaveCount(0);
});

test("waits for a command in the background to end, saying so, or is reopened from its menu", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await conversation(page, "int-1", "Serving");
  await agent(page, `f.task("int-1", null, { kind: "shell", background: true, description: "npm run dev" });`);

  await switchTo(page, "terminal");

  const stays = row(page, "Serving").getByTestId("session-stays");
  await expect(stays).toHaveText("Moves to a terminal when npm run dev ends");
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

// A core that holds a conversation at a point it went back to says so
// through `integratedHeld`, which a core without going back does not have:
// this runs once the fake core has it.
test("asks the core whether a conversation went back before it moves one into a terminal", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  const held = await page.evaluate(
    () => typeof (window as unknown as { __WORKBENCH_CORE__: { integratedHeld?: unknown } }).__WORKBENCH_CORE__.integratedHeld,
  );
  test.skip(held !== "function", "the core has no integratedHeld yet");
  await conversation(page, "int-1", "Resting");
  await switchTo(page, "terminal");
  await expect.poll(async () => (await spawns(page)).map((spawned) => spawned.session)).toEqual(["integrated-session-1"]);
  const asked = await page.evaluate(() =>
    (
      window as unknown as { __integrated: { calls: { method: string; options?: unknown }[] } }
    ).__integrated.calls.filter((call) => call.method === "held"),
  );
  expect(asked).toEqual([
    { method: "held", options: { agent: "claude-code", project: PROJECT, session: "integrated-session-1" } },
  ]);
});

/** A conversation as its transcript reads back, an hour ago. */
function earlier(text: string) {
  const at = Date.now() - 3_600_000;
  return [
    { at, event: { type: "message", message: "m-past", state: "sent", error: null, text, images: [] } },
    { at, model: "claude-sonnet-5-5", event: { type: "turnStarted", messages: ["m-past"] } },
    { at: at + 5000, event: { type: "text", block: "b-past", parent: null, text: "Two of them fail.", done: true } },
    { at: at + 5000, event: { type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: 5000, usage: null } },
  ];
}

function reads(page: Page): Promise<{ method: string; options: Record<string, unknown> }[]> {
  return page.evaluate(() =>
    (
      window as unknown as { __integrated: { calls: { method: string; options: never }[] } }
    ).__integrated.calls.filter((call) => call.method === "history"),
  );
}

async function top(page: Page, testid: string, index = 0): Promise<number> {
  return (await page.locator(`[data-testid='conversation']:visible [data-testid='${testid}']`).nth(index).boundingBox())!.y;
}

test("moves a terminal session into a conversation that draws what it said before", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect.poll(async () => (await spawns(page)).length).toBe(1);
  for (const kind of ["prompt", "stop"])
    await page.evaluate(
      (kind) =>
        (window as unknown as { __sessionEvent: (event: unknown) => void }).__sessionEvent({ sessionId: "session-1", kind }),
      kind,
    );
  await agent(page, `f.transcript("session-1", ${JSON.stringify(earlier("Run the tests"))});`);

  await switchTo(page, "integrated");

  const said = page.locator("[data-testid='conversation']:visible [data-testid='user-message']");
  await expect(said).toHaveCount(1);
  await expect(said).toContainText("Run the tests");
  expect(await top(page, "agent-run")).toBeLessThan(await top(page, "run-began"));
});

test("moves a terminal row left from the last quit as it wakes, reading what it said before under its account in its worktree", async ({ page }) => {
  const ID = "4f60e3b2-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  const WORKTREE = `${PROJECT}/.claude/worktrees/fix`;
  await installFakeCore(page, {
    open: [PROJECT],
    settings: {
      integrated: ["claude-code"],
      accounts: { list: { Work: { claude: "~/.claude-work", codex: null } }, everywhere: "Work", overrides: {} },
    },
    transcripts: [{ id: ID, modified: Math.floor(Date.now() / 1000) - 3600, size: 100, title: "Run the tests" }],
  });
  // On record at the quit as a terminal session, due to move into a
  // conversation, its transcript kept under the account's directory.
  await page.addInitScript(
    ({ project, id, worktree, items }) => {
      localStorage.setItem(
        "workbench.open",
        JSON.stringify({
          open: [{ project, id, agent: "claude-code", startIn: worktree, model: null, account: "Work", kind: "terminal", moves: "integrated" }],
          active: id,
        }),
      );
      (window as unknown as { __integrated: { transcript(...args: unknown[]): void } }).__integrated.transcript(
        id,
        items,
        "claude-code",
        "~/.claude-work",
      );
    },
    { project: PROJECT, id: ID, worktree: WORKTREE, items: earlier("Run the tests") },
  );
  await page.goto("/");

  const said = page.locator("[data-testid='conversation']:visible [data-testid='user-message']");
  await expect(said).toHaveCount(1);
  await expect(said).toContainText("Run the tests");
  await expect(page.getByTestId("thread-intro")).toHaveCount(0);
  expect(await spawns(page)).toEqual([]);
  expect(await reads(page)).toEqual([
    { method: "history", options: { agent: "claude-code", project: PROJECT, cwd: WORKTREE, session: ID, configDir: "~/.claude-work" } },
  ]);
});
