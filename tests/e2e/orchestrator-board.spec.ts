import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * The changes pane, for a session that directs others.
 *
 * Any session that started others has them in a section at the foot of the
 * tree's column. The sessions are real ones: a start call is pushed at the
 * window through the fake core and allowed, as the conduct spec does, and
 * the section is read off the pane afterwards.
 */

/** A second open project. A session starting one there is asked once, and
    is then allowed to start more in it; a start in its own project is not
    asked about and is allowed nothing. */
const OTHER = "/home/ada/dev/other";

const AGENT = "section[data-pane='agent']";
const SESSIONS = "section[data-pane='sessions']";

interface Answer {
  id: string;
  content: string | null;
  error: string | null;
}

const answers = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __conductAnswers?: Answer[] }).__conductAnswers ??
      [],
  );

const answerTo = async (page: Page, id: string) =>
  (await answers(page)).find((answer) => answer.id === id) ?? null;

/** A hook event from one of them, as the core reports it. */
async function event(page: Page, session: string, kind: string) {
  await page.evaluate(
    ({ session, kind }) =>
      (
        window as unknown as {
          __sessionEvent?: (event: { sessionId: string; kind: string }) => void;
        }
      ).__sessionEvent?.({ sessionId: session, kind }),
    { session, kind },
  );
}

const header = (page: Page) => page.locator("section[data-pane='changes']").locator("header");

/** What the pty was written to, as the fake core kept it. */
const written = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __written?: [string, string][] }).__written ?? [],
  );

/** A worktree under a project, as the core answers with one. */
function tree(name: string, state: { merged: boolean; dirty: boolean }, project = PROJECT) {
  return {
    path: `${project}/.worktrees/${name}`,
    name,
    branch: name,
    merged: state.merged,
    dirty: state.dirty,
  };
}

/** A worktree where a start makes one, under a project. */
function madeTree(name: string, state: { merged: boolean; dirty: boolean }, project = PROJECT) {
  return { ...tree(name, state, project), path: `${project}/.claude/worktrees/${name}` };
}

async function putTrees(page: Page, trees: unknown[], project = PROJECT) {
  await page.evaluate(
    ({ project, trees }) => {
      (window as unknown as { __worktrees: unknown }).__worktrees = { [project]: trees };
    },
    { project, trees },
  );
}

/** The tree's cursor walked up from the column's last row to the row
    wanted, each step waited on. */
async function cursorUpTo(page: Page, want: string | RegExp) {
  const tree = page.getByTestId("file-tree");
  const on = async () => (await tree.getAttribute("aria-activedescendant")) ?? "";
  const reached = (at: string) => (typeof want === "string" ? at === want : want.test(at));
  await page.keyboard.press("End");
  await expect.poll(on).toBe("browser-fold");
  for (let step = 0; step < 40; step++) {
    const at = await on();
    if (reached(at)) return;
    await page.keyboard.press("ArrowUp");
    await expect.poll(on).not.toBe(at);
  }
  throw new Error(`the cursor never reached ${String(want)}`);
}

/** The worktrees a project still has, by name. */
const treeNames = (page: Page, project = PROJECT) =>
  page.evaluate(
    (project) =>
      ((window as unknown as { __worktrees: Record<string, { name: string }[]> }).__worktrees[project] ?? []).map(
        (tree) => tree.name,
      ),
    project,
  );

/**
 * The board for any session.
 *
 * A session that started others has them in a section at the foot of the
 * tree's column, beside Processes and Browser, with the controls to stop
 * them, send them a line, take back a project and clean up worktrees. The
 * calls come from the demo project's own session, as a session there
 * makes them.
 */

/** Plan, then Work, then a Review that sends the work back three times at
    most. */
const PLAN_WORK_REVIEW = {
  name: "Plan, work, review",
  orchestrator: { agent: "claude-code", model: "fable" },
  steps: [
    { kind: "work", name: "Plan", models: [{ agent: "claude-code", model: "opus" }], parallel: 1 },
    { kind: "work", name: "Work", models: [{ agent: "claude-code", model: "sonnet" }], parallel: 2 },
    {
      kind: "review",
      name: "Review",
      models: [{ agent: "claude-code", model: "opus" }],
      reviewerApproves: true,
      orchestratorAgrees: true,
      backTo: "Work",
      limit: 3,
    },
  ],
};

