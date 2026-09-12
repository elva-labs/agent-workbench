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

const rows = (page: Page) => page.locator("[data-testid='session-row']");

/** Whether a session's terminal has the text in its buffer. The read tool
    answers with what is on screen, and xterm draws on its own clock. */
const drawn = (page: Page, text: string) =>
  page.evaluate((wanted) => {
    interface Buffer {
      length: number;
      getLine(index: number): { translateToString(): string } | undefined;
    }
    const registry =
      (
        window as unknown as {
          __WORKBENCH_TERMINALS__?: Record<
            string,
            { buffer: { active: Buffer } }
          >;
        }
      ).__WORKBENCH_TERMINALS__ ?? {};
    return Object.values(registry).some((terminal) => {
      const active = terminal.buffer.active;
      for (let index = 0; index < active.length; index += 1)
        if (active.getLine(index)?.translateToString().includes(wanted))
          return true;
      return false;
    });
  }, text);

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
    // The session belongs to whoever started it, so the pane folds it under
    // that session rather than drawing it among the project's own.
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId("started-fold")).toContainText(
      "1 started by",
    );

    await expect.poll(() => answerTo(page, "c-1")).not.toBeNull();
    const answer = (await answerTo(page, "c-1"))!;
    expect(answer.error).toBeNull();
    expect(answer.content).toContain("session-2");

    // The new session is started with the prompt on its command line, and
    // with the sentence that asks it to say how it went.
    const spawns = await page.evaluate(
      () =>
        (window as unknown as { __spawns?: { prompt?: string }[] }).__spawns ??
        [],
    );
    expect(spawns.at(-1)?.prompt).toContain("Fix the flaky test");
    expect(spawns.at(-1)?.prompt).toContain(
      "call the notify tool with one line saying which",
    );

    // Both sessions are there to be listed, the new one included.
    await push(page, { id: "c-2", tool: "sessions", session: "session-1" });
    await expect.poll(() => answerTo(page, "c-2")).not.toBeNull();
    const listed = (await answerTo(page, "c-2"))!.content ?? "";
    expect(listed.split("\n")).toHaveLength(2);
    expect(listed).toContain("session-1");
    expect(listed).toContain("session-2");
    expect(listed).toContain(PROJECT);
  });

  test("reads what a session it started has on screen", async ({ page }) => {
    await push(page, {
      id: "c-4",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Run the tests" },
      session: "session-1",
    });
    await page.getByTestId("conduct-allow").click();
    await expect.poll(() => answerTo(page, "c-4")).not.toBeNull();

    // The started session draws, as an agent does, and the read tool
    // answers with what the user would see.
    await page.evaluate(() =>
      (
        window as unknown as { __say: (id: string, text: string) => void }
      ).__say("pty-2", "\r\n42 tests passed\r\n"),
    );
    await expect.poll(() => drawn(page, "42 tests passed")).toBe(true);
    await push(page, {
      id: "c-5",
      tool: "read",
      arguments: { session: "session-2" },
      session: "session-1",
    });
    await expect.poll(() => answerTo(page, "c-5")).not.toBeNull();
    expect((await answerTo(page, "c-5"))!.content).toContain("42 tests passed");

    // The session the user started themselves is theirs alone.
    await push(page, {
      id: "c-6",
      tool: "read",
      arguments: { session: "session-1" },
      session: "session-1",
    });
    await expect.poll(() => answerTo(page, "c-6")).not.toBeNull();
    expect((await answerTo(page, "c-6"))!.error).toContain(
      "not started by you",
    );
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
