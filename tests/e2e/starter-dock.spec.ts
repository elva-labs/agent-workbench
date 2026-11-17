import { expect, test, type Locator, type Page } from "@playwright/test";
import { PROJECT, WITH_WORKFLOW, installFakeCore } from "./fake";

// A session that started others answers their requests from its own dock:
// the request names the session that asks, every choice acts on that
// session, and Open goes to it. The fake's first integrated session is the
// starter, int-1, whose tools name it integrated-session-1; the session it
// starts is int-2.

const STARTER = "int-1";
const STARTED = "int-2";

/** Runs a script against the scripted sessions, as their agents would act. */
function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

/** The calls the window made on the scripted sessions. */
function calls(page: Page): Promise<{ method: string; [field: string]: unknown }[]> {
  return page.evaluate(
    () => (window as unknown as { __integrated: { calls: { method: string }[] } }).__integrated.calls,
  );
}

interface Answer {
  id: string;
  content: string | null;
  error: string | null;
}

/** A call on one of the conductor's tools, as the core delivers one. */
function conduct(page: Page, request: { id: string; tool: string; arguments?: Record<string, unknown>; session: string }) {
  return page.evaluate(
    ({ project, request }) =>
      (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
        id: request.id,
        tool: request.tool,
        arguments: request.arguments ?? {},
        cwd: project,
        session: request.session,
      }),
    { project: PROJECT, request },
  );
}

async function answerTo(page: Page, id: string): Promise<Answer | null> {
  const answers = await page.evaluate(
    () => (window as unknown as { __conductAnswers?: Answer[] }).__conductAnswers ?? [],
  );
  return answers.find((answer) => answer.id === id) ?? null;
}

/** The conversation on screen. */
const shown = (page: Page): Locator => page.locator("[data-testid='conversation'].active");
const input = (page: Page) => shown(page).getByTestId("composer-input");

/** The starter, on screen, with a session it started for the cache. */
async function starterWithStarted(page: Page, settings: Record<string, unknown> = {}, args: Record<string, unknown> = {}) {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"], ...settings } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(input(page)).toBeEnabled();
  await conduct(page, {
    id: "c-start",
    tool: "start",
    arguments: { project: PROJECT, prompt: "Fix the flaky cache test", name: "Fix the cache", ...args },
    session: "integrated-session-1",
  });
  await expect.poll(() => answerTo(page, "c-start")).not.toBeNull();
  expect((await answerTo(page, "c-start"))!.error).toBeNull();
  return (await shown(page).getAttribute("data-session"))!;
}

/** Puts the session with this row key on screen from the sessions pane. */
function goToRow(page: Page, key: string) {
  return page.locator(`[data-row="session:${key}"] > [data-testid='session-row']`).click();
}

/** Puts the started session named so on screen from its row under its
    starter. */
function goToNamed(page: Page, name: string) {
  return page.locator("section[data-pane='sessions'] [data-testid='started-session']", { hasText: name }).first().click();
}

/** The started session asks to run a command. */
function asks(page: Page, line: string, handle = STARTED) {
  return agent(
    page,
    `f.startTurn("${handle}");
     const c = f.startTool("${handle}", "Bash", { command: ${JSON.stringify(line)} }, { kind: "command" });
     return f.ask("${handle}", "Bash", { command: ${JSON.stringify(line)} }, { call: c, session: "Bash(cargo test:*) for the rest of this session" });`,
  );
}

