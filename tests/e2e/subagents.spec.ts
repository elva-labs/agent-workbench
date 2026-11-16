import { expect, test, type Locator, type Page } from "@playwright/test";
import { BUILD_AND_REVIEW, DIRECT, PROJECT, installFakeCore } from "./fake";

// An integrated Claude Code session's subagents hang under its row on the
// rail while they run. The fake's first integrated session is int-1; one it
// starts through the start tool is int-2.

const SESSIONS = "section[data-pane='sessions']";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

const shown = (page: Page): Locator => page.locator("[data-testid='conversation'].active");
const input = (page: Page) => shown(page).getByTestId("composer-input");
const rows = (page: Page) => page.locator(`${SESSIONS} [data-testid='subagent-row']`);
const row = (page: Page, about: string) => rows(page).filter({ hasText: about });

async function box(locator: Locator) {
  return (await locator.boundingBox())!;
}

/** Where something stands once it has stopped moving. */
async function settled(locator: Locator) {
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const y = (await box(locator)).y;
        const same = y === last;
        last = y;
        return same;
      },
      { intervals: [120] },
    )
    .toBe(true);
  return box(locator);
}

/** The line at the foot of the thread on screen saying it works with a
    subagent, which says the window has heard of it. */
const heard = (page: Page, about: string) => shown(page).getByTestId("now").filter({ hasText: about });

/** A session on screen that was sent a message and is at work on it. */
async function working(page: Page, platform = "Linux x86_64", keep = false) {
  await page.addInitScript((reported) => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => reported });
  }, platform);
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] }, keepIntegrated: keep });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(input(page)).toBeEnabled();
  await input(page).fill("Compare the two ways of reading");
  await input(page).press("Enter");
  await agent(page, `f.startTurn("int-1");`);
}

/** Starts a subagent in a session, with its task, and gives back its call. */
async function subagent(page: Page, about: string, options: { handle?: string; kind?: string; background?: boolean } = {}) {
  return (await startSubagent(page, about, options)).call;
}

/** Starts a subagent in a session and gives back its call and its task. */
function startSubagent(page: Page, about: string, options: { handle?: string; kind?: string; background?: boolean } = {}) {
  const { handle = "int-1", kind = "Explore", background = false } = options;
  return agent(
    page,
    `const call = f.startTool("${handle}", "Agent", { description: ${JSON.stringify(about)}, subagent_type: ${JSON.stringify(kind)}, prompt: "go" }, { kind: "agent" });
     const task = f.task("${handle}", call, { background: ${background} });
     return { call, task };`,
  ) as Promise<{ call: string; task: string }>;
}

/** Two frames on, once whatever a resize sets off has run. */
function frames(page: Page) {
  return page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

/** Whether the row of the step for a call stands inside the thread's
    view, in the conversation on screen. */
async function stepInView(page: Page, call: string) {
  const head = await shown(page).locator(`[data-call="${call}"] > [data-testid='step-head']`).boundingBox();
  const view = await shown(page).getByTestId("thread").boundingBox();
  if (head === null || view === null) return false;
  return head.y >= view.y - 1 && head.y + head.height <= view.y + view.height + 1;
}

/** Steps after a call in the same run, enough that the run's work, open,
    is taller than the view. */
function stepsAfter(page: Page, handle: string, count = 30) {
  return agent(
    page,
    `for (let at = 0; at < ${count}; at++) f.tool("${handle}", "Bash", { command: "ls part-" + at }, "a\\nb", { kind: "command" });`,
  );
}

/** The started session for the cache, under the first session. */
async function started(page: Page) {
  await page.evaluate(
    ({ project }) =>
      (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
        id: "c-start",
        tool: "start",
        arguments: { project, prompt: "Fix the flaky cache", name: "Fix the cache" },
        cwd: project,
        session: "integrated-session-1",
      }),
    { project: PROJECT },
  );
  await page.getByTestId("conduct-allow").click();
  await expect(page.locator(`${SESSIONS} [data-testid='started-session']`)).toHaveCount(1);
}

