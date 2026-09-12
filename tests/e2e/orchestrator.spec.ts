import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * An orchestrator, driven by a fake core.
 *
 * The workbench's own directory is pinned above the projects you opened,
 * and a session started there directs the others. What it starts stays in
 * the project it runs in and keeps out of the way: the project's rows are
 * its own sessions, and the rest are behind a fold with the orchestrator's
 * name on it.
 */

const AGENT = "section[data-pane='agent']";
/** Cmd on macOS, Ctrl elsewhere. */
const MOD = "ControlOrMeta";
/** Where the fake core says an orchestrator runs. */
const ORCHESTRATOR = "/home/ada/.agent-workbench/orchestrator";

interface Answer {
  id: string;
  content: string | null;
  error: string | null;
}

/** A call as the core delivers one. */
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
    ({ project, request }) =>
      (
        window as unknown as { __conductRequest: (call: unknown) => void }
      ).__conductRequest({
        id: request.id,
        tool: request.tool,
        arguments: request.arguments ?? {},
        cwd: project,
        session: request.session ?? null,
      }),
    { project: PROJECT, request },
  );
}

const answerTo = async (page: Page, id: string) =>
  (
    await page.evaluate(
      () =>
        (window as unknown as { __conductAnswers?: Answer[] })
          .__conductAnswers ?? [],
    )
  ).find((answer) => answer.id === id) ?? null;

const row = (page: Page, project: string) =>
  page.locator(`[data-row="project:${project}"]`);

/**
 * A session of the project's own, a session in the orchestrator's project,
 * and one that orchestrator starts in the project. The fake hands out ids
 * in that order, so the orchestrator is session-2 and what it starts is
 * session-3.
 */
async function orchestrate(page: Page) {
  await page.getByTestId("start-agent").click();
  await expect(page.locator(AGENT)).toContainText("running");

  // The orchestrator's project has nothing to show yet, so the first
  // session there is started from the head's menu.
  await page.getByTestId("sessions-menu").click();
  await page.getByTestId("menu-orchestrator").click();
  await expect(page.locator(AGENT)).toContainText("running");

  await push(page, {
    id: "o-1",
    tool: "start",
    arguments: { project: PROJECT, prompt: "Bump the client" },
    session: "session-2",
  });
  await page.getByTestId("conduct-allow").click();
  await expect.poll(() => answerTo(page, "o-1")).not.toBeNull();
  const answer = (await answerTo(page, "o-1"))!;
  expect(answer.error).toBeNull();
  expect(answer.content).toContain("session-3");
}

