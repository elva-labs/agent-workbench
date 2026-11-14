import { expect, test, type Page } from "@playwright/test";
import { PROJECT, NO_WORKFLOW, WITH_WORKFLOW, installFakeCore } from "./fake";

/**
 * One session directing another, driven by a fake core.
 *
 * The core carries a call on one of the conductor's tools to the window as
 * a request; the window does the work and answers it. Here the request is
 * pushed straight at the handler the app registered, and the answers are
 * read back off the fake.
 */

const AGENT = "section[data-pane='agent']";
const MOD = "ControlOrMeta";

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
    await installFakeCore(page, { settings: NO_WORKFLOW });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    // One session of the user's own, which is the caller below.
    await page.getByTestId("start-agent").click();
    await expect(rows(page)).toHaveCount(1);
  });

  test("keeps both palettes shut while the question is up", async ({ page }) => {
    await push(page, {
      id: "c-1",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Fix the flaky test" },
      session: "session-1",
    });
    await expect(page.getByTestId("conduct-ask")).toBeVisible();
    await page.keyboard.press(`${MOD}+P`);
    await page.keyboard.press(`${MOD}+Shift+P`);
    await expect(page.getByTestId("palette")).toHaveCount(0);
    await expect(page.getByTestId("conduct-ask")).toBeVisible();
  });

  test("gives the keyboard back to the pane that had it when the question is answered", async ({ page }) => {
    const written = () =>
      page.evaluate(() =>
        ((window as unknown as { __written?: [string, string][] }).__written ?? []).map((w) => w[1]).join(""),
      );
    for (const answer of ["conduct-no", "conduct-once"]) {
      await page.keyboard.press(`${MOD}+1`);
      await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
      await push(page, {
        id: `c-${answer}`,
        tool: "start",
        arguments: { project: PROJECT, prompt: "Fix the flaky test" },
        session: "session-1",
      });
      await expect(page.getByTestId("conduct-ask")).toBeVisible();
      await page.getByTestId(answer).click();
      await expect(page.getByTestId("conduct-ask")).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.closest("[data-pane='sessions']") != null))
        .toBe(true);
    }
    await page.keyboard.press(`${MOD}+2`);
    await push(page, {
      id: "c-agent",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Fix the flaky test" },
      session: "session-1",
    });
    await expect(page.getByTestId("conduct-ask")).toBeVisible();
    await page.getByTestId("conduct-no").click();
    await expect(page.getByTestId("conduct-ask")).toHaveCount(0);
    const before = await written();
    await page.keyboard.type("y");
    await expect.poll(written).toBe(before + "y");
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

    // The new session is listed as the caller's own; the caller itself,
    // which the user started, is not.
    await push(page, { id: "c-2", tool: "sessions", session: "session-1" });
    await expect.poll(() => answerTo(page, "c-2")).not.toBeNull();
    const listed = (await answerTo(page, "c-2"))!.content ?? "";
    expect(listed.split("\n")).toHaveLength(1);
    expect(listed).toContain("session-2");
    expect(listed).not.toContain("session-1  ");
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

  test("remembers what it started across a restart, and resumes it on request", async ({
    page,
  }) => {
    await push(page, {
      id: "c-7",
      tool: "start",
      arguments: {
        project: PROJECT,
        prompt: "Fix the flaky test",
        name: "Cache flake",
        agent: "claude-code",
        model: "sonnet",
      },
      session: "session-1",
    });
    await page.getByTestId("conduct-allow").click();
    await expect.poll(() => answerTo(page, "c-7")).not.toBeNull();
    // The model the caller chose goes to the agent's command line.
    const spawns = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __spawns?: {
                session?: string;
                model?: string;
                prompt?: string;
              }[];
            }
          ).__spawns ?? [],
      );
    expect((await spawns()).at(-1)?.model).toBe("sonnet");

    // The app comes back with the caller, resumed, and without the session
    // it started: that one is the caller's to bring back.
    await page.reload();
    await expect(page.locator(AGENT)).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId("started-fold")).toHaveCount(0);
    await expect.poll(async () => (await spawns()).map((spawn) => spawn.session)).toEqual([
      "session-1",
    ]);

    await push(page, { id: "c-8", tool: "sessions", session: "session-1" });
    await expect.poll(() => answerTo(page, "c-8")).not.toBeNull();
    const listed = (await answerTo(page, "c-8"))!.content ?? "";
    expect(listed).toContain("session-2  Cache flake  ");
    expect(listed).toContain("stopped");
    expect(listed).toContain("naming session session-2");

    await push(page, {
      id: "c-9",
      tool: "start",
      arguments: { session: "session-2", prompt: "Go on with the test" },
      session: "session-1",
    });
    // No question: starting it was consented to, and this is that session
    // going on.
    await expect.poll(() => answerTo(page, "c-9")).not.toBeNull();
    await expect(page.getByTestId("conduct-ask")).toHaveCount(0);
    const answer = (await answerTo(page, "c-9"))!;
    expect(answer.error).toBeNull();
    expect(answer.content).toContain("Resumed session session-2");
    // Back under the fold, resumed by id, with the prompt on its command line.
    await expect(page.getByTestId("started-fold")).toContainText(
      "1 started by",
    );
    const resumed = (await spawns()).at(-1);
    expect(resumed?.session).toBe("session-2");
    expect(resumed?.prompt).toContain("Go on with the test");
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

