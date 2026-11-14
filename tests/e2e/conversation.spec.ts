import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// An integrated session as the user meets it: the conversation the agent
// pane draws in place of a terminal, driven by the fake core's scripted
// session. The handle of the first session the fake starts is int-1.

const AGENT = "section[data-pane='agent']";
const H = "int-1";

/** Runs a script against the scripted session, as the agent would act. */
function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

/** The calls the window made on the scripted session. */
function calls(page: Page): Promise<{ method: string; [field: string]: unknown }[]> {
  return page.evaluate(
    () => (window as unknown as { __integrated: { calls: { method: string }[] } }).__integrated.calls,
  );
}

async function openIntegrated(page: Page, options: { untrusted?: boolean } = {}) {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  if (options.untrusted)
    await page.addInitScript(
      (project) =>
        (window as unknown as { __integrated: { untrusted: Set<string> } }).__integrated.untrusted.add(project),
      PROJECT,
    );
  await page.goto("/");
  await page.getByTestId("start-agent").click();
}

test.describe("an integrated session", () => {
  test("draws a conversation in place of a terminal, with its name, project and branch", async ({ page }) => {
    await openIntegrated(page);
    await expect(page.getByTestId("conversation")).toBeVisible();
    await expect(page.locator(`${AGENT} .xterm`)).toHaveCount(0);
    await expect(page.getByTestId("thread-intro")).toContainText("A new Claude Code session in demo");
    await expect(page.getByTestId("conversation-project")).toHaveText("demo");
    await expect(page.getByTestId("conversation-branch")).toHaveText("main");
    await expect(page.getByTestId("session-row")).toHaveCount(1);
    const start = (await calls(page))[0];
    expect(start).toMatchObject({ method: "start", options: { agent: "claude-code", project: PROJECT } });
  });

  test("puts the user's words on the right and the agent's on the left, under its name", async ({ page }) => {
    await openIntegrated(page);
    await agent(page, `f.send("${H}", crypto.randomUUID(), "Fix the slow start"); f.turn("${H}", "Fixed. The scan is shared now.");`);
    const mine = page.getByTestId("user-message");
    const theirs = page.getByTestId("agent-run");
    await expect(mine).toContainText("You");
    await expect(mine).toContainText("Fix the slow start");
    await expect(theirs).toContainText("Claude");
    await expect(theirs).toContainText("Fixed. The scan is shared now.");
    const thread = (await page.getByTestId("thread").boundingBox())!;
    const bubble = (await mine.locator(".bubble").boundingBox())!;
    const run = (await theirs.boundingBox())!;
    // The bubble sits against the right of the thread's column, the run
    // against its left, and the run comes after.
    expect(bubble.x + bubble.width).toBeGreaterThan(thread.x + thread.width / 2 + 100);
    expect(run.x).toBeLessThan(bubble.x);
    expect(run.y).toBeGreaterThan(bubble.y + bubble.height);
  });

  test("folds the work between two replies into one line that opens into the steps", async ({ page }) => {
    await openIntegrated(page);
    await agent(
      page,
      `f.send("${H}", crypto.randomUUID(), "change it");
       f.startTurn("${H}");
       f.tool("${H}", "Edit", { file_path: "${PROJECT}/src/a.ts" }, "ok", { kind: "edit", changes: [{ path: "${PROJECT}/src/a.ts", kind: "update", to: null, content: null, truncated: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old line", "+new line"] }] }] });
       f.tool("${H}", "Bash", { command: "npm test" }, "all 12 tests pass", { kind: "command" });
       f.emit("${H}", { type: "text", block: "x", parent: null, text: "Changed and tested.", done: true });
       f.endTurn("${H}");`,
    );
    const line = page.getByTestId("work-line");
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(/Worked for \d+s, changed 1 file, ran 1 command/);
    await expect(page.getByTestId("step")).toHaveCount(0);
    await line.click();
    await expect(page.getByTestId("step")).toHaveCount(2);
    await page.getByTestId("step-row").filter({ hasText: "Ran" }).click();
    await expect(page.getByTestId("step-output")).toHaveText("all 12 tests pass");
    await page.getByTestId("step-row").filter({ hasText: "Edited" }).click();
    const diff = page.getByTestId("diff");
    await expect(diff).toContainText("old line");
    await expect(diff).toContainText("new line");
    // The steps sit between the line and what the agent said after them.
    const steps = (await page.getByTestId("work-steps").boundingBox())!;
    const after = (await page.getByTestId("agent-text").last().boundingBox())!;
    expect(steps.y + steps.height).toBeLessThanOrEqual(after.y);
  });

  test("grows streaming text in place and says what the agent does meanwhile", async ({ page }) => {
    await openIntegrated(page);
    await agent(page, `f.send("${H}", crypto.randomUUID(), "go"); f.startTurn("${H}"); f.startTool("${H}", "Bash", { command: "cargo build" }, { kind: "command" });`);
    await expect(page.getByTestId("now")).toHaveText("Running cargo build");
    await expect(page.getByTestId("work-line")).toContainText("Working for");
    await agent(page, `f.finishTool("${H}", "call-1", "ok"); f.emit("${H}", { type: "text", block: "s", parent: null, text: "First words", done: false });`);
    const text = page.getByTestId("agent-text");
    await expect(text).toHaveText("First words");
    await expect(page.getByTestId("now")).toHaveCount(0);
    const before = (await page.getByTestId("user-message").boundingBox())!;
    const top = (await text.boundingBox())!.y;
    await agent(page, `f.emit("${H}", { type: "text", block: "s", parent: null, text: " and then more of them, as they come.", done: false });`);
    await expect(text).toHaveText("First words and then more of them, as they come.");
    expect((await page.getByTestId("user-message").boundingBox())!.y).toBe(before.y);
    expect((await text.boundingBox())!.y).toBe(top);
  });

  test("draws Markdown, code and a table as the agent writes them", async ({ page }) => {
    await openIntegrated(page);
    await agent(
      page,
      `f.turn("${H}", "## The plan\\n\\nRun \`npm test\`, then:\\n\\n\`\`\`ts\\nconst x = 1;\\n\`\`\`\\n\\n| File | Lines |\\n| --- | --- |\\n| a.ts | 12 |\\n");`,
    );
    const md = page.getByTestId("markdown");
    await expect(md.locator("h2")).toHaveText("The plan");
    await expect(md.locator("p code")).toHaveText("npm test");
    await expect(md.locator("pre code")).toHaveText("const x = 1;");
    await expect(md.locator("table td").first()).toHaveText("a.ts");
  });

  test("shows the sessions the agent started, each with a way to open it", async ({ page }) => {
    // Terminal sessions by default here, and one integrated session started
    // the other way from the agent pane.
    await installFakeCore(page, { open: [PROJECT] });
    await page.goto("/");
    await expect(page.getByTestId("start-other")).toHaveText("New integrated session");
    await page.getByTestId("start-other").click();
    await expect(page.getByTestId("conversation")).toBeVisible();
    // Another session, in a terminal, which the fake names session-1.
    await page.getByTestId("new-session").click();
    await expect(page.locator(`${AGENT} .xterm`)).toBeVisible();
    await page.getByTestId("session-row").first().click();
    await expect(page.getByTestId("conversation")).toBeVisible();
    await agent(
      page,
      `f.startTurn("${H}");
       f.tool("${H}", "mcp__agent-workbench__start", { prompt: "x" }, "Started session session-1 in demo. It has the prompt. Call wait to hear how it goes.", { kind: "mcp" });
       f.endTurn("${H}");`,
    );
    const started = page.getByTestId("started-session");
    await expect(started).toHaveCount(1);
    await expect(started).toContainText("session 2");
    await expect(started).toContainText("Claude Code");
    await started.getByTestId("open-started").click();
    await expect(page.getByTestId("conversation")).toBeHidden();
    await expect(page.locator(`${AGENT} .xterm`)).toBeVisible();
  });

  test("says why a session ended and resumes it where the thread left off", async ({ page }) => {
    await openIntegrated(page);
    await agent(page, `f.send("${H}", crypto.randomUUID(), "go"); f.turn("${H}", "first answer"); f.end("${H}", false);`);
    const ended = page.getByTestId("session-ended");
    await expect(ended).toContainText("The session stopped: claude ended with code 1.");
    await page.getByTestId("resume-session").click();
    await expect(ended).toHaveCount(0);
    await expect(page.getByTestId("agent-text")).toHaveText("first answer");
    const starts = (await calls(page)).filter((call) => call.method === "start");
    expect(starts.at(-1)).toMatchObject({ options: { session: "integrated-session-1" } });
  });

  test("asks before a folder that is not trusted, and starts once trusted", async ({ page }) => {
    await openIntegrated(page, { untrusted: true });
    const gate = page.getByTestId("trust-gate");
    await expect(gate).toContainText("Trust this folder?");
    await expect(gate).toContainText(PROJECT);
    await page.getByTestId("trust-folder").click();
    await expect(gate).toHaveCount(0);
    await expect(page.getByTestId("thread")).toBeVisible();
    expect((await calls(page)).map((call) => call.method)).toEqual(["trust", "start"]);
  });

  test("says when the account is not signed in, and how to sign in", async ({ page }) => {
    await openIntegrated(page);
    await agent(page, `f.emit("${H}", { type: "error", kind: "notLoggedIn", message: "Not logged in" }); f.end("${H}", false);`);
    const gate = page.getByTestId("login-gate");
    await expect(gate).toContainText("Claude Code is not signed in");
    await expect(gate.locator("code")).toHaveText("claude");
  });

  test("says on its row and in the header what the core says it is doing", async ({ page }) => {
    await openIntegrated(page);
    const meta = page.locator(`${AGENT} header .meta`);
    await agent(page, `f.send("${H}", crypto.randomUUID(), "go"); f.startTurn("${H}");`);
    await expect(meta).toHaveText("working");
    await agent(page, `f.ask("${H}", "Bash", { command: "ls" });`);
    await expect(meta).toHaveText("needs permission");
    await expect(page.locator("[data-testid='session-row'] .dot.permission")).toBeVisible();
  });

  test("comes back after a restart, and resumes its conversation by its id", async ({ page }) => {
    await openIntegrated(page);
    await expect(page.getByTestId("conversation")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("conversation")).toBeVisible();
    // The core of the page before is gone with it: the row resumes.
    await expect
      .poll(async () => (await calls(page)).filter((call) => call.method === "start").at(-1))
      .toMatchObject({ options: { session: "integrated-session-1" } });
  });
});