test.describe("subagents on the rail", () => {
  test("hang under their session while they run, and a done one goes with the turn", async ({ page }) => {
    await working(page);
    await subagent(page, "Read the per-project scan");
    const second = await startSubagent(page, "Read the per-directory scan", { kind: "general-purpose" });
    await expect(rows(page)).toHaveCount(2);
    await expect(row(page, "Read the per-project scan").getByTestId("subagent-note")).toHaveText("Explore");
    await expect(row(page, "Read the per-directory scan").getByTestId("subagent-note")).toHaveText("general");
    await expect(page.locator(`${SESSIONS} [data-testid='subagent-summary']`)).toHaveText("2 subagents running");

    // Under the session's row, each a step in from its dot.
    const session = await box(page.locator(`${SESSIONS} [data-testid='session-row']`).first());
    const dot = await box(page.locator(`${SESSIONS} [data-testid='session-row'] .dot`).first());
    const first = await box(row(page, "Read the per-project scan"));
    const firstDot = await box(row(page, "Read the per-project scan").locator(".dot"));
    expect(first.y).toBeGreaterThanOrEqual(session.y + session.height - 1);
    expect(firstDot.x).toBeGreaterThan(dot.x + dot.width);

    await page.mouse.move(900, 500);
    await agent(page, `f.finishTask("int-1", "${second.task}", "completed", "found"); f.finishTool("int-1", "${second.call}", "found");`);
    await expect(row(page, "Read the per-directory scan")).toHaveAttribute("data-state", "done");
    await expect(row(page, "Read the per-directory scan").getByTestId("subagent-note")).toHaveText("done");
    await expect(page.locator(`${SESSIONS} [data-testid='subagent-summary']`)).toHaveText("1 subagent running, 1 done");

    await agent(page, `f.endTurn("int-1");`);
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, "Read the per-project scan")).toHaveAttribute("data-state", "running");
  });

  test("open their session at the call that started them, open and marked, by click or Enter", async ({ page }) => {
    await working(page);
    const call = await subagent(page, "Find where the scan starts");
    await agent(page, `f.startTool("int-1", "Grep", { pattern: "loadHistories" }, { kind: "search", parent: "${call}" });`);
    const step = shown(page).locator(`[data-call="${call}"]`);
    await expect(step).toHaveCount(0);

    await row(page, "Find where the scan starts").click();
    await expect(step).toBeVisible();
    await expect(step).toHaveClass(/marked/);
    await expect(step.getByTestId("step-row")).toHaveAttribute("aria-expanded", "true");
    await expect(step.getByTestId("subagent")).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(step).not.toHaveClass(/marked/, { timeout: 4000 });

    // From the keyboard: the row is on the pane's walk, and Enter opens it.
    await step.getByTestId("step-row").click();
    await expect(step.getByTestId("step-row")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Control+1");
    await expect(page.getByTestId("sessions-nav")).toBeFocused();
    await expect(page.locator(`${SESSIONS} .session.cursor [data-testid='session-row']`)).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(`${SESSIONS} .sub.cursor`)).toHaveCount(1);
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(`${SESSIONS} .session.cursor [data-testid='session-row']`)).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(step).toHaveClass(/marked/);
    await expect(step.getByTestId("step-row")).toHaveAttribute("aria-expanded", "true");
  });

  test("never move the row under the pointer or the keyboard's place", async ({ page }) => {
    await working(page);
    await started(page);
    const kid = page.locator(`${SESSIONS} [data-testid='started-session']`);
    await kid.hover();
    const before = await box(kid);
    const scan = await startSubagent(page, "Read the scan");
    // Heard: the thread on screen draws its call, and the rail held.
    await expect(heard(page, "Read the scan")).toBeVisible();
    expect(await box(kid)).toEqual(before);
    await expect(rows(page)).toHaveCount(0);
    // Away from the pane, the row comes, and what is below makes room.
    await page.mouse.move(900, 500);
    await expect(rows(page)).toHaveCount(1);
    await expect.poll(async () => (await box(kid)).y).toBeGreaterThan(before.y);

    // The keyboard's place holds the same way: the row stays while it walks.
    await page.keyboard.press("Control+1");
    await expect(page.getByTestId("sessions-nav")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(`${SESSIONS} .kid.cursor`)).toHaveCount(1);
    const held = await settled(kid);
    await agent(page, `f.finishTask("int-1", "${scan.task}"); f.finishTool("int-1", "${scan.call}", "read"); f.endTurn("int-1"); f.emit("int-1", { type: "state", state: "idle" });`);
    // Heard: the thread no longer says it works with the subagent.
    await expect(heard(page, "Read the scan")).toHaveCount(0);
    expect(await box(kid)).toEqual(held);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveAttribute("data-state", "done");
  });

  test("hang one step further in under a started session, and its request docks in the starter", async ({ page }) => {
    await working(page);
    await started(page);
    await page.mouse.move(900, 500);
    const call = await subagent(page, "Run the cache tests", { handle: "int-2", kind: "general-purpose" });
    await agent(
      page,
      `f.startTurn("int-2");
       const r = f.startTool("int-2", "Bash", { command: "cargo test cache" }, { kind: "command", parent: "${call}" });
       f.emit("int-2", { type: "permissionAsked", request: "sub-1", call: r, parent: "${call}", tool: "Bash", input: { command: "cargo test cache" }, truncated: false, description: null, path: null, choices: [{ choice: "allow", remembers: null, message: false }, { choice: "deny", remembers: null, message: false }] });`,
    );
    const sub = row(page, "Run the cache tests");
    await expect(sub.getByTestId("subagent-note")).toHaveText("asking");
    const kidDot = await box(page.locator(`${SESSIONS} [data-testid='started-session'] .dot`));
    const subDot = await box(sub.locator(".dot"));
    expect(subDot.x).toBeGreaterThan(kidDot.x + kidDot.width);
    expect(subDot.y).toBeGreaterThan(kidDot.y);

    const dock = shown(page).getByTestId("permission-dock");
    await expect(dock).toContainText("The subagent for “Run the cache tests” in Fix the cache asks to run cargo test cache");
    await dock.getByTestId("dock-open").click();
    await expect(shown(page)).toHaveAttribute("data-session", /.+/);
    await expect(shown(page).locator(`[data-call="${call}"]`)).toHaveClass(/marked/);
  });

  test("folded to the narrow column, are dots and not rows, and nothing moves when it opens", async ({ page }) => {
    await working(page);
    await started(page);
    await page.mouse.move(900, 500);
    for (const about of ["One", "Two", "Three", "Four", "Five"]) await subagent(page, about);
    await expect(rows(page)).toHaveCount(5);
    const kid = page.locator(`${SESSIONS} [data-testid='started-session']`);
    const open = await settled(kid);
    expect(open.y).toBeGreaterThan((await box(rows(page).last())).y);
    await page.keyboard.press("Control+b");
    await expect.poll(async () => (await box(page.locator(SESSIONS))).width).toBeCloseTo(50, 0);
    await expect(rows(page).first()).toBeHidden();
    const dots = page.locator(`${SESSIONS} [data-testid='subagent-dots'] .dot`);
    await expect(dots).toHaveCount(5);
    const column = await box(page.locator(SESSIONS));
    for (const each of await dots.all()) {
      const at = await box(each);
      expect(at.x + at.width).toBeLessThanOrEqual(column.x + column.width - 8);
    }
    expect((await box(kid)).y).toBe(open.y);
    await page.keyboard.press("Control+b");
    await expect(rows(page).first()).toBeVisible();
    expect((await box(kid)).y).toBe(open.y);
  });

  test("say what each was asked as the agent wrote it, cut, and ten stay readable", async ({ page }) => {
    await working(page);
    await page.mouse.move(900, 500);
    await subagent(page, `Fix it${String.fromCodePoint(0x202e)}etadpu${String.fromCodePoint(0x202c)} ${"and then on ".repeat(30)}`);
    const odd = rows(page).first();
    await expect(odd.getByTestId("unseen-character").first()).toHaveText("⟨U+202E⟩");
    const about = (await odd.getByTestId("subagent-about").textContent())!;
    expect(about.endsWith("…")).toBe(true);
    expect(Array.from(about).length).toBeLessThan(110);

    for (let at = 1; at < 10; at++) await subagent(page, `Look at part ${at}`);
    await expect(rows(page)).toHaveCount(10);
    await settled(rows(page).last());
    const pane = await box(page.locator(SESSIONS));
    let last = Number.NEGATIVE_INFINITY;
    for (const each of await rows(page).all()) {
      const at = await box(each);
      expect(at.height).toBeGreaterThanOrEqual(14);
      expect(at.y).toBeGreaterThanOrEqual(last - 0.5);
      expect(at.x + at.width).toBeLessThanOrEqual(pane.x + pane.width);
      last = at.y + at.height;
      const text = await box(each.getByTestId("subagent-about"));
      const when = await box(each.locator(".when"));
      expect(text.x + text.width).toBeLessThanOrEqual(when.x);
    }
  });

  test("tell a screen reader of them as they start, a session's together in one line, politely", async ({ page }) => {
    await working(page);
    const said = page.getByTestId("subagent-said");
    await expect(said).toHaveAttribute("aria-live", "polite");
    await expect(said).toHaveText("");
    await subagent(page, "Read the scan");
    await expect(said).toHaveText("Compare the two ways of reading started a subagent for Read the scan.");
    await agent(page, `f.emit("int-1", { type: "taskProgress", task: "task-1", call: null, tool: "Grep", description: null });`);
    // Several at once are one line with a count, however they come.
    for (const about of ["Part one", "Part two", "Part three"]) await subagent(page, about);
    await expect(said).toHaveText("Compare the two ways of reading started 3 subagents.");
    // A subagent's row is no stop for Tab: the pane is one.
    await expect(rows(page).first()).toHaveAttribute("tabindex", "-1");
  });

  test("open at the call in the running turn and stay there, by the row and by the dock's Open", async ({ page }) => {
    await working(page);
    const call = await subagent(page, "Find where the scan starts");
    await stepsAfter(page, "int-1");
    await row(page, "Find where the scan starts").click();
    await expect.poll(() => stepInView(page, call)).toBe(true);
    await expect(shown(page).locator(`[data-call="${call}"]`)).toHaveClass(/marked/);
    await frames(page);
    expect(await stepInView(page, call)).toBe(true);
    // More comes, in the subagent and in the main thread: it stays put.
    await agent(
      page,
      `f.startTool("int-1", "Grep", { pattern: "scan" }, { kind: "search", parent: "${call}" });
       f.tool("int-1", "Bash", { command: "ls more" }, "c", { kind: "command" });`,
    );
    await frames(page);
    expect(await stepInView(page, call)).toBe(true);

    // The dock's Open on a request from a started session's subagent.
    await started(page);
    const theirs = await subagent(page, "Run the cache tests", { handle: "int-2" });
    await stepsAfter(page, "int-2");
    await agent(
      page,
      `f.startTurn("int-2");
       const r = f.startTool("int-2", "Bash", { command: "cargo test" }, { kind: "command", parent: "${theirs}" });
       f.emit("int-2", { type: "permissionAsked", request: "sub-open", call: r, parent: "${theirs}", tool: "Bash", input: { command: "cargo test" }, truncated: false, description: null, path: null, choices: [{ choice: "allow", remembers: null, message: false }] });`,
    );
    await shown(page).getByTestId("permission-dock").getByTestId("dock-open").click();
    await expect.poll(() => stepInView(page, theirs)).toBe(true);
    await expect(shown(page).locator(`[data-call="${theirs}"] [data-testid='step-status']`).first()).toHaveText("asking");
    await frames(page);
    expect(await stepInView(page, theirs)).toBe(true);
    await agent(page, `f.tool("int-2", "Bash", { command: "ls after" }, "d", { kind: "command" });`);
    await frames(page);
    expect(await stepInView(page, theirs)).toBe(true);
  });

  test("after a reload, keep those still at work and say nothing of them as new", async ({ page }) => {
    await working(page, "Linux x86_64", true);
    const fore = await subagent(page, "Foreground one");
    const back = await subagent(page, "Background one", { background: true });
    await agent(page, `f.finishTool("int-1", "${back}", "launched");`);
    // What the agent wrote down of them, as its transcript holds it.
    const then = Date.now() - 1000;
    const started = (call: string, about: string) => [
      { at: then, event: { type: "toolStarted", call, parent: null, name: "Agent", kind: "agent" } },
      { at: then, event: { type: "toolInput", call, parent: null, delta: null, input: { description: about, subagent_type: "Explore" }, truncated: false } },
    ];
    const items = [
      { at: then, event: { type: "turnStarted", messages: [] } },
      ...started(fore, "Foreground one"),
      ...started(back, "Background one"),
      { at: then, event: { type: "toolFinished", call: back, parent: null, output: "launched", error: false, truncated: false, changes: [] } },
    ];
    await agent(page, `f.transcript("integrated-session-1", ${JSON.stringify(items)});`);
    await expect(rows(page)).toHaveCount(2);

    await page.reload();
    await expect(rows(page)).toHaveCount(2);
    await expect(row(page, "Background one")).toHaveAttribute("data-state", "running");
    await expect(row(page, "Foreground one")).toHaveAttribute("data-state", "running");
    // A new one is said alone: those from before the reload are not news.
    await page.mouse.move(900, 500);
    await subagent(page, "Fresh one");
    await expect(page.getByTestId("subagent-said")).toHaveText(/started a subagent for Fresh one\.$/);
  });

  test("folded, say done and failed by shape as well as colour", async ({ page }) => {
    await working(page);
    await page.mouse.move(900, 500);
    const done = await startSubagent(page, "Finished");
    const failed = await startSubagent(page, "Broke");
    await subagent(page, "Still going");
    await agent(
      page,
      `f.finishTask("int-1", "${done.task}", "completed"); f.finishTool("int-1", "${done.call}", "ok");
       f.finishTask("int-1", "${failed.task}", "failed"); f.finishTool("int-1", "${failed.call}", "no", { error: true });`,
    );
    await page.keyboard.press("Control+b");
    const dots = page.locator(`${SESSIONS} [data-testid='subagent-dots'] .dot`);
    await expect(dots).toHaveCount(3);
    const fill = (at: number) => dots.nth(at).evaluate((dot) => getComputedStyle(dot).backgroundColor);
    const cross = (at: number) => dots.nth(at).evaluate((dot) => getComputedStyle(dot, "::before").content);
    expect(await fill(0)).toBe("rgba(0, 0, 0, 0)");
    expect(await cross(1)).toBe('""');
    expect(await fill(2)).not.toBe("rgba(0, 0, 0, 0)");
  });

  // Under Direct the orchestrator hands each piece to a worker, which keeps
  // its own subagents: they hang a step in from the worker's row, which
  // says its step, and nothing on either row is cut to make room.
  test("hang under a worker of a Direct run, a step in from the worker", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" });
    });
    await installFakeCore(page, {
      open: [PROJECT],
      settings: { integrated: ["claude-code"], workflows: { list: [BUILD_AND_REVIEW, DIRECT], default: "Direct", overrides: {} } },
    });
    await page.goto("/");
    await page.getByTestId("start-agent").click();
    await expect(input(page)).toBeEnabled();
    await input(page).fill("Fix the flaky cache test");
    await input(page).press("Enter");
    await agent(page, `f.startTurn("int-1");`);
    await page.evaluate(
      ({ project }) =>
        (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
          id: "c-start",
          tool: "start",
          arguments: { project, prompt: "Fix the flaky cache test", name: "Fix the cache", step: "Work" },
          cwd: project,
          session: "integrated-session-1",
        }),
      { project: PROJECT },
    );
    await page.getByTestId("conduct-allow").click();
    const worker = page.locator(`${SESSIONS} [data-testid='started-session']`);
    await expect(worker).toHaveCount(1);
    await page.mouse.move(900, 500);
    await agent(page, `f.startTurn("int-2");`);
    await subagent(page, "Find where the cache is read", { handle: "int-2", kind: "Explore" });

    const sub = row(page, "Find where the cache is read");
    await expect(sub).toBeVisible();
    await expect(worker.getByTestId("started-role")).toHaveText("Work");
    const starter = page.locator(`${SESSIONS} [data-testid='session-row']`);
    const [starterDot, workerDot, subDot] = await Promise.all(
      [starter.locator(".dot").first(), worker.locator(".dot"), sub.locator(".dot")].map((dot) => settled(dot)),
    );
    expect(workerDot.x).toBeGreaterThan(starterDot.x + starterDot.width);
    expect(subDot.x).toBeGreaterThan(workerDot.x + workerDot.width);
    expect(workerDot.y).toBeGreaterThan(starterDot.y);
    expect(subDot.y).toBeGreaterThan(workerDot.y);
    // Each row inside the pane, its step and the subagent's line whole.
    const pane = await box(page.locator(SESSIONS));
    for (const it of [worker, sub]) {
      const at = await box(it);
      expect(at.x + at.width).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
    }
    expect(await worker.getByTestId("started-role").evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5)).toBe(true);
  });
});
