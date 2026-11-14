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
    // The session belongs to whoever started it, so the pane hangs it
    // under that session rather than drawing it among the project's own.
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId("started-rail").getByTestId("started-session")).toHaveCount(1);

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

  // A window out of sight is given no animation frames. A session started
  // on a worktree of its own, never on screen, still has what its agent
  // drew to read, and its hooks say what it is doing.
  test("tells the truth of a worktree session nobody has looked at, with no frames drawn", async ({
    page,
  }) => {
    await push(page, {
      id: "c-10",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Run the tests", worktree: true },
      session: "session-1",
    });
    await page.getByTestId("conduct-allow").click();
    await expect.poll(() => answerTo(page, "c-10")).not.toBeNull();
    expect((await answerTo(page, "c-10"))!.content).toContain(
      ".claude/worktrees/run-the-tests",
    );
    const spawned = await page.evaluate(
      () =>
        (window as unknown as { __spawns: { cwd?: string }[] }).__spawns.at(-1)
          ?.cwd,
    );
    expect(spawned).toBe(`${PROJECT}/.claude/worktrees/run-the-tests`);

    // Two terminals, and only the caller's is on screen.
    const terminals = page.getByTestId("terminal");
    await expect(terminals).toHaveCount(2);
    await expect(terminals.nth(0)).toBeVisible();
    await expect(terminals.nth(1)).toBeHidden();

    // From here no frame comes, as in a window behind others.
    await page.evaluate(() => {
      const w = window as unknown as { __heldFrames: FrameRequestCallback[] };
      w.__heldFrames = [];
      window.requestAnimationFrame = (callback) => {
        w.__heldFrames.push(callback);
        return 0;
      };
    });
    const sessionEvent = (kind: string) =>
      page.evaluate(
        (kind) =>
          (
            window as unknown as {
              __sessionEvent: (event: { sessionId: string; kind: string }) => void;
            }
          ).__sessionEvent({ sessionId: "session-2", kind }),
        kind,
      );
    await sessionEvent("prompt");
    await page.evaluate(() =>
      (
        window as unknown as { __say: (id: string, text: string) => void }
      ).__say("pty-2", "\r\nRunning 42 tests\r\n"),
    );
    await expect.poll(() => drawn(page, "Running 42 tests")).toBe(true);
    const held = await page.evaluate(
      () =>
        (window as unknown as { __heldFrames: unknown[] }).__heldFrames.length,
    );
    expect(held).toBeGreaterThan(0);
    await expect(terminals.nth(1)).toBeHidden();

    await push(page, {
      id: "c-11",
      tool: "read",
      arguments: { session: "session-2" },
      session: "session-1",
    });
    await expect.poll(() => answerTo(page, "c-11")).not.toBeNull();
    expect((await answerTo(page, "c-11"))!.content).toContain(
      "Running 42 tests",
    );

    await push(page, { id: "c-12", tool: "sessions", session: "session-1" });
    await expect.poll(() => answerTo(page, "c-12")).not.toBeNull();
    expect((await answerTo(page, "c-12"))!.content).toMatch(
      /session-2 .*run-the-tests.* working/,
    );

    // A wait holds while it works, and answers when its hooks say it
    // stopped.
    await push(page, {
      id: "c-13",
      tool: "wait",
      arguments: { session: "session-2" },
      session: "session-1",
    });
    await page.evaluate(() =>
      (
        window as unknown as { __say: (id: string, text: string) => void }
      ).__say("pty-2", "\r\n41 passed\r\n"),
    );
    await expect.poll(() => drawn(page, "41 passed")).toBe(true);
    expect(await answerTo(page, "c-13")).toBeNull();
    await sessionEvent("stop");
    await expect.poll(() => answerTo(page, "c-13")).not.toBeNull();
    expect((await answerTo(page, "c-13"))!.content).toContain(
      "Session session-2 stopped working.",
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
    await expect(page.getByTestId("started-session")).toHaveCount(0);
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
    // Back under its starter, resumed by id, with the prompt on its
    // command line.
    await expect(page.getByTestId("started-session")).toHaveCount(1);
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

    // The worker's tag says what its step allows, in the settings' words,
    // to the person reading it rather than to the orchestrator.
    // On the pane's rail the worker shows its place where a started row
    // shows its model.
    const workerRow = page.getByTestId("started-session").first();
    await expect(workerRow.getByTestId("started-role")).toHaveText("Work");
    await expect(workerRow.getByTestId("started-model")).toHaveCount(0);
    await workerRow.click();
    await expect(page.getByTestId("workflow-tag-role")).toHaveText("Work");
    await page.getByTestId("workflow-tag").click();
    const rules = page.getByTestId("workflow-rules");
    await expect(rules.locator(".rule")).toHaveText([
      "Does work.",
      "Models it may use: Sonnet.",
      "Sessions at once: 1.",
    ]);
    await expect(rules).not.toContainText("you");
  });

  test("says in the agent pane's header which workflow a session follows, and shows a refused start", async ({
    page,
  }) => {
    const header = page.locator(`${AGENT} header`);
    const tag = page.getByTestId("workflow-tag");
    await expect(page.getByTestId("workflow-tag-flow")).toHaveText("Build and review·");
    await expect(page.getByTestId("workflow-tag-role")).toHaveText("orchestrator");
    // Quiet, and in the header beside the title, the workflow's name first.
    const head = (await header.boundingBox())!;
    const box = (await tag.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(head.y);
    expect(box.y + box.height).toBeLessThanOrEqual(head.y + head.height + 1);
    const flowBox = (await page.getByTestId("workflow-tag-flow").boundingBox())!;
    const roleBox = (await page.getByTestId("workflow-tag-role").boundingBox())!;
    expect(flowBox.x + flowBox.width).toBeLessThanOrEqual(roleBox.x + 1);
    // No tooltip of the platform's: the rules are a popover of the app's,
    // shown while the pointer rests on the tag.
    await expect(tag).not.toHaveAttribute("title");
    const rules = page.getByTestId("workflow-rules");
    await expect(rules).toHaveCount(0);
    // Closed, the tag points at no element that is not there.
    await expect(tag).not.toHaveAttribute("aria-controls");
    await tag.hover();
    await expect(rules).toBeVisible();
    await expect(rules).toContainText('For the step "Work"');
    await expect(rules).not.toContainText("`");
    const controls = await tag.getAttribute("aria-controls");
    expect(await rules.getAttribute("id")).toBe(controls);
    const pop = (await rules.boundingBox())!;
    expect(pop.y).toBeGreaterThanOrEqual(box.y + box.height);
    const pane = (await page.locator(AGENT).boundingBox())!;
    expect(pop.x + pop.width).toBeLessThanOrEqual(pane.x + pane.width);
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 20);
    await expect(rules).toHaveCount(0);
    // And by the keyboard: Enter shows it, Escape puts it away and leaves
    // the keyboard on the tag.
    await tag.focus();
    await page.keyboard.press("Enter");
    await expect(rules).toBeVisible();
    await expect(tag).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(rules).toHaveCount(0);
    await expect(tag).toBeFocused();

    await push(page, {
      id: "c-1",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Fix it", step: "Deploy" },
      session: "session-1",
    });
    const refused = page.getByTestId("workflow-refused");
    await expect(refused).toBeVisible();
    await expect(refused).toContainText('Start refused');
    await expect(refused).toContainText('The workflow "Build and review" has no step called "Deploy".');
    // One line over the terminal, under the header.
    const line = (await refused.boundingBox())!;
    expect(line.height).toBeLessThan(40);
    expect(line.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
    await page.getByTestId("workflow-refused-dismiss").click();
    await expect(refused).toHaveCount(0);
  });
});

