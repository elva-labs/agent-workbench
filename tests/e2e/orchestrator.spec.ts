import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * An orchestrator, driven by a fake core.
 *
 * The workbench's own directory is pinned above the projects you opened,
 * and a session started there directs the others. What it starts hangs
 * under it on a rail, a line each, wherever it runs, and can be folded into
 * dots on the orchestrator's own row.
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

  test("hangs what it started under it on a rail, and says what it has out", async ({
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

    // A row each for the two sessions a user started, and the one the
    // orchestrator started on a rail under it, above the project it runs
    // in, which it names in front of its own name.
    await expect(page.getByTestId("session-row")).toHaveCount(2);
    const parent = page
      .getByTestId("session-row")
      .filter({ has: page.getByTestId("orchestrator-summary") });
    const started = page.getByTestId("started-session");
    await expect(started).toHaveCount(1);
    await expect(started).toContainText("demo");
    await expect(started).toContainText("session 2");
    const above = (await parent.boundingBox())!;
    const kid = (await started.boundingBox())!;
    expect(kid.y).toBeGreaterThanOrEqual(above.y + above.height - 1);
    expect(kid.y + kid.height).toBeLessThanOrEqual(opened.y + 1);

    // The rail runs down from the orchestrator's dot to the started one's,
    // once the started row has finished coming in.
    await expect
      .poll(() => started.evaluate((row) => row.closest(".row-slot")!.getAnimations().length))
      .toBe(0);
    const dot = (await parent.locator(".dot").boundingBox())!;
    const rail = (await page.locator(".kid .rail-in").boundingBox())!;
    const own = (await started.locator(".dot").boundingBox())!;
    expect(Math.abs(rail.x - (dot.x + dot.width / 2))).toBeLessThan(1.5);
    expect(rail.y).toBeLessThanOrEqual(dot.y + dot.height + 1);
    expect(rail.y + rail.height).toBeGreaterThan(own.y);
    expect(rail.x + rail.width).toBeLessThanOrEqual(own.x + 1);

    // The orchestrator's own row says what it has running.
    await expect(page.getByTestId("orchestrator-summary")).toHaveText(
      "1 running",
    );

    // It is a session like any other: clicking it opens it.
    await started.click();
    await expect(page.locator(".session.kid")).toHaveClass(/on/);

    // Its own name comes first, and the project it runs in after it.
    const name = (await started.locator(".label").boundingBox())!;
    const where = (await started.getByTestId("started-where").boundingBox())!;
    expect(where.x).toBeGreaterThanOrEqual(name.x + name.width - 1);

    // The chevron at the end of the orchestrator's second line folds the
    // started sessions into a dot each, with what they are doing in words
    // once; the row's × on hover sits on the first line, clear of it.
    const chevron = page.getByTestId("collapse-started");
    const second = (await parent.locator(".second").boundingBox())!;
    const fold = (await chevron.boundingBox())!;
    expect(Math.abs(fold.y + fold.height / 2 - (second.y + second.height / 2))).toBeLessThan(3);
    await parent.hover();
    const close = (await parent.locator("..").getByTestId("close-session").first().boundingBox())!;
    expect(close.y + close.height).toBeLessThanOrEqual(fold.y + 1);
    await chevron.click();
    await expect(started).toHaveCount(0);
    const dots = page.getByTestId("started-dots");
    await expect(dots).toHaveText("");
    await expect(dots.locator(".dot")).toHaveCount(1);
    await expect(page.getByTestId("orchestrator-summary")).toHaveText("1 running");
    await page.getByTestId("collapse-started").click();
    await expect(started).toHaveCount(1);
    await expect(dots).toHaveCount(0);

    // On the keyboard: Left folds the orchestrator's, Right lets them out,
    // Down walks onto the started one and Left climbs back.
    await parent.click();
    await page.keyboard.press(`${MOD}+1`);
    const at = () =>
      page.evaluate(() => document.querySelector("[data-testid='sessions-nav'] .cursor")?.getAttribute("data-row"));
    const own_row = await parent.locator("..").getAttribute("data-row");
    await expect.poll(at).toBe(own_row);
    await page.keyboard.press("ArrowLeft");
    await expect(started).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(started).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".session.kid")).toHaveClass(/cursor/);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(at).toBe(own_row);
  });

  test("breathes on the orchestrator's own dot while a started session works", async ({
    page,
  }) => {
    await orchestrate(page);
    // The orchestrator is what is on screen; the session it directs is
    // session-3, folded under the project it runs in.
    const dot = page
      .getByTestId("session-row")
      .filter({ has: page.getByTestId("orchestrator-summary") })
      .locator(".dot");
    // Parked on a wait with the child idle: the dot rests.
    await expect(dot).not.toHaveClass(/working/);

    const event = (kind: string) =>
      page.evaluate(
        (kind) =>
          (
            window as unknown as {
              __sessionEvent?: (event: {
                sessionId: string;
                kind: string;
              }) => void;
            }
          ).__sessionEvent?.({ sessionId: "session-3", kind }),
        kind,
      );

    // The child starts a turn: its work bubbles up to the orchestrator's dot.
    await event("prompt");
    await expect(dot).toHaveClass(/working/);

    // The child stops: the dot rests again. It is the orchestrator that is
    // waiting on the child, not the user, so nothing says asking.
    await event("stop");
    await expect(dot).not.toHaveClass(/working/);
    await expect(page.getByTestId("orchestrator-summary")).toHaveText(
      "1 running",
    );
  });

  test("speaks up on the started row only when it needs a permission", async ({
    page,
  }) => {
    await orchestrate(page);
    // The orchestrator is what is on screen, so nobody is looking at the
    // session it started. Its row is the first: its project is pinned
    // above the one the window opened with.
    await page.getByTestId("session-row").first().click();
    const event = (kind: string) =>
      page.evaluate(
        (kind) =>
          (
            window as unknown as {
              __sessionEvent?: (event: {
                sessionId: string;
                kind: string;
              }) => void;
            }
          ).__sessionEvent?.({ sessionId: "session-3", kind }),
        kind,
      );
    const started = page.getByTestId("started-session");
    const summary = page.getByTestId("orchestrator-summary");

    // A line the session leaves is the orchestrator's to read: its row
    // stays quiet.
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
    await expect(summary).toHaveText("1 running");
    await expect(page.getByTestId("started-asking")).toHaveCount(0);

    // A permission is the user's to grant, so the row says so in the
    // accent, where its model stands otherwise.
    await event("prompt");
    await event("permission");
    const asking = page.getByTestId("started-asking");
    await expect(asking).toHaveText("asking");
    const accent = await page.evaluate(() =>
      getComputedStyle(document.querySelector("[data-testid='started-asking']")!).color,
    );
    const ink = await started.locator(".label").evaluate((label) => getComputedStyle(label).color);
    expect(accent).not.toBe(ink);
    await expect(started.locator(".dot")).toHaveClass(/permission/);
    await expect(summary).toHaveText("1 running, 1 asking");

    // Granted, the agent goes on, and the row goes quiet again.
    await event("prompt");
    await expect(asking).toHaveCount(0);
    await expect(summary).toHaveText("1 running");
  });

  test("keeps a started session running when Delete lands on its row", async ({
    page,
  }) => {
    await orchestrate(page);
    const started = page.getByTestId("started-session");
    await expect(started).toHaveCount(1);

    // Opening it puts the pane's cursor there, and the rows on a rail are
    // quiet: the key the cursor walks over does nothing.
    await started.click();
    await page.keyboard.press(`${MOD}+1`);
    await expect(page.locator(".session.kid")).toHaveClass(/cursor/);
    await page.keyboard.press("Delete");
    await page.keyboard.press("Backspace");
    await expect(started).toHaveCount(1);

    // Its own × still stops it.
    const stop = page.locator(".session.kid").getByTestId("close-session");
    await page.locator(".session.kid").hover();
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(page.getByTestId("started-session")).toHaveCount(0);
  });

  test("folds two started sessions into two dots and a count", async ({
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
    const started = page.getByTestId("started-session");
    await expect(started).toHaveCount(2);
    // One rail: the first joins the orchestrator's dot and carries on down
    // to the second.
    await expect(page.locator(".kid .rail-on")).toHaveCount(1);

    const parent = page
      .getByTestId("session-row")
      .filter({ has: page.getByTestId("orchestrator-summary") });
    await page.getByTestId("collapse-started").click();
    await expect(started).toHaveCount(0);
    const dots = page.getByTestId("started-dots");
    await expect(dots).toHaveText("");
    await expect(dots.locator(".dot")).toHaveCount(2);
    // Where the model stands otherwise, at the end of the second line.
    const line = (await parent.getByTestId("orchestrator-summary").boundingBox())!;
    const box = (await dots.boundingBox())!;
    expect(box.x).toBeGreaterThan(line.x);
    expect(Math.abs(box.y + box.height / 2 - (line.y + line.height / 2))).toBeLessThan(4);
    // The sessions a user started stay.
    await expect(page.getByTestId("session-row")).toHaveCount(2);
  });
});