test.describe("a started session's request in the starter's dock", () => {
  test("names the session, says each choice acts on it, and is answered in it", async ({ page }) => {
    await starterWithStarted(page);
    const request = await asks(page, "cargo test --workspace");
    const dock = shown(page).getByTestId("permission-dock");
    await expect(dock).toContainText("Fix the cache asks to run cargo test --workspace");
    await expect(dock.getByTestId("dock-session")).toHaveText("Fix the cache");
    await expect(dock.getByTestId("dock-step")).toHaveCount(0);
    await expect(dock.getByTestId("dock-open")).toHaveText("Open");
    await expect(dock.locator("[data-choice]")).toHaveText([
      "1Allow once",
      "2Allow for this session",
      "3Deny",
      "4Deny and stop",
    ]);
    const means = shown(page).getByTestId("choice-means");
    await expect(means).toHaveText("Allows this call in Fix the cache and remembers nothing.");
    await dock.getByTestId("choice-allowSession").hover();
    await expect(means).toHaveText(
      "Allows this call in Fix the cache and remembers Bash(cargo test:*) for the rest of that session.",
    );
    await dock.getByTestId("choice-cancel").hover();
    await expect(means).toHaveText("Refuses this call and stops Fix the cache's turn.");
    // Over the composer, under the thread, and the composer says Up reaches it.
    const thread = (await shown(page).getByTestId("thread").boundingBox())!;
    const box = (await dock.boundingBox())!;
    const composer = (await input(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(thread.y + thread.height - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
    await expect(input(page)).toHaveAttribute("placeholder", "↑ to answer, or write a message");

    await dock.getByTestId("choice-allowSession").click();
    await expect(dock).toHaveCount(0);
    expect((await calls(page)).filter((call) => call.method === "answer")).toEqual([
      { method: "answer", id: STARTED, request, choice: "allowSession", message: null },
    ]);
    // Nothing went to the starter.
    expect((await calls(page)).filter((call) => call.id === STARTER && call.method !== "start")).toEqual([]);
  });

  test("never takes the keyboard from a message being written, and is reached by Up", async ({ page }) => {
    await starterWithStarted(page);
    await input(page).click();
    await page.keyboard.type("half a thought");
    await asks(page, "cargo test");
    await expect(shown(page).getByTestId("permission-dock")).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveValue("half a thought");
    // A digit typed goes into the draft, never to the dock.
    await page.keyboard.type(" 1");
    await expect(input(page)).toHaveValue("half a thought 1");
    expect((await calls(page)).filter((call) => call.method === "answer")).toEqual([]);
    // Up goes to the dock only from an empty composer.
    await page.keyboard.press("ArrowUp");
    await expect(input(page)).toBeFocused();
    await input(page).fill("");
    await page.keyboard.press("ArrowUp");
    await expect(shown(page).getByTestId("choice-allow")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(shown(page).getByTestId("permission-dock")).toHaveCount(0);
    await expect(input(page)).toBeFocused();
    expect((await calls(page)).find((call) => call.method === "answer")).toMatchObject({ id: STARTED, choice: "allow" });
  });

  test("names a subagent of the started session by both", async ({ page }) => {
    await starterWithStarted(page);
    await agent(
      page,
      `f.startTurn("${STARTED}");
       const t = f.startTool("${STARTED}", "Task", { description: "Check every link", prompt: "look" }, { kind: "agent" });
       const r = f.startTool("${STARTED}", "Bash", { command: "lychee docs/" }, { kind: "command", parent: t });
       f.emit("${STARTED}", { type: "permissionAsked", request: "sub-1", call: r, parent: t, tool: "Bash", input: { command: "lychee docs/" }, truncated: false, description: null, path: null, choices: [{ choice: "allow", remembers: null, message: false }, { choice: "deny", remembers: null, message: false }] });`,
    );
    const dock = shown(page).getByTestId("permission-dock");
    await expect(dock).toContainText("The subagent for “Check every link” in Fix the cache asks to run lychee docs/");
    await expect(dock).toHaveAttribute("aria-label", "The subagent for “Check every link” in Fix the cache is waiting for you");
  });

  test("takes its own requests first, keeps the one shown while the user is at it, and goes there with Open", async ({ page }) => {
    const starter = await starterWithStarted(page);
    await asks(page, "cargo test");
    const dock = shown(page).getByTestId("permission-dock");
    await expect(dock.getByTestId("dock-session")).toHaveText("Fix the cache");
    // The starter's own agent asks while the pointer is elsewhere: its own
    // goes first, and the started session's waits behind it.
    await page.mouse.move(5, 5);
    const edit = `f.startTurn("${STARTER}"); f.ask("${STARTER}", "Edit", { file_path: "${PROJECT}/src/lib/sessions.svelte.ts" });`;
    await agent(page, edit);
    await expect(dock).toContainText("Claude asks to use Edit on src/lib/sessions.svelte.ts");
    await expect(dock.getByTestId("dock-more")).toHaveText("1 more waiting, from Fix the cache");
    await dock.getByTestId("choice-allow").click();
    await expect(dock.getByTestId("dock-session")).toHaveText("Fix the cache");
    const theirs = (await calls(page)).filter((call) => call.method === "answer").length;
    expect(theirs).toBe(1);

    // With the pointer on the dock, the one shown stays whatever arrives.
    await dock.hover();
    await agent(page, edit);
    await expect(dock.getByTestId("dock-more")).toHaveText("1 more waiting, from Claude");
    await expect(dock.getByTestId("dock-session")).toHaveText("Fix the cache");
    const request = await page.evaluate(
      () =>
        (window as unknown as { __integrated: { events: { id: string; type: string; request?: string }[] } }).__integrated.events.findLast(
          (event) => event.id === "int-2" && event.type === "permissionAsked",
        )!.request,
    );

    // Open goes to the started session, whose own dock holds the same request.
    await dock.getByTestId("dock-open").click();
    await expect(shown(page)).not.toHaveAttribute("data-session", starter);
    const there = shown(page).getByTestId("permission-dock");
    await expect(there).toContainText("Claude asks to run cargo test");
    await there.getByTestId("choice-allow").click();
    expect((await calls(page)).filter((call) => call.method === "answer").at(-1)).toEqual(
      { method: "answer", id: STARTED, request, choice: "allow", message: null },
    );

    // Back in the starter, the request answered there has gone, and its own is shown.
    await goToRow(page, starter);
    const own = shown(page).getByTestId("permission-dock");
    await expect(own).toContainText("Claude asks to use Edit on src/lib/sessions.svelte.ts");
    await expect(own.getByTestId("dock-session")).toHaveCount(0);
    await expect(own.getByTestId("dock-more")).toHaveCount(0);
  });

  test("keeps the request and its choices in sight whatever the session is called", async ({ page }) => {
    await starterWithStarted(page, {}, { name: `Fix the cache ${"and more ".repeat(470)}` });
    await asks(page, "rm -rf ~/.ssh");
    const dock = shown(page).getByTestId("permission-dock");
    await expect(dock).toContainText("asks to run rm -rf ~/.ssh");
    expect(Array.from((await dock.getByTestId("dock-session").textContent())!).length).toBeLessThanOrEqual(60);
    const pane = (await page.locator("section[data-pane='agent']").boundingBox())!;
    for (const testid of ["choice-allow", "choice-cancel", "choice-means"]) {
      const box = (await shown(page).getByTestId(testid).boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(pane.y);
      expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height);
    }
  });

  test("lets the order decide again once the pointer is off a dock that changed under it", async ({ page }) => {
    await starterWithStarted(page);
    const tall = await asks(page, Array.from({ length: 8 }, (_, at) => `echo line ${at + 1}`).join("\n"));
    await asks(page, "ls");
    const dock = shown(page).getByTestId("permission-dock");
    await expect(dock).toContainText("and 7 more lines");
    // The pointer rests near the top of the tall request, which then goes,
    // and the short one in its place is drawn well below the pointer.
    const top = (await dock.boundingBox())!;
    await page.mouse.move(top.x + 40, top.y + 6);
    await agent(page, `f.expire("${STARTED}", "${tall}");`);
    await expect(dock).toContainText("Fix the cache asks to run ls");
    const now = (await dock.boundingBox())!;
    expect(now.y).toBeGreaterThan(top.y + 6);
    await page.mouse.move(top.x + 40, top.y - 40);
    // The starter's own agent asks: off the dock, its own comes first.
    await agent(page, `f.startTurn("${STARTER}"); f.ask("${STARTER}", "Bash", { command: "pwd" });`);
    await expect(dock).toContainText("Claude asks to use Bash to run pwd");
    await expect(dock.getByTestId("dock-more")).toHaveText("1 more waiting, from Fix the cache");
  });

  test("keeps the keyboard in the dock until a late answer is told, then passes it on", async ({ page }) => {
    await starterWithStarted(page);
    await asks(page, "cargo test");
    await asks(page, "ls");
    await agent(page, "f.holdAnswers();");
    await input(page).click();
    await page.keyboard.press("ArrowUp");
    const dock = shown(page).getByTestId("permission-dock");
    await expect(dock.getByTestId("choice-allow")).toBeFocused();
    await page.keyboard.press("Enter");
    // The agent has not said yet: the keyboard stays on the request.
    await expect(dock.getByTestId("choice-allow")).toHaveAttribute("aria-disabled", "true");
    await expect(dock.getByTestId("choice-allow")).toBeFocused();
    await agent(page, "f.releaseAnswers();");
    await expect(dock).toContainText("Fix the cache asks to run ls");
    await expect(dock.getByTestId("choice-allow")).toBeFocused();
    // Once it settles in, its choices are whole at once, never faint while
    // they answer.
    const whole = await dock.getByTestId("choice-allow").evaluate(
      (choice) =>
        new Promise<string>((resolve) => {
          const told = () => {
            if (choice.hasAttribute("aria-disabled")) return false;
            resolve(getComputedStyle(choice).opacity);
            return true;
          };
          if (told()) return;
          const watch = new MutationObserver(() => {
            if (told()) watch.disconnect();
          });
          watch.observe(choice, { attributes: true, attributeFilter: ["aria-disabled"] });
        }),
    );
    expect(whole).toBe("1");
    // The last one is answered the same way, and the keyboard goes back to
    // the composer.
    await expect(dock.getByTestId("choice-allow")).not.toHaveAttribute("aria-disabled");
    await agent(page, "f.holdAnswers();");
    await page.keyboard.press("Enter");
    await expect(dock.getByTestId("choice-allow")).toHaveAttribute("aria-disabled", "true");
    await expect(dock.getByTestId("choice-allow")).toBeFocused();
    await agent(page, "f.releaseAnswers();");
    await expect(dock).toHaveCount(0);
    await expect(input(page)).toBeFocused();
    expect((await calls(page)).filter((call) => call.method === "answer")).toHaveLength(2);
  });

  test("gives the keyboard back to the composer on Escape, answering nothing", async ({ page }) => {
    await starterWithStarted(page);
    await asks(page, "cargo test");
    await input(page).click();
    await page.keyboard.press("ArrowUp");
    const dock = shown(page).getByTestId("permission-dock");
    await expect(dock.getByTestId("choice-allow")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(input(page)).toBeFocused();
    await expect(dock).toBeVisible();
    expect((await calls(page)).filter((call) => call.method === "answer")).toEqual([]);
  });

  test("names the step a session was started for", async ({ page }) => {
    await starterWithStarted(page, WITH_WORKFLOW, { step: "Work" });
    await asks(page, "cargo test --workspace");
    const dock = shown(page).getByTestId("permission-dock");
    await expect(dock.getByTestId("dock-step")).toHaveText("Work");
    await expect(dock.getByTestId("dock-session")).toHaveText("Fix the cache");
  });
});

test.describe("a started session that runs in a terminal", () => {
  test("shows its ask in the starter's dock with the way to it", async ({ page }) => {
    // Sessions run in a terminal here; the starter is started the other way.
    await installFakeCore(page, { open: [PROJECT] });
    await page.goto("/");
    await page.getByTestId("start-other").click();
    await expect(input(page)).toBeEnabled();
    const starter = (await shown(page).getAttribute("data-session"))!;
    await conduct(page, {
      id: "c-term",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Fix the broken links", name: "Fix the links" },
      session: "integrated-session-1",
    });
    // The starter's mode is known, so the session begins in it and the start
    // in the starter's own project goes ahead unasked.
    await expect.poll(() => answerTo(page, "c-term")).not.toBeNull();
    await expect(page.getByTestId("conduct-ask")).toHaveCount(0);
    const id = /Started session (\S+)/.exec((await answerTo(page, "c-term"))!.content ?? "")![1];
    const event = (kind: string) =>
      page.evaluate(
        ({ id, kind }) =>
          (window as unknown as { __sessionEvent: (event: { sessionId: string; kind: string }) => void }).__sessionEvent({
            sessionId: id,
            kind,
          }),
        { id, kind },
      );
    await event("permission");
    const dock = shown(page).getByTestId("terminal-dock");
    await expect(dock).toContainText("Fix the links asks for a permission in its terminal");
    await expect(dock.locator("[data-choice]")).toHaveText(["Open Fix the links"]);
    await expect(dock).toContainText("It runs in a terminal, so it is answered there.");
    // Nothing to answer here, so the composer reads as it always does.
    await expect(input(page)).not.toHaveAttribute("placeholder", "↑ to answer, or write a message");
    await input(page).click();
    await page.keyboard.press("ArrowUp");
    await expect(dock.getByTestId("dock-open-terminal")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("section[data-pane='agent'] .xterm")).toBeVisible();
    await expect(page.getByTestId("conversation")).toBeHidden();
    // It stops asking, and the starter's dock lets it go.
    await event("prompt");
    await goToRow(page, starter);
    await expect(shown(page)).toBeVisible();
    await expect(shown(page).getByTestId("terminal-dock")).toHaveCount(0);
  });
});

test.describe("a round of review past the limit, for an orchestrator in a conversation", () => {
  test("is asked in its dock while it is on screen, and over the window elsewhere", async ({ page }) => {
    const once = structuredClone(WITH_WORKFLOW);
    (once.workflows.list[0].steps[1] as { limit: number }).limit = 1;
    const starter = await starterWithStarted(page, once, { step: "Work" });
    const start = async (id: string, args: Record<string, unknown>) => {
      await conduct(page, {
        id,
        tool: "start",
        arguments: { project: PROJECT, prompt: "Go", ...args },
        session: "integrated-session-1",
      });
    };
    for (const id of ["c-2", "c-3"]) {
      await start(id, { step: "Review", work: "integrated-session-2" });
      await expect.poll(() => answerTo(page, id)).not.toBeNull();
      expect((await answerTo(page, id))!.error).toBeNull();
    }
    await start("c-4", { step: "Review", work: "integrated-session-2", prompt: "Look once more" });
    const dock = shown(page).getByTestId("round-dock");
    await expect(dock).toContainText("Claude asks for another round of Review");
    await expect(dock.getByTestId("conduct-round")).toHaveText(
      "Review has run twice on Fix the cache, as many times as the workflow allows. Allow another round?",
    );
    await expect(dock).toContainText("Look once more");
    await expect(page.getByTestId("conduct-ask")).toHaveCount(0);
    // The run's place in the header stays clear of it.
    const header = (await page.locator("section[data-pane='agent'] .ph, section[data-pane='agent'] header").first().boundingBox())!;
    expect((await dock.boundingBox())!.y).toBeGreaterThan(header.y + header.height);

    // Off the orchestrator, it is asked over the window.
    await goToNamed(page, "Fix the cache");
    await expect(page.getByTestId("conduct-ask")).toBeVisible();
    await expect(dock).toHaveCount(0);
    await goToRow(page, starter);
    await expect(page.getByTestId("conduct-ask")).toHaveCount(0);

    await shown(page).getByTestId("conduct-allow-round").click();
    await expect(shown(page).getByTestId("round-dock")).toHaveCount(0);
    await expect.poll(() => answerTo(page, "c-4")).not.toBeNull();
    expect((await answerTo(page, "c-4"))!.content).toContain('for step "Review" round 3');
  });
});