test.describe("the workflow tag", () => {
  test("speaks the look's own type, and keeps the place whole as the pane narrows", async ({ page }) => {
    await installFakeCore(page, { settings: { ...WITH_WORKFLOW, look: "terminal" } });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await page.getByTestId("start-agent").click();
    const tag = page.getByTestId("workflow-tag");
    const role = page.getByTestId("workflow-tag-role");
    const flow = page.getByTestId("workflow-tag-flow");
    await expect(role).toHaveText("orchestrator");
    const type = (selector: string) =>
      page.locator(selector).first().evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.fontFamily, style.textTransform];
      });
    // The header's own type, small capitals in the terminal look, for the
    // tag and for a refused start alike.
    const title = await type(`${AGENT} header .title`);
    expect(title[1]).toBe("uppercase");
    expect(await type("[data-testid='workflow-tag']")).toEqual(title);
    await push(page, {
      id: "c-1",
      tool: "start",
      arguments: { project: PROJECT, prompt: "Fix it", step: "Deploy" },
      session: "session-1",
    });
    await expect(page.getByTestId("workflow-refused")).toBeVisible();
    expect((await type("[data-testid='workflow-refused'] .refused-lead"))[0]).toBe(title[0]);
    expect((await type("[data-testid='workflow-refused'] .refused-text"))[0]).toBe(title[0]);

    // Narrowed, the workflow's name gives way, first cut short and then
    // gone from the line, and the place stays whole on it.
    const sizes: { flow: number; on: boolean }[] = [];
    for (const width of [1440, 1100, 1000, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(async () => (await page.locator(AGENT).boundingBox())?.width)
        .toBeLessThan(width);
      const box = (await tag.boundingBox())!;
      const placed = (await role.boundingBox())!;
      expect(placed.y).toBeLessThan(box.y + box.height);
      expect(placed.x + placed.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(await role.evaluate((element) => element.scrollWidth <= element.clientWidth + 0.5)).toBe(true);
      const named = (await flow.boundingBox())!;
      sizes.push({ flow: named.width, on: named.y < box.y + box.height });
    }
    expect(sizes[0].on).toBe(true);
    expect(sizes.some((size) => size.on && size.flow < sizes[0].flow)).toBe(true);
    expect(sizes.at(-1)!.on).toBe(false);
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
    await start("c-1", { step: "Work", name: "Fix the cache" });
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
    // Said in the words the user knows the work by, never its id.
    await expect(page.getByTestId("conduct-round")).toHaveText(
      "Review has run twice on Fix the cache, as many times as the workflow allows. Allow another round?",
    );
    await expect(page.getByTestId("conduct-allow-round")).toHaveText("Allow one more round");
    await expect(page.getByTestId("conduct-no")).toHaveText("Stop at the limit");
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
    // The user's own answer is not put back to them as a refused start.
    await expect(page.getByTestId("workflow-refused")).toHaveCount(0);
  });
});
