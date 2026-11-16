import { expect, test, type Page } from "@playwright/test";
import { PROJECT, NO_WORKFLOW, installFakeCore } from "./fake";

/**
 * The changes pane, for a session that directs others.
 *
 * An orchestrator session runs in a directory the workbench keeps for it,
 * with no repository behind it and nothing to diff, so the pane shows the
 * sessions it started in place of the file tree. The sessions are real ones:
 * a start call is pushed at the window through the fake core and allowed, as
 * the conduct spec does, and the board is read off the pane afterwards.
 */

const ORCHESTRATOR = "/home/ada/.agent-workbench/orchestrator";
const AGENT = "section[data-pane='agent']";
const CHANGES = "section[data-pane='changes']";
const SESSIONS = "section[data-pane='sessions']";

interface Answer {
  id: string;
  content: string | null;
  error: string | null;
}

/** A call as the core delivers one, from the orchestrator's directory. */
async function push(
  page: Page,
  request: {
    id: string;
    tool: string;
    arguments?: Record<string, unknown>;
    session?: string | null;
  },
) {
  await page.evaluate(
    ({ cwd, request }) =>
      (
        window as unknown as { __conductRequest: (call: unknown) => void }
      ).__conductRequest({
        id: request.id,
        tool: request.tool,
        arguments: request.arguments ?? {},
        cwd,
        session: request.session ?? null,
      }),
    { cwd: ORCHESTRATOR, request },
  );
}

const answers = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __conductAnswers?: Answer[] }).__conductAnswers ??
      [],
  );

const answerTo = async (page: Page, id: string) =>
  (await answers(page)).find((answer) => answer.id === id) ?? null;

/**
 * One session started in the demo project, and the id the window answered
 * with. The first call is put to the user; a caller the user allowed is not
 * asked again, so only the first click on the dialog is needed.
 */
async function started(page: Page, id: string, prompt: string) {
  await push(page, {
    id,
    tool: "start",
    arguments: { project: PROJECT, prompt },
    session: "session-1",
  });
  const ask = page.getByTestId("conduct-ask");
  if (id === "c-1") {
    await expect(ask).toBeVisible();
    await page.getByTestId("conduct-allow").click();
  }
  await expect(ask).toHaveCount(0);
  await expect.poll(() => answerTo(page, id)).not.toBeNull();
  const answer = (await answerTo(page, id))!;
  expect(answer.error).toBeNull();
  return /Started session (\S+)/.exec(answer.content ?? "")![1];
}

/** A line one of them left for its row, through the notify tool. */
async function notify(page: Page, session: string, text: string) {
  await page.evaluate(
    ({ cwd, session, text }) =>
      (
        window as unknown as { __notifyRequest: (request: unknown) => void }
      ).__notifyRequest({ text, cwd, session }),
    { cwd: PROJECT, session, text },
  );
}

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

/**
 * The orchestrator's own session, which is the first row in the pane,
 * under the project it runs in. Starting a session leaves the window here,
 * so this is a click back from wherever a test has gone.
 */
async function toOrchestrator(page: Page) {
  await page.locator(SESSIONS).getByTestId("session-row").first().click();
  await expect(page.getByTestId("started-board")).toBeVisible();
}

const rows = (page: Page) => page.getByTestId("started-row");
const header = (page: Page) => page.locator(CHANGES).locator("header");

/** What the pty was written to, as the fake core kept it. */
const written = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __written?: [string, string][] }).__written ?? [],
  );

/** A worktree under a project, as the core answers with one. */
function tree(name: string, state: { merged: boolean; dirty: boolean }) {
  return {
    path: `${PROJECT}/.worktrees/${name}`,
    name,
    branch: name,
    merged: state.merged,
    dirty: state.dirty,
  };
}

/** Three worktrees under the demo project: one that can go, one with work
    in it, and one with commits the project does not have. */
async function putWorktrees(page: Page) {
  await page.evaluate(
    ({ project, trees }) => {
      (window as unknown as { __worktrees: unknown }).__worktrees = {
        [project]: trees,
      };
    },
    {
      project: PROJECT,
      trees: [
        tree("clean", { merged: true, dirty: false }),
        tree("working", { merged: true, dirty: true }),
        tree("ahead", { merged: false, dirty: false }),
      ],
    },
  );
}