test.describe("a session that follows a workflow", () => {
  test.beforeEach(async ({ page }) => {
    // New sessions follow the shipped workflow, turned on.
    await installFakeCore(page, { settings: WITH_WORKFLOW });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await page.getByTestId("start-agent").click();
    await expect(rows(page)).toHaveCount(1);
  });

  const spawns = (page: Page) =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __spawns?: {
              agent: string;
              model?: string;
              instructions?: string;
              startOnly?: boolean;
            }[];
          }
        ).__spawns ?? [],
    );

  test("starts on the workflow's orchestrator, told the workflow", async ({ page }) => {
    const [first] = await spawns(page);
    expect(first.agent).toBe("claude-code");
    expect(first.model).toBe("fable");
    expect(first.startOnly).toBe(true);
    expect(first.instructions).toContain('workflow "Build and review"');
    expect(first.instructions).toContain('2. For the step "Work"');
  });

  test("names a step in each start, and is refused one the workflow does not have", async ({
    page,
  }) => {
    await push(page, {
      id: "c-1",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Fix the flaky test" },
      session: "session-1",
    });
    await expect.poll(() => answerTo(page, "c-1")).not.toBeNull();
    expect((await answerTo(page, "c-1"))!.error).toContain(
      'The steps are "Work" (work) and "Review" (review).',
    );
    // Refused before the user is troubled.
    await expect(page.getByTestId("conduct-ask")).toHaveCount(0);

    await push(page, {
      id: "c-2",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Fix the flaky test", step: "Work" },
      session: "session-1",
    });
    await page.getByTestId("conduct-allow").click();
    await expect.poll(() => answerTo(page, "c-2")).not.toBeNull();
    expect((await answerTo(page, "c-2"))!.content).toContain(
      'Started session session-2 for step "Work"',
    );
    // The step's first model, and none of the workflow: the worker is no
    // orchestrator.
    const worker = (await spawns(page)).at(-1)!;
    expect(worker.model).toBe("sonnet");
    expect(worker.instructions).toBeUndefined();

    await push(page, { id: "c-3", tool: "sessions", session: "session-1" });
    await expect.poll(() => answerTo(page, "c-3")).not.toBeNull();
    expect((await answerTo(page, "c-3"))!.content).toContain('step "Work"');
  });
});

test.describe("a round of review past the workflow's limit", () => {
  test("is put to the user, and goes ahead only when they allow it", async ({ page }) => {
    const once = structuredClone(WITH_WORKFLOW);
    const review = once.workflows.list[0].steps[1] as { limit: number };
    review.limit = 1;
    await installFakeCore(page, { settings: once });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await page.getByTestId("start-agent").click();
    await expect(rows(page)).toHaveCount(1);

    const start = async (id: string, args: Record<string, unknown>) => {
      await push(page, {
        id,
        tool: "start",
        arguments: { project: PROJECT, prompt: "Go", ...args },
        session: "session-1",
      });
    };
    await start("c-1", { step: "Work" });
    await page.getByTestId("conduct-allow").click();
    await expect.poll(() => answerTo(page, "c-1")).not.toBeNull();
    // Two rounds: the first, and the one the work may be sent back for.
    for (const id of ["c-2", "c-3"]) {
      await start(id, { step: "Review", work: "session-2" });
      await expect.poll(() => answerTo(page, id)).not.toBeNull();
      expect((await answerTo(page, id))!.error).toBeNull();
    }

    await start("c-4", { step: "Review", work: "session-2", prompt: "Look once more" });
    const ask = page.getByTestId("conduct-ask");
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("wants another round of Review");
    await expect(page.getByTestId("conduct-round")).toHaveText(
      "The work of session session-2 has had 2 rounds, and the workflow sends a piece back once.",
    );
    await expect(ask).toContainText("Look once more");
    await expect(page.getByTestId("conduct-allow")).toHaveCount(0);
    await page.getByTestId("conduct-allow-round").click();
    await expect(ask).toHaveCount(0);
    await expect.poll(() => answerTo(page, "c-4")).not.toBeNull();
    expect((await answerTo(page, "c-4"))!.content).toContain('for step "Review" round 3');

    await start("c-5", { step: "Review", work: "session-2" });
    await expect(ask).toBeVisible();
    await page.getByTestId("conduct-no").click();
    await expect.poll(() => answerTo(page, "c-5")).not.toBeNull();
    expect((await answerTo(page, "c-5"))!.error).toContain("the user did not allow another");
  });
});