test.describe("a started session in a project of its own", () => {
  const OTHER = "/home/ada/dev/other";

  // Nothing else runs in the project the started session runs in, and
  // nobody has used it in weeks: it stays under Inactive when the session
  // is picked from its starter's rail, and the starter's project is the
  // one used.
  test("leaves that project under Inactive when the session is picked", async ({
    page,
  }) => {
    await installFakeCore(page, {
      open: [PROJECT, OTHER],
      used: { [PROJECT]: 60_000, [OTHER]: 30 * 24 * 3600 * 1000 },
    });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await page.getByTestId("sessions-menu").click();
    await page.getByTestId("menu-orchestrator").click();
    await expect(page.locator(AGENT)).toContainText("running");
    await push(page, {
      id: "o-1",
      tool: "start",
      arguments: { project: OTHER, prompt: "Bump the client" },
      session: "session-1",
    });
    await page.getByTestId("conduct-allow").click();
    await expect.poll(() => answerTo(page, "o-1")).not.toBeNull();

    const heads = page.locator("[data-row^='project:']");
    const started = page.getByTestId("started-session");
    await expect(started).toContainText("other");
    await expect(page.getByTestId("inactive-fold")).toHaveText(/1 project/);
    await started.click();
    await expect(page.locator(".session.kid")).toHaveClass(/on/);
    await expect(page.getByTestId("inactive-fold")).toHaveText(/1 project/);
    await expect(row(page, OTHER)).toHaveCount(0);
    await expect(heads.first()).toHaveAttribute("data-row", `project:${ORCHESTRATOR}`);
  });
});