test.describe("the orchestrator's board", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeCore(page, { open: [ORCHESTRATOR, PROJECT], settings: NO_WORKFLOW });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    // The orchestrator's own session, in the directory the workbench keeps
    // for it. It is the caller of every start below.
    await page.getByTestId("start-agent").click();
    await expect(page.getByTestId("started-board")).toBeVisible();
  });

  test("shows the sessions it started in place of the tree", async ({
    page,
  }) => {
    // Nothing started: one line says so, and the tree, the field and the
    // sections under it are all down.
    await expect(header(page)).toContainText("Orchestrator");
    await expect(header(page)).toContainText("0 sessions");
    await expect(page.getByTestId("started-empty")).toBeVisible();
    await expect(page.getByTestId("file-tree")).toHaveCount(0);
    await expect(page.getByTestId("search-field")).toHaveCount(0);
    await expect(page.getByTestId("sections")).toHaveCount(0);
    await expect(page.getByTestId("stop-all")).toHaveCount(0);

    const first = await started(page, "c-1", "Fix the flaky test");
    await started(page, "c-2", "Bump the client");
    await toOrchestrator(page);

    await expect(header(page)).toContainText("2 sessions");
    await expect(page.getByTestId("started-head")).toContainText(
      "Sessions it started (2)",
    );
    await expect(rows(page)).toHaveCount(2);
    // The name, and under it where the session runs and what it is doing.
    await expect(rows(page).first()).toContainText("session 1");
    await expect(rows(page).first()).toContainText("demo · waiting, just now");

    // One of them leaves a line while the orchestrator is on screen: that
    // is the orchestrator's to read, and the header counts nothing.
    await notify(page, first, "Which suite should I run?");
    await expect(header(page)).toContainText("2 sessions");
    await expect(header(page)).not.toContainText("asking");

    // One asks for a permission: that is the user's, and the header says
    // how many are.
    await event(page, first, "prompt");
    await event(page, first, "permission");
    await expect(header(page)).toContainText("2 sessions, 1 asking");
  });

  test("goes to a session it started, and the tree comes back with it", async ({
    page,
  }) => {
    await started(page, "c-1", "Fix the flaky test");
    await toOrchestrator(page);

    await rows(page).first().click();

    // The window is on that session: its terminal is the one on screen, the
    // pane is the changes pane again, and the keyboard is on the agent.
    // Every session stays mounted, in the order they were started.
    await expect(page.getByTestId("terminal").nth(1)).toBeVisible();
    await expect(page.getByTestId("started-board")).toHaveCount(0);
    await expect(header(page)).toContainText("Changes");
    await expect(page.getByTestId("file-tree")).toBeVisible();
    await expect(page.getByTestId("search-field")).toBeVisible();
    await expect(page.locator(AGENT)).toHaveClass(/focused/);

    // And back: the board is the orchestrator's again, untouched.
    await toOrchestrator(page);
    await expect(page.getByTestId("terminal").first()).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
  });

  test("walks the board's rows from the keyboard", async ({ page }) => {
    await started(page, "c-1", "Fix the flaky test");
    await started(page, "c-2", "Bump the client");
    await toOrchestrator(page);

    // One tab stop with a cursor inside it: down moves, Enter goes.
    await page.getByTestId("started-board").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("terminal").nth(2)).toBeVisible();
    await expect(page.locator(AGENT)).toHaveClass(/focused/);
  });

  test("stops everything it started", async ({ page }) => {
    await started(page, "c-1", "Fix the flaky test");
    await started(page, "c-2", "Bump the client");
    await toOrchestrator(page);
    await expect(rows(page)).toHaveCount(2);

    await page.getByTestId("stop-all").click();

    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId("stop-all")).toHaveCount(0);
    await expect(page.getByTestId("started-empty")).toBeVisible();
    // The orchestrator itself is still there, and still on screen.
    await expect(page.getByTestId("terminal")).toHaveCount(1);
    await expect(header(page)).toContainText("Orchestrator");
    await expect(header(page)).toContainText("0 sessions");
  });

  test("says which projects it may start in, and takes one back", async ({
    page,
  }) => {
    // Nothing has been allowed yet, so the line is not there.
    await expect(page.getByTestId("allowed-line")).toHaveCount(0);

    await started(page, "c-1", "Fix the flaky test");
    await toOrchestrator(page);

    await expect(page.getByTestId("allowed-line")).toContainText(
      "Allowed to start sessions in",
    );
    await expect(page.getByTestId("allowed-project")).toHaveText("demo");

    await page.getByTestId("revoke-project").click();
    await expect(page.getByTestId("allowed-line")).toHaveCount(0);

    // The next start from the same caller is put to the user again.
    await push(page, {
      id: "c-9",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Once more" },
      session: "session-1",
    });
    await expect(page.getByTestId("conduct-ask")).toBeVisible();
    await page.getByTestId("conduct-no").click();
    await expect(page.getByTestId("conduct-ask")).toHaveCount(0);
  });

  test("stops one of them from its own row", async ({ page }) => {
    await started(page, "c-1", "Fix the flaky test");
    await started(page, "c-2", "Bump the client");
    await toOrchestrator(page);
    await expect(rows(page)).toHaveCount(2);

    await page.getByTestId("stop-started-row").first().click();

    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("session 2");
    // The orchestrator itself is untouched, and the other one still runs.
    await expect(header(page)).toContainText("1 session");
  });

  test("types a line into one of them from its own row", async ({ page }) => {
    await started(page, "c-1", "Fix the flaky test");
    await toOrchestrator(page);

    // The field is opened under the row, and it has the keyboard.
    await expect(page.getByTestId("send-field")).toHaveCount(0);
    await page.getByTestId("send-started-row").click();
    const field = page.getByTestId("send-field");
    await expect(field).toBeFocused();
    const row = (await rows(page).first().boundingBox())!;
    const box = (await field.boundingBox())!;
    expect(box.y).toBeGreaterThan(row.y);

    await field.fill("run the unit tests");
    await field.press("Enter");

    // The line reached the session's terminal as one typed line with Enter
    // on its own after it, and the field closed behind it.
    await expect(field).toHaveCount(0);
    await expect
      .poll(async () => (await written(page)).slice(-2))
      .toEqual([
        ["pty-2", "run the unit tests"],
        ["pty-2", "\r"],
      ]);

    // Escape leaves the field without typing anything.
    await page.getByTestId("send-started-row").click();
    await expect(page.getByTestId("send-field")).toBeVisible();
    await page.getByTestId("send-field").fill("never mind");
    await page.getByTestId("send-field").press("Escape");
    await expect(page.getByTestId("send-field")).toHaveCount(0);
    expect(await written(page)).toHaveLength(2);
  });

  test("says what the starts left behind, and cleans up what can go", async ({
    page,
  }) => {
    // Nothing is under the project yet, so the line is not there.
    await expect(page.getByTestId("worktrees-left")).toHaveCount(0);

    await putWorktrees(page);
    await started(page, "c-1", "Fix the flaky test");
    await toOrchestrator(page);

    await expect(page.getByTestId("worktrees-left")).toContainText(
      "3 worktrees left behind",
    );

    await page.getByTestId("clean-worktrees").click();

    // The one with nothing in it is gone; the other two say why they stayed.
    await expect(page.getByTestId("worktrees-left")).toContainText("2 kept");
    await expect(page.getByTestId("worktrees-left")).toContainText(
      "uncommitted work",
    );
    await expect(page.getByTestId("clean-worktrees")).toBeDisabled();
  });
});