const section = (page: Page) => page.getByTestId("board-section");
const boardRows = (page: Page) => page.getByTestId("board-row");
const boardRow = (page: Page, name: string) => boardRows(page).filter({ hasText: name });

let calls = 0;

/** A call from the demo project's own session, answered before this
    returns, with its answer; the first start is allowed from then on. */
async function call(page: Page, tool: string, args: Record<string, unknown>) {
  const id = `d-${++calls}`;
  await page.evaluate(
    ({ project, id, tool, args }) =>
      (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
        id,
        tool,
        arguments: args,
        cwd: project,
        session: "session-1",
      }),
    { project: PROJECT, id, tool, args },
  );
  const allow = page.getByTestId("conduct-allow");
  await expect
    .poll(async () => {
      if (await allow.isVisible()) await allow.click();
      return (await answerTo(page, id)) !== null;
    })
    .toBe(true);
  const answer = (await answerTo(page, id))!;
  expect(answer.error).toBeNull();
  return answer.content ?? "";
}

/** Starts a session for the demo project's own and answers with its id. */
async function startOne(page: Page, args: Record<string, unknown>) {
  const content = await call(page, "start", { project: PROJECT, ...args });
  return /Started session (\S+)/.exec(content)![1];
}

/** Starts a session in the second project, which asks once and is then
    allowed from then on, and answers with its id. */
async function startElsewhere(page: Page, args: Record<string, unknown>) {
  return startOne(page, { project: OTHER, ...args });
}

/** The demo project's own session, the first row in the pane. */
async function toStarter(page: Page) {
  await page.locator(SESSIONS).getByTestId("session-row").first().click();
  await expect(section(page)).toBeVisible();
}

const layoutKept = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("chord.layout") ?? "{}") as Record<string, unknown>);

/** The demo project's own session on screen, following the workflow when
    asked to, with nothing started yet. */
async function begin(page: Page, workflow = false) {
  calls = 0;
  await installFakeCore(page, {
    open: [PROJECT, OTHER],
    settings: { workflows: { list: [PLAN_WORK_REVIEW], default: workflow ? PLAN_WORK_REVIEW.name : null, overrides: {} } },
  });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("file-tree")).toBeVisible();
}