test.describe("the orchestrator", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeCore(page);
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
  });

  test("folds what it started into the project, and says what it has out", async ({
    page,
  }) => {
    // Nothing runs there and nothing waits to be resumed, so the project is
    // not drawn at all: the menu is the way to the first session.
    const pinned = page.getByTestId("orchestrator-project");
    await expect(pinned).toHaveCount(0);

    await orchestrate(page);

    // With a session of its own it is pinned above the ones you opened, and
    // has nothing to close: it is the workbench's own.
    await expect(pinned).toHaveText("orchestrator");
    const top = (await row(page, ORCHESTRATOR).boundingBox())!;
    const opened = (await row(page, PROJECT).boundingBox())!;
    expect(top.y).toBeLessThan(opened.y);
    await expect(
      row(page, ORCHESTRATOR).getByTestId("close-project"),
    ).toHaveCount(0);

    // A row each for the two sessions a user started, and none for what
    // the orchestrator started: that one is behind a fold in the project it
    // runs in.
    await expect(page.getByTestId("session-row")).toHaveCount(2);
    const fold = page.getByTestId("started-fold");
    await expect(fold).toContainText("1 started by session 1");
    await expect(page.getByTestId("started-session")).toHaveCount(0);
    expect((await fold.boundingBox())!.y).toBeGreaterThan(opened.y);

    // The orchestrator's own row says what it has running.
    await expect(page.getByTestId("orchestrator-summary")).toHaveText(
      "1 running",
    );

    // The fold opens onto the session, indented past its triangle.
    await fold.click();
    const started = page.getByTestId("started-session");
    await expect(started).toHaveCount(1);
    await expect(started).toContainText("session 2");
    const triangle = (await fold.locator(".chevron").boundingBox())!;
    const name = (await started.locator(".label").boundingBox())!;
    expect(name.x).toBeGreaterThan(triangle.x + triangle.width);
    expect(name.y).toBeGreaterThan(triangle.y);

    // It is a session like any other: clicking it opens it.
    await started.click();
    await expect(page.locator(".session.started")).toHaveClass(/on/);

    // And the fold closes again on the row it opened from.
    await fold.click();
    await expect(page.getByTestId("started-session")).toHaveCount(0);

    // It is a row of the pane's one cursor as much as a thing to click:
    // the open row, the orchestrator's session, the project, its own
    // session, and then the fold, which Enter opens.
    await page.keyboard.press(`${MOD}+1`);
    await page.keyboard.press("Home");
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("ArrowDown");
    }
    await expect(fold).toHaveClass(/cursor/);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("started-session")).toHaveCount(1);
  });

  test("speaks up on the fold when a started session is waiting", async ({
    page,
  }) => {
    await orchestrate(page);
    // The orchestrator is what is on screen, so the line its session leaves
    // is one nobody has seen. Its row is the first: its project is pinned
    // above the one the window opened with.
    await page.getByTestId("session-row").first().click();
    await page.evaluate(
      (project) =>
        (
          window as unknown as { __notifyRequest: (request: unknown) => void }
        ).__notifyRequest({
          text: "Which client did you mean?",
          cwd: project,
          session: "session-3",
        }),
      PROJECT,
    );

    const fold = page.getByTestId("started-fold");
    await expect(fold).toContainText("1 asking");
    await expect(fold.locator(".ring")).toBeVisible();
    await expect(page.getByTestId("orchestrator-summary")).toHaveText(
      "1 running, 1 asking",
    );

    // Looking at the session is answer enough: the fold goes quiet again.
    await fold.click();
    await page.getByTestId("started-session").click();
    await expect(fold).not.toContainText("asking");
    await expect(page.getByTestId("orchestrator-summary")).toHaveText(
      "1 running",
    );
  });

  test("keeps a started session running when Delete lands on its row", async ({
    page,
  }) => {
    await orchestrate(page);
    await page.getByTestId("started-fold").click();
    const started = page.getByTestId("started-session");
    await expect(started).toHaveCount(1);

    // Opening it puts the pane's cursor there, and the rows behind a fold
    // are quiet: the key the cursor walks over does nothing.
    await started.click();
    await page.keyboard.press(`${MOD}+1`);
    await expect(page.locator(".session.started")).toHaveClass(/cursor/);
    await page.keyboard.press("Delete");
    await page.keyboard.press("Backspace");
    await expect(started).toHaveCount(1);

    // Its own × still stops it.
    const stop = page.locator(".session.started").getByTestId("close-session");
    await page.locator(".session.started").hover();
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(page.getByTestId("started-session")).toHaveCount(0);
  });

  test("stops everything behind a fold from the fold's own button", async ({
    page,
  }) => {
    await orchestrate(page);
    await push(page, {
      id: "o-2",
      tool: "start",
      arguments: { project: PROJECT, prompt: "And the server" },
      session: "session-2",
    });
    // The first start was allowed for good, so this one needs no answer.
    await expect.poll(() => answerTo(page, "o-2")).not.toBeNull();
    const fold = page.getByTestId("started-fold");
    await expect(fold).toContainText("2 started by session 1");

    // Over the fold's end, as a session's × is over its own.
    const stop = page.getByTestId("stop-started");
    await expect(stop).toHaveAttribute("title", "Stop these");
    await fold.hover();
    await expect(stop).toBeVisible();
    const line = (await fold.boundingBox())!;
    const button = (await stop.boundingBox())!;
    expect(button.x).toBeGreaterThan(line.x + line.width / 2);
    expect(button.x + button.width).toBeLessThanOrEqual(line.x + line.width);

    // Both go, and the fold with them; the sessions a user started stay.
    await stop.click();
    await expect(page.getByTestId("started-fold")).toHaveCount(0);
    await expect(page.getByTestId("started-session")).toHaveCount(0);
    await expect(page.getByTestId("session-row")).toHaveCount(2);
  });
});