// Short of room, a started row cuts its project first, then drops its
// model whole, and cuts its name last; its time and the accent's asking
// always stand in full.
for (const width of [300, 240, 180]) {
  test(`fits a started row into a pane ${width} pixels wide`, async ({ page }) => {
    const OTHER = "/home/ada/dev/other-project";
    await page.addInitScript((width) => {
      localStorage.setItem("workbench.layout", JSON.stringify({ sessions: width }));
    }, width);
    await installFakeCore(page, { open: [PROJECT, OTHER] });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await page.getByTestId("sessions-menu").click();
    await page.getByTestId("menu-orchestrator").click();
    await expect(page.locator(AGENT)).toContainText("running");
    const start = async (id: string, project: string, name: string) => {
      await push(page, {
        id,
        tool: "start",
        arguments: { project, prompt: "Go", name, agent: "claude-code", model: "sonnet" },
        session: "session-1",
      });
      const allow = page.getByTestId("conduct-allow");
      if (await allow.isVisible()) await allow.click();
      await expect.poll(() => answerTo(page, id)).not.toBeNull();
    };
    await start("o-1", OTHER, "Startup history scan");
    await start("o-2", PROJECT, "Palette check");
    await page.evaluate(() =>
      (
        window as unknown as { __sessionEvent: (event: { sessionId: string; kind: string }) => void }
      ).__sessionEvent({ sessionId: "session-2", kind: "permission" }),
    );
    await expect(page.getByTestId("started-asking")).toHaveText("asking");

    for (const started of await page.getByTestId("started-session").all()) {
      const row = (await started.boundingBox())!;
      const fit = (await started.locator(".fit").boundingBox())!;
      const shown = async (selector: string) => {
        const part = started.locator(selector);
        if ((await part.count()) === 0) return null;
        const box = (await part.boundingBox())!;
        return box.y < fit.y + fit.height - 1 && box.width > 0 ? part : null;
      };
      const whole = async (selector: string) => {
        const part = started.locator(selector);
        const box = (await part.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
        expect(await part.evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5)).toBe(true);
      };
      // The time, and asking, in full and inside the row.
      await whole(".when");
      if ((await started.getByTestId("started-asking").count()) > 0) await whole("[data-testid='started-asking']");
      // The model whole or not at all, never cut.
      const model = await shown("[data-testid='started-model']");
      if (model !== null) await whole("[data-testid='started-model']");
      // The name always shows, and is cut only once the rest has gone.
      const name = (await shown(".label"))!;
      expect(name).not.toBeNull();
      const cut = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 0.5);
      if (cut) {
        expect(model).toBeNull();
        expect(await shown(".where")).toBeNull();
      }
      // The project, when it shows, keeps a few letters.
      const where = await shown(".where");
      if (where !== null) expect((await where.boundingBox())!.width).toBeGreaterThan(14);
    }
    // At the default width there is room for the short one's model.
    if (width === 300) {
      const short = page.getByTestId("started-session").filter({ hasText: "Palette check" });
      const model = (await short.getByTestId("started-model").boundingBox())!;
      const fit = (await short.locator(".fit").boundingBox())!;
      expect(model.y).toBeLessThan(fit.y + fit.height - 1);
    }
  });
}
