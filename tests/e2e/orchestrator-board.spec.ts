import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

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

test.describe("the orchestrator's board", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeCore(page, { open: [ORCHESTRATOR, PROJECT] });
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

    // One of them leaves a line while the orchestrator is on screen: it is
    // waiting on the user, and the header says how many are.
    await notify(page, first, "Which suite should I run?");
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
});