test.describe("the board for any session", () => {

  test("stands at the tree's foot once the session has started one", async ({ page }) => {
    await begin(page);
    // Nothing started: the tree and its sections as ever, and no board.
    await expect(page.getByTestId("processes-section")).toBeVisible();
    await expect(section(page)).toHaveCount(0);

    await startElsewhere(page, { prompt: "Fix the flaky cache test", name: "Fix the cache" });
    await toStarter(page);

    // The changes stay where they are, the section under the tree, above
    // Processes and Browser, and the pane is headed Changes as ever.
    await expect(header(page)).toContainText("Changes");
    await expect(page.getByTestId("file-tree")).toBeVisible();
    await expect(page.getByTestId("board-fold")).toHaveText(/Sessions it started \(1\)/);
    const tree = (await page.getByTestId("file-tree").boundingBox())!;
    const board = (await section(page).boundingBox())!;
    const processes = (await page.getByTestId("processes-section").boundingBox())!;
    expect(board.y).toBeGreaterThanOrEqual(tree.y + tree.height - 1);
    expect(processes.y).toBeGreaterThanOrEqual(board.y + board.height - 1);

    // A row with its project, its state and how long since it changed.
    await expect(boardRows(page)).toHaveCount(1);
    await expect(boardRows(page).first().getByTestId("board-name")).toHaveText("Fix the cache");
    await expect(boardRows(page).first().getByTestId("board-detail")).toHaveText("other · running, now");
    await expect(page.getByTestId("board-allowed-project")).toHaveText("other");

    // The session it started has started none: no section on its screen.
    await boardRows(page).first().getByTestId("board-open").click();
    await expect(page.locator(AGENT)).toHaveClass(/focused/);
    await expect(page.getByTestId("file-tree")).toBeVisible();
    await expect(section(page)).toHaveCount(0);
  });

  test("says each session's step and round as the run's chip and the rail do", async ({ page }) => {
    await begin(page, true);
    await startOne(page, { prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "prompt");
    await event(page, "session-2", "stop");
    await startOne(page, { prompt: "Review it", step: "Review", work: "session-2", name: "Review the cache fix" });
    await event(page, "session-3", "prompt");
    await toStarter(page);

    await expect(boardRow(page, "Fix the cache").getByTestId("board-detail")).toHaveText("Work · idle, now");
    await expect(boardRow(page, "Review the cache fix").getByTestId("board-detail")).toHaveText(
      "Review, round 1 of 4 · working, now",
    );
    // The rail says the same round, short, and the chip names the step.
    await expect(
      page.getByTestId("started-session").filter({ hasText: "Review the cache fix" }).getByTestId("started-role"),
    ).toHaveText("Review, 1 of 4");
    await expect(page.getByTestId("run-words")).toHaveText("Review, round 1 of 4");

    // It asks: the row says so in the accent, its step and round kept.
    await event(page, "session-3", "permission");
    await expect(boardRow(page, "Review the cache fix").getByTestId("board-detail")).toHaveText(
      "Review, round 1 of 4 · asking, now",
    );
    await expect(boardRow(page, "Review the cache fix").getByTestId("board-dot")).toHaveAttribute(
      "data-state",
      "waiting",
    );
  });

  test("folds, keeps its fold, and opens by itself when one asks", async ({ page }) => {
    await begin(page);
    await startOne(page, { prompt: "Fix the flaky cache test", name: "Fix the cache" });
    await toStarter(page);
    await expect(boardRows(page)).toHaveCount(1);

    await page.getByTestId("board-fold").click();
    await expect(boardRows(page)).toHaveCount(0);
    await expect(page.getByTestId("board-fold")).toHaveAttribute("aria-expanded", "false");
    await expect.poll(async () => (await layoutKept(page)).startedOpen).toBe(false);

    // The session it started asks for a permission: the section opens so
    // the row that asks is in sight, and the fold chosen is still the one
    // kept.
    await event(page, "session-2", "prompt");
    await event(page, "session-2", "permission");
    await expect(page.getByTestId("board-fold")).toHaveAttribute("aria-expanded", "true");
    await expect(boardRows(page)).toHaveCount(1);
    expect((await layoutKept(page)).startedOpen).toBe(false);

    // Away and back while it still asks, the section is folded as chosen.
    await page.locator(SESSIONS).getByTestId("started-session").filter({ hasText: "Fix the cache" }).click();
    await expect(section(page)).toBeHidden();
    await toStarter(page);
    await expect(page.getByTestId("board-fold")).toHaveAttribute("aria-expanded", "false");
    await expect(boardRows(page)).toHaveCount(0);
    expect((await layoutKept(page)).startedOpen).toBe(false);
  });

  test("acts on the session each row shows", async ({ page }) => {
    await begin(page);
    await startOne(page, { prompt: "Fix the flaky cache test", name: "Fix the cache" });
    await startOne(page, { prompt: "Bump the client", name: "Bump the client" });
    await toStarter(page);
    await expect(boardRows(page)).toHaveCount(2);

    // Send on the second row opens the field under that row, and the line
    // reaches that session's terminal.
    await boardRow(page, "Bump the client").hover();
    await boardRow(page, "Bump the client").getByTestId("board-send").click();
    const field = page.getByTestId("board-send-field");
    await expect(field).toBeFocused();
    await expect(boardRow(page, "Bump the client").getByTestId("board-send-field")).toBeVisible();
    await field.fill("run the unit tests");
    await field.press("Enter");
    await expect(field).toHaveCount(0);
    await expect
      .poll(async () => (await written(page)).slice(-2))
      .toEqual([
        ["pty-3", "run the unit tests"],
        ["pty-3", "\r"],
      ]);
    // The keyboard is back on the tree, whose cursor walks the section.
    await expect(page.getByTestId("file-tree")).toBeFocused();

    // × on the first row stops that one, and the other stays.
    await boardRow(page, "Fix the cache").hover();
    await boardRow(page, "Fix the cache").getByTestId("board-stop").click();
    await expect(boardRows(page)).toHaveCount(1);
    await expect(boardRows(page).first()).toContainText("Bump the client");
  });

  test("sends an integrated session the line as your message", async ({ page }) => {
    calls = 0;
    await installFakeCore(page, { settings: { integrated: ["claude-code"] } });
    await page.goto("/");
    await page.getByTestId("start-agent").click();
    await expect(page.locator("[data-testid='conversation'].active").getByTestId("composer-input")).toBeEnabled();
    await page.evaluate(
      ({ project }) =>
        (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
          id: "i-1",
          tool: "start",
          arguments: { project, prompt: "Fix the flaky cache test", name: "Fix the cache" },
          cwd: project,
          session: "integrated-session-1",
        }),
      { project: PROJECT },
    );
    await expect.poll(() => answerTo(page, "i-1")).not.toBeNull();
    await page.locator(SESSIONS).getByTestId("session-row").first().click();
    await expect(boardRows(page)).toHaveCount(1);

    await boardRows(page).first().hover();
    await boardRows(page).first().getByTestId("board-send").click();
    await page.getByTestId("board-send-field").fill("run the unit tests");
    await page.getByTestId("board-send-field").press("Enter");
    await expect
      .poll(async () =>
        (
          await page.evaluate(
            () =>
              (window as unknown as { __integrated: { calls: { method: string; id: string; text?: string }[] } })
                .__integrated.calls,
          )
        )
          .filter((call) => call.method === "send" && call.id === "int-2")
          .at(-1)?.text,
      )
      .toBe("run the unit tests");
  });

  test("stops them all only once asked, and takes back what it was allowed", async ({ page }) => {
    await begin(page);
    await startElsewhere(page, { prompt: "Fix the flaky cache test", name: "Fix the cache" });
    await startElsewhere(page, { prompt: "Bump the client", name: "Bump the client" });
    await toStarter(page);

    await page.getByTestId("board-stop-all").click();
    const ask = page.getByTestId("board-stop-all-ask");
    await expect(ask).toContainText("Stop all 2 sessions it started?");
    await expect(page.getByTestId("board-stop-all-ask-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(boardRows(page)).toHaveCount(2);

    await page.getByTestId("board-stop-all").click();
    await page.getByTestId("board-stop-all-ask-confirm").click();
    await expect(boardRows(page)).toHaveCount(0);
    // The starter is still there and on screen. The section stays while it
    // may start more without being asked, so that can be taken back.
    await expect(page.getByTestId("board-empty")).toHaveText("None open now.");
    await expect(page.getByTestId("board-stop-all")).toHaveCount(0);
    await page.getByTestId("board-revoke").click();
    await expect(section(page)).toHaveCount(0);
  });

  test("cleans up only the worktrees its own starts made, once asked", async ({ page }) => {
    await begin(page);
    await startElsewhere(page, { prompt: "Fix the flaky cache test", name: "Fix the cache", worktree: true });
    await startElsewhere(page, { prompt: "Bump the client", name: "Bump the client", worktree: true });
    // Beside its two, a tree another session's start made and one the user
    // made, both merged and clean.
    await putTrees(
      page,
      [
        madeTree("fix-the-cache", { merged: true, dirty: false }, OTHER),
        madeTree("bump-the-client", { merged: true, dirty: true }, OTHER),
        madeTree("theirs", { merged: true, dirty: false }, OTHER),
        madeTree("users-own", { merged: true, dirty: false }, OTHER),
      ],
      OTHER,
    );
    await toStarter(page);
    // Its sessions still run in theirs: nothing is left behind yet.
    await expect(page.getByTestId("board-trees")).toHaveCount(0);

    await page.getByTestId("board-stop-all").click();
    await page.getByTestId("board-stop-all-ask-confirm").click();
    await expect(boardRows(page)).toHaveCount(0);
    await expect(page.getByTestId("board-trees")).toContainText("2 worktrees left behind");

    await page.getByTestId("board-clean").click();
    const ask = page.getByTestId("board-clean-ask");
    await expect(ask).toContainText("Clean up 1 worktree?");
    await expect(ask).toContainText("fix-the-cache goes, with its branch");
    await expect(ask).toContainText("1 stays");
    await expect(ask).not.toContainText("theirs");
    await expect(ask).not.toContainText("users-own");
    await page.getByTestId("board-clean-ask-confirm").click();

    await expect(page.getByTestId("board-trees")).toContainText("1 kept: uncommitted work");
    await expect(page.getByTestId("board-clean")).toBeDisabled();
    expect(await treeNames(page, OTHER)).toEqual(["bump-the-client", "theirs", "users-own"]);

    // With what it was allowed taken back, the section stays for the tree
    // its start left, and goes with it.
    await page.getByTestId("board-revoke").click();
    await expect(page.getByTestId("board-trees")).toBeVisible();
  });

  test("is walked by the tree's cursor, as its neighbours are", async ({ page }) => {
    await begin(page);
    await startElsewhere(page, { prompt: "Old fix", name: "Old fix", worktree: true });
    await startElsewhere(page, { prompt: "Fix the flaky cache test", name: "Fix the cache" });
    await putTrees(page, [madeTree("old-fix", { merged: true, dirty: false }, OTHER)], OTHER);
    await toStarter(page);
    await boardRow(page, "Old fix").hover();
    await boardRow(page, "Old fix").getByTestId("board-stop").click();
    await expect(page.getByTestId("board-trees")).toContainText("1 worktree left behind");
    const tree = page.getByTestId("file-tree");
    await tree.focus();
    // The rows are no tab stops: the tree's cursor runs on into them.
    expect(await page.getByTestId("board-open").getAttribute("tabindex")).toBe("-1");
    expect(await page.getByTestId("board-stop-all").getAttribute("tabindex")).toBe("-1");

    const cursorOn = () => tree.getAttribute("aria-activedescendant");
    await page.keyboard.press("End");
    // The last row of the column is the browser's header; up from it is
    // Processes, then the worktrees line, the project allowed and the row.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect.poll(cursorOn).toBe("started-trees");
    await page.keyboard.press("ArrowUp");
    await expect.poll(cursorOn).toMatch(/^started-allowed-/);
    await page.keyboard.press("ArrowUp");
    await expect.poll(cursorOn).toMatch(/^started-row-/);
    await expect(boardRows(page).first()).toHaveCSS("box-shadow", /inset/);

    // Enter on the worktrees line asks first, with Cancel taking the
    // keyboard; Escape gives it back to the tree.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("board-clean-ask-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(tree).toBeFocused();

    // Left folds the section from any row in it, leaving the cursor on its
    // header; Right opens it again.
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("board-fold")).toHaveAttribute("aria-expanded", "false");
    await expect.poll(cursorOn).toBe("started-fold");
    await page.keyboard.press("ArrowRight");
    await expect(boardRows(page)).toHaveCount(1);

    // Enter on a row goes to its session.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.locator(AGENT)).toHaveClass(/focused/);
    await expect(section(page)).toHaveCount(0);
  });

  test("keeps the cursor on its row while sessions stop and start around it", async ({ page }) => {
    await begin(page);
    await startElsewhere(page, { prompt: "First", name: "First" });
    const second = await startElsewhere(page, { prompt: "Second", name: "Second" });
    await startElsewhere(page, { prompt: "Third", name: "Third" });
    await toStarter(page);
    const tree = page.getByTestId("file-tree");
    await tree.focus();
    const cursorOn = () => tree.getAttribute("aria-activedescendant");
    const idOf = (name: string) => boardRow(page, name).getAttribute("id");
    const walkTo = (want: string | RegExp) => cursorUpTo(page, want);

    await walkTo((await idOf("Second"))!);
    // The one above it stops: the cursor stays on Second.
    await call(page, "stop", { session: "session-2" });
    await expect(boardRows(page)).toHaveCount(2);
    await expect.poll(cursorOn).toBe(await idOf("Second"));
    // A file changes in the tree above the section: still on Second, and
    // Enter goes to it.
    await page.evaluate(() =>
      (window as unknown as { __disk: { write: (file: string, text: string) => void } }).__disk.write(
        "aaa-new.txt",
        "new",
      ),
    );
    await expect(page.getByTestId("file-tree")).toContainText("aaa-new.txt");
    await expect.poll(cursorOn).toBe(await idOf("Second"));

    // On the project it is allowed in, a session starting adds a row above
    // it: the cursor stays on the allowed line.
    await walkTo(/^started-allowed-/);
    await startElsewhere(page, { prompt: "Fourth", name: "Fourth" });
    await expect(boardRows(page)).toHaveCount(3);
    await expect.poll(cursorOn).toMatch(/^started-allowed-/);

    // The row under it goes: the cursor takes the row that took its place.
    await walkTo((await idOf("Third"))!);
    await call(page, "stop", { session: "session-4" });
    await expect.poll(cursorOn).toBe(await idOf("Fourth"));
    expect(second).toBe("session-3");
    await page.keyboard.press("Enter");
    await expect(page.locator(AGENT)).toHaveClass(/focused/);
    await expect(page.locator(`${SESSIONS} .session.kid.on`)).toContainText("Fourth");
  });

  test("sends, stops one and stops them all from the keyboard, asking first", async ({ page }) => {
    await begin(page);
    await startOne(page, { prompt: "Fix the flaky cache test", name: "Fix the cache" });
    await startOne(page, { prompt: "Bump the client", name: "Bump the client" });
    await toStarter(page);
    const tree = page.getByTestId("file-tree");
    await tree.focus();
    const cursorOn = () => tree.getAttribute("aria-activedescendant");
    const bump = (await boardRow(page, "Bump the client").getAttribute("id"))!;
    await cursorUpTo(page, bump);
    // The buttons say their keys.
    await expect(boardRow(page, "Bump the client").getByTestId("board-send")).toHaveAttribute(
      "title",
      "Send this session a line (Shift+Enter)",
    );

    // Shift+Enter opens that row's field; Enter sends the line to it.
    await page.keyboard.press("Shift+Enter");
    const field = boardRow(page, "Bump the client").getByTestId("board-send-field");
    await expect(field).toBeFocused();
    await page.keyboard.type("run the unit tests");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await written(page)).slice(-2))
      .toEqual([
        ["pty-3", "run the unit tests"],
        ["pty-3", "\r"],
      ]);
    await expect(tree).toBeFocused();
    await expect.poll(cursorOn).toBe(bump);

    // Delete asks before stopping it, with Cancel holding the keyboard.
    await page.keyboard.press("Delete");
    const ask = boardRow(page, "Bump the client").getByTestId("board-stop-ask");
    await expect(ask).toContainText("Stop “Bump the client”?");
    await expect(page.getByTestId("board-stop-ask-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(tree).toBeFocused();
    await expect(boardRows(page)).toHaveCount(2);
    await page.keyboard.press("Delete");
    await page.getByTestId("board-stop-ask-confirm").click();
    await expect(boardRows(page)).toHaveCount(1);
    await expect(boardRows(page).first()).toContainText("Fix the cache");

    // Delete on the header asks to stop them all.
    await tree.focus();
    await cursorUpTo(page, "started-fold");
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("board-stop-all-ask")).toContainText("Stop the session it started?");
    await expect(page.getByTestId("board-stop-all-ask-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(boardRows(page)).toHaveCount(1);
  });

  test("is no Tab stop of its own when its rows scroll", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 560 });
    await begin(page);
    for (let i = 0; i < 6; i++) await startOne(page, { prompt: `Task ${i}`, name: `Task ${i}` });
    await toStarter(page);
    const list = section(page).locator("ul.rows");
    await expect.poll(() => list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await page.getByTestId("file-tree").focus();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Tab");
      await expect(list).not.toBeFocused();
    }
  });

  test("draws a name the agent chose as it is, cut to what a row holds", async ({ page }) => {
    await begin(page);
    await startOne(page, { prompt: "Fix it", name: `Fix \u202eehcac the ${"long ".repeat(40)}` });
    await toStarter(page);
    // The override is written out, never obeyed, and the name keeps to one
    // line, cut at the row's end.
    const name = boardRows(page).first().getByTestId("board-name");
    await expect(name).toContainText("Fix ⟨U+202E⟩ehcac the long");
    const fit = await name.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      cut: node.scrollWidth > node.clientWidth,
    }));
    expect(fit.height).toBeLessThan(20);
    expect(fit.cut).toBe(true);
    // A button names it in quotes.
    await expect(boardRows(page).first().getByTestId("board-stop")).toHaveAttribute(
      "aria-label",
      /^Stop “Fix ⟨U\+202E⟩ehcac the long .*”$/,
    );
  });
});