/**
 * The board for any session.
 *
 * A session in an ordinary project that started others has them in a
 * section at the foot of the tree's column, beside Processes and Browser,
 * with the controls the orchestrator's board has. The calls come from the
 * demo project's own session, as a session there makes them.
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

/** The demo project's own session, the first row in the pane. */
async function toStarter(page: Page) {
  await page.locator(SESSIONS).getByTestId("session-row").first().click();
  await expect(section(page)).toBeVisible();
}

const layoutKept = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("workbench.layout") ?? "{}") as Record<string, unknown>);

/** The demo project's own session on screen, following the workflow when
    asked to, with nothing started yet. */
async function begin(page: Page, workflow = false) {
  calls = 0;
  await installFakeCore(page, {
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

    await startOne(page, { prompt: "Fix the flaky cache test", name: "Fix the cache" });
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

    // A row with its state and how long since it changed; the project is
    // its starter's, so it is not named.
    await expect(boardRows(page)).toHaveCount(1);
    await expect(boardRows(page).first().getByTestId("board-name")).toHaveText("Fix the cache");
    await expect(boardRows(page).first().getByTestId("board-detail")).toHaveText("running, now");
    await expect(page.getByTestId("board-allowed-project")).toHaveText("demo");

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

    await expect(boardRow(page, "Fix the cache").getByTestId("board-detail")).toHaveText("Work · running, now");
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
    // the row that asks is in sight.
    await event(page, "session-2", "prompt");
    await event(page, "session-2", "permission");
    await expect(page.getByTestId("board-fold")).toHaveAttribute("aria-expanded", "true");
    await expect(boardRows(page)).toHaveCount(1);
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
    await page.getByTestId("conduct-allow").click();
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
    await startOne(page, { prompt: "Fix the flaky cache test", name: "Fix the cache" });
    await startOne(page, { prompt: "Bump the client", name: "Bump the client" });
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

  test("cleans up the merged worktrees only once asked", async ({ page }) => {
    await begin(page);
    await putWorktrees(page);
    await startOne(page, { prompt: "Fix the flaky cache test", name: "Fix the cache" });
    await toStarter(page);
    await expect(page.getByTestId("board-trees")).toContainText("3 worktrees left behind");

    await page.getByTestId("board-clean").click();
    const ask = page.getByTestId("board-clean-ask");
    await expect(ask).toContainText("Clean up 1 worktree?");
    await expect(ask).toContainText("clean goes, with its branch");
    await expect(ask).toContainText("2 stay");
    await page.getByTestId("board-clean-ask-confirm").click();

    await expect(page.getByTestId("board-trees")).toContainText("2 kept");
    await expect(page.getByTestId("board-trees")).toContainText("uncommitted work");
    await expect(page.getByTestId("board-clean")).toBeDisabled();
  });

  test("is walked by the tree's cursor, as its neighbours are", async ({ page }) => {
    await begin(page);
    await putWorktrees(page);
    await startOne(page, { prompt: "Fix the flaky cache test", name: "Fix the cache" });
    await toStarter(page);
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
    await expect.poll(cursorOn).toBe("started-allowed-0");
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
