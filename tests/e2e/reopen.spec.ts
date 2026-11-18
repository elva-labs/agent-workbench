import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * A session's row menu reopens a terminal session as a conversation and a
 * conversation in a terminal: the run stops, asking first in the middle of
 * a turn, and the same conversation goes on the other way in the same row.
 */

const ROW = "[data-testid='session-row']";
const H = "int-1";

/** Runs a script against the scripted integrated session. */
function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

function starts(page: Page): Promise<{ options: { session?: string; token?: string; mode?: string } }[]> {
  return page.evaluate(() =>
    (
      window as unknown as { __integrated: { calls: { method: string; options: never }[] } }
    ).__integrated.calls.filter((call) => call.method === "start"),
  );
}

function spawns(page: Page): Promise<{ session?: string; token?: string; mode?: string; ptyId: string }[]> {
  return page.evaluate(() => (window as unknown as { __spawns?: never[] }).__spawns ?? []);
}

test("reopens a terminal session as a conversation in the same row, from its menu", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect.poll(async () => (await spawns(page)).length).toBe(1);
  const [spawned] = await spawns(page);
  // A turn of it, as its hooks say: there is a conversation to go on with.
  for (const kind of ["prompt", "stop"])
    await page.evaluate(
      (kind) =>
        (window as unknown as { __sessionEvent: (event: unknown) => void }).__sessionEvent({
          sessionId: "session-1",
          kind,
        }),
      kind,
    );

  await page.locator(ROW).click({ button: "right" });
  const menu = page.getByTestId("session-menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Mark as unread", "Reopen as a conversation", "Stop"]);
  // The menu hangs under the row it is for, inside the pane.
  const row = (await page.locator(ROW).boundingBox())!;
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(row.y + row.height - 1);
  const pane = (await page.locator("section[data-pane='sessions']").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);

  await page.getByTestId("session-menu-reopen").click();
  await expect(page.getByTestId("conversation")).toBeVisible();
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect.poll(async () => (await starts(page)).length).toBe(1);
  const [start] = await starts(page);
  // The same conversation, under the same token, in the mode the agent's
  // settings give it.
  expect(start.options.session).toBe("session-1");
  expect(start.options.token).toBe(spawned.token);
  expect(start.options.mode).toBeUndefined();
  await expect(page.getByTestId("session-menu")).toHaveCount(0);
  // Claude Code was quit as the user would quit it, not killed.
  const quit = await page.evaluate(() => ({
    written: ((window as unknown as { __written?: [string, string][] }).__written ?? []).filter(([, data]) => data === "\x03"),
    killed: (window as unknown as { __killed?: string[] }).__killed ?? [],
  }));
  expect(quit.written.map(([pty]) => pty)).toEqual([spawned.ptyId, spawned.ptyId]);
  expect(quit.killed).toEqual([]);
});

/** A conversation as its transcript reads back, an hour ago: a question
    and its answer. */
function earlier(text: string) {
  const at = Date.now() - 3_600_000;
  return [
    { at, event: { type: "message", message: "m-past", state: "sent", error: null, text, images: [] } },
    { at, model: "claude-sonnet-5-5", event: { type: "turnStarted", messages: ["m-past"] } },
    { at: at + 5000, event: { type: "text", block: "b-past", parent: null, text: "Two of them fail.", done: true } },
    { at: at + 5000, event: { type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: 5000, usage: null } },
  ];
}

/** Where an element of the conversation on screen stands. */
async function top(page: Page, testid: string, index = 0): Promise<number> {
  return (await page.locator(`[data-testid='conversation']:visible [data-testid='${testid}']`).nth(index).boundingBox())!.y;
}

/** A terminal session the hooks say was spoken to and answered. */
async function spokenTerminal(page: Page) {
  await expect.poll(async () => (await spawns(page)).length).toBe(1);
  for (const kind of ["prompt", "stop"])
    await page.evaluate(
      (kind) =>
        (window as unknown as { __sessionEvent: (event: unknown) => void }).__sessionEvent({ sessionId: "session-1", kind }),
      kind,
    );
}

