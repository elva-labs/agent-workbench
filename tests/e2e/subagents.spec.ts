import { expect, test, type Locator, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

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
async function working(page: Page, platform = "Linux x86_64") {
  await page.addInitScript((reported) => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => reported });
  }, platform);
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
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

  test("tell a screen reader of each as it starts, once, politely", async ({ page }) => {
    await working(page);
    const said = page.getByTestId("subagent-said");
    await expect(said).toHaveAttribute("aria-live", "polite");
    await expect(said).toHaveText("");
    await subagent(page, "Read the scan");
    await expect(said).toHaveText("Compare the two ways of reading started a subagent for Read the scan.");
    await agent(page, `f.emit("int-1", { type: "taskProgress", task: "task-1", call: null, tool: "Grep", description: null });`);
    await subagent(page, "Read the index");
    await expect(said).toHaveText("Compare the two ways of reading started a subagent for Read the index.");
    // A subagent's row is no stop for Tab: the pane is one.
    await expect(rows(page).first()).toHaveAttribute("tabindex", "-1");
  });
});
