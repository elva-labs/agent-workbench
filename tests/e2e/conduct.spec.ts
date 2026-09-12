import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * One session directing another, driven by a fake core.
 *
 * The core carries a call on one of the conductor's tools to the window as
 * a request; the window does the work and answers it. Here the request is
 * pushed straight at the handler the app registered, and the answers are
 * read back off the fake.
 */

const AGENT = "section[data-pane='agent']";

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

const answers = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __conductAnswers?: Answer[] }).__conductAnswers ??
      [],
  );

const answerTo = async (page: Page, id: string) =>
  (await answers(page)).find((answer) => answer.id === id) ?? null;

const written = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __written?: [string, string][] }).__written ?? [],
  );

const rows = (page: Page) => page.locator("[data-testid='session-row']");

test.describe("the conductor", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeCore(page);
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    // One session of the user's own, which is the caller below.
    await page.getByTestId("start-agent").click();
    await expect(rows(page)).toHaveCount(1);
  });

  test("asks before starting a session, then starts it and answers with its id", async ({
    page,
  }) => {
    await push(page, {
      id: "c-1",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Fix the flaky test" },
      session: "session-1",
    });

    const ask = page.getByTestId("conduct-ask");
    await expect(ask).toBeVisible();
    await expect(ask).toContainText(PROJECT);
    await expect(ask).toContainText("Fix the flaky test");
    // The question sits over the agent pane, where the session it is about
    // will appear.
    const card = (await ask.boundingBox())!;
    const pane = (await page.locator(AGENT).boundingBox())!;
    expect(card.x).toBeGreaterThan(pane.x - card.width);
    expect(card.x).toBeLessThan(pane.x + pane.width);
    expect(card.y).toBeLessThan(pane.y + pane.height);
    // Nothing has started while the question is up.
    await expect(rows(page)).toHaveCount(1);
    expect(await answers(page)).toHaveLength(0);

    await page.getByTestId("conduct-allow").click();
    await expect(ask).toHaveCount(0);
    await expect(rows(page)).toHaveCount(2);

    await expect.poll(() => answerTo(page, "c-1")).not.toBeNull();
    const answer = (await answerTo(page, "c-1"))!;
    expect(answer.error).toBeNull();
    expect(answer.content).toContain("session-2");

    // The prompt is typed into the new session once it is up.
    await expect
      .poll(async () => (await written(page)).map(([, data]) => data))
      .toContain("Fix the flaky test\r");

    // Both sessions are there to be listed, the new one included.
    await push(page, { id: "c-2", tool: "sessions", session: "session-1" });
    await expect.poll(() => answerTo(page, "c-2")).not.toBeNull();
    const listed = (await answerTo(page, "c-2"))!.content ?? "";
    expect(listed.split("\n")).toHaveLength(2);
    expect(listed).toContain("session-1");
    expect(listed).toContain("session-2");
    expect(listed).toContain(PROJECT);
  });

  test("starts nothing when the user says no", async ({ page }) => {
    await push(page, {
      id: "c-3",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Fix the flaky test" },
      session: "session-1",
    });
    await expect(page.getByTestId("conduct-ask")).toBeVisible();
    await page.getByTestId("conduct-no").click();
    await expect(page.getByTestId("conduct-ask")).toHaveCount(0);
    await expect(rows(page)).toHaveCount(1);
    await expect.poll(() => answerTo(page, "c-3")).not.toBeNull();
    expect((await answerTo(page, "c-3"))!.error).toContain("did not allow");
  });
});