test("draws what a session reopened as a conversation said before, under its account, with a message sent at once", async ({ page }) => {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: { accounts: { list: { Work: { claude: "~/.claude-work", codex: null } }, everywhere: null, overrides: { [PROJECT]: "Work" } } },
  });
  await page.goto("/");
  await page.locator(`[data-row="project:${PROJECT}"]`).getByTestId("project-new-session").click();
  await page.getByTestId("agent-option").click();
  await spokenTerminal(page);
  await agent(page, `f.transcript("session-1", ${JSON.stringify(earlier("Run the tests"))}, "claude-code", "~/.claude-work"); f.holdHistory();`);

  await page.locator(ROW).click({ button: "right" });
  await page.getByTestId("session-menu-reopen").click();
  // Written to at once, while what it said before is still read.
  const input = page.locator("[data-testid='composer-input']:visible");
  await expect(input).toBeEditable();
  await input.fill("Where are we?");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("earlier-reading")).toBeVisible();
  await agent(page, "f.releaseHistory();");

  const said = page.locator("[data-testid='conversation']:visible [data-testid='user-message']");
  await expect(said).toHaveCount(2);
  await expect(said.first()).toContainText("Run the tests");
  await expect(said.last()).toContainText("Where are we?");
  // What was said before, then where this run began, then this run.
  const line = await top(page, "run-began");
  expect(await top(page, "agent-run")).toBeLessThan(line);
  expect(line).toBeLessThan(await top(page, "user-message", 1));
  await expect(page.getByTestId("earlier-reading")).toHaveCount(0);
  const read = await page.evaluate(() =>
    (
      window as unknown as { __integrated: { calls: { method: string; options: never }[] } }
    ).__integrated.calls.filter((call) => call.method === "history"),
  );
  expect(read).toEqual([
    { method: "history", options: { agent: "claude-code", project: PROJECT, session: "session-1", configDir: "~/.claude-work" } },
  ]);
});

test("says why it draws nothing from before when the agent kept no record of the session", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await spokenTerminal(page);
  await page.locator(ROW).click({ button: "right" });
  await page.getByTestId("session-menu-reopen").click();
  const intro = page.locator("[data-testid='conversation']:visible [data-testid='thread-intro']");
  const why = "This session was resumed. Its earlier messages could not be read: Claude Code has no transcript of it in ~/.claude.";
  await expect(intro).toHaveText(why);
  await page.locator("[data-testid='composer-input']:visible").fill("Where are we?");
  await page.keyboard.press("Enter");
  await agent(page, `f.turn("${H}", "Here.");`);
  // It stays, above what this run says.
  await expect(page.locator("[data-testid='conversation']:visible [data-testid='agent-text']")).toHaveText(["Here."]);
  await expect(intro).toHaveText(why);
  expect(await top(page, "thread-intro")).toBeLessThan(await top(page, "user-message"));
});

test("asks before it reopens a conversation in a terminal in the middle of a turn", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("conversation")).toBeVisible();
  await agent(page, `f.send("${H}", crypto.randomUUID(), "Fix the slow start"); f.startTurn("${H}");`);
  await expect(page.locator(".session .dot.working")).toHaveCount(1);

  // The menu key opens the menu of the row under the cursor; the arrows
  // walk it and Enter picks.
  await page.locator(ROW).click({ button: "right" });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("session-menu")).toHaveCount(0);
  await page.keyboard.press("Shift+F10");
  await expect(page.getByTestId("session-menu").getByRole("menuitem")).toHaveText(["Mark as unread", "Reopen in a terminal", "Stop"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  const strip = page.getByTestId("reopen-session");
  await expect(strip).toContainText("Reopen");
  await expect(strip).toContainText("in a terminal?");
  await expect(strip).toContainText("in the middle of a turn");
  // Cancel keeps it as it was.
  await strip.getByRole("button", { name: "Cancel" }).click();
  await expect(strip).toHaveCount(0);
  await expect(page.getByTestId("conversation")).toBeVisible();

  await page.locator(ROW).click({ button: "right" });
  await page.getByTestId("session-menu-reopen").click();
  await strip.getByRole("button", { name: "Stop and reopen" }).click();
  await expect.poll(async () => (await spawns(page)).length).toBe(1);
  const [spawned] = await spawns(page);
  expect(spawned.session).toBe("integrated-session-1");
  expect(spawned.token).toBe((await starts(page))[0].options.token);
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.getByTestId("conversation")).toHaveCount(0);
});

test("reopens a session another started, which stays its starter's, and whose wait hears no end", async ({ page }) => {
  const LEAD = "/home/ada/dev/lead";
  await installFakeCore(page, { open: [PROJECT, LEAD], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.locator(`[data-row="project:${LEAD}"]`).getByTestId("project-new-session").click();
  await expect(page.getByTestId("conversation")).toBeVisible();
  const conduct = (request: { id: string; tool: string; arguments: Record<string, unknown> }) =>
    page.evaluate(
      ({ request, cwd }) =>
        (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
          ...request,
          cwd,
          session: "integrated-session-1",
        }),
      { request, cwd: LEAD },
    );
  const answers = () =>
    page.evaluate(
      () => (window as unknown as { __conductAnswers?: { id: string; content: string | null }[] }).__conductAnswers ?? [],
    );
  await conduct({ id: "o-1", tool: "start", arguments: { project: PROJECT, prompt: "Bump the client" } });
  await page.getByTestId("conduct-allow").click();
  const kid = page.getByTestId("started-session");
  await expect(kid).toHaveCount(1);
  await expect(page.getByTestId("orchestrator-summary")).toHaveText("1 running");
  // The starter waits on it while it works.
  await conduct({ id: "o-2", tool: "wait", arguments: { session: "integrated-session-2", seconds: 60 } });

  await kid.click({ button: "right" });
  await page.getByTestId("session-menu-reopen").click();
  await page.getByTestId("reopen-session").getByRole("button", { name: "Stop and reopen" }).click();
  await expect.poll(async () => (await spawns(page)).length).toBe(1);
  const [spawned] = await spawns(page);
  // The same conversation, not told its prompt again.
  expect(spawned.session).toBe("integrated-session-2");
  expect((spawned as { prompt?: string }).prompt).toBeUndefined();
  await expect(kid).toHaveCount(1);
  await expect(page.getByTestId("orchestrator-summary")).toHaveText("1 running");
  // The wait never heard it end; it hears the run that goes on.
  await expect.poll(async () => (await answers()).find((answer) => answer.id === "o-2")?.content ?? null).not.toBeNull();
  const heard = (await answers()).find((answer) => answer.id === "o-2")!.content!;
  expect(heard).not.toMatch(/exited|ended|closed/);
  expect(heard).toMatch(/^Session integrated-session-2 stopped working\./);
});

test("goes on in a terminal in the mode chosen on the chip", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] }, defaultMode: "auto" });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  const chip = page.getByTestId("mode-chip");
  await expect(chip).toHaveText("Auto");
  await chip.click();
  await page.getByTestId("mode-option").filter({ hasText: "Default" }).click();
  await expect(chip).toHaveText("Default");
  // Spoken to and answered: there is a conversation to go on with.
  await page.getByTestId("composer-input").fill("Go");
  await page.keyboard.press("Enter");
  await agent(page, `f.turn("${H}", "Done.");`);
  await expect(page.locator(".session .dot.working")).toHaveCount(0);
  await page.locator(ROW).click({ button: "right" });
  await page.getByTestId("session-menu-reopen").click();
  await expect.poll(async () => (await spawns(page)).length).toBe(1);
  expect((await spawns(page))[0]).toMatchObject({ session: "integrated-session-1", mode: "default" });
});

test("offers no reopen for an agent that runs only in a terminal", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], integrable: [] });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect.poll(async () => (await spawns(page)).length).toBe(1);
  await page.locator(ROW).click({ button: "right" });
  await expect(page.getByTestId("session-menu").getByRole("menuitem")).toHaveText(["Mark as unread", "Stop"]);
});
