import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * Where a workflow's run stands, on the orchestrator's header, on the rail
 * and on its started sessions' own headers, driven through a whole run by
 * calls pushed at the conductor and hook events for what each session is
 * doing.
 */

const AGENT = "section[data-pane='agent']";

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

const settingsWith = (workflow: typeof PLAN_WORK_REVIEW) => ({
  workflows: { list: [workflow], default: workflow.name, overrides: {} },
});

let calls = 0;

/** A call from the orchestrator, answered before this returns, with its
    answer. */
async function call(page: Page, tool: string, args: Record<string, unknown>, session = "session-1") {
  const id = `c-${++calls}`;
  await page.evaluate(
    ({ project, id, tool, args, session }) =>
      (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
        id,
        tool,
        arguments: args,
        cwd: project,
        session,
      }),
    { project: PROJECT, id, tool, args, session },
  );
  const ask = page.getByTestId("conduct-allow");
  await expect
    .poll(async () => {
      if (await ask.isVisible()) await ask.click();
      const answers =
        (await page.evaluate(() => (window as unknown as { __conductAnswers?: { id: string }[] }).__conductAnswers)) ?? [];
      return answers.some((answer) => answer.id === id);
    })
    .toBe(true);
  const answers = await page.evaluate(
    () => (window as unknown as { __conductAnswers: { id: string; content: string | null }[] }).__conductAnswers,
  );
  return answers.find((answer) => answer.id === id)!.content ?? "";
}

/** What a session's hooks say it is doing: prompt is at work, stop at rest. */
async function event(page: Page, session: string, kind: "prompt" | "stop" | "permission") {
  await page.evaluate(
    ({ session, kind }) =>
      (window as unknown as { __sessionEvent: (event: { sessionId: string; kind: string }) => void }).__sessionEvent({
        sessionId: session,
        kind,
      }),
    { session, kind },
  );
}

const chip = (page: Page) => page.getByTestId("run-chip");
const words = (page: Page) => page.getByTestId("run-words");
const pips = (page: Page) =>
  page.getByTestId("run-pips").evaluate((node) => [...node.children].map((pip) => pip.classList[0]));

async function begin(page: Page, workflow = PLAN_WORK_REVIEW) {
  calls = 0;
  await installFakeCore(page, { settings: settingsWith(workflow) });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(chip(page)).toBeVisible();
}

/** Narrows the agent pane step by step, checking the header gives way in
    turn: the chip's words with the gap before them and anything beside
    them in the head, and the title last, the pips always inside the
    pane. */
async function narrows(page: Page) {
  const state = () =>
    page.evaluate((AGENT) => {
      const header = document.querySelector(`${AGENT} header`)!;
      const title = header.querySelector<HTMLElement>(".title")!;
      const words = header.querySelector<HTMLElement>("[data-testid='run-words']")!;
      const pips = header.querySelector<HTMLElement>("[data-testid='run-pips']")!;
      const drawn = (el: HTMLElement | null) =>
        el !== null && getComputedStyle(el).visibility !== "hidden" && el.getBoundingClientRect().width > 0.5;
      const head = header.closest("section")!.getBoundingClientRect();
      const pipsBox = pips.getBoundingClientRect();
      const room = header.querySelector<HTMLElement>(".head")!.getBoundingClientRect();
      const chip = header.querySelector<HTMLElement>("[data-testid='run-chip']")!.getBoundingClientRect();
      return {
        slack: room.right - chip.right,
        titleCut: title.scrollWidth > title.clientWidth + 0.5,
        wordsDrawn: drawn(words),
        wordsCut: words.scrollWidth > words.clientWidth + 0.5,
        wordsWidth: words.getBoundingClientRect().width,
        pipsInside: pipsBox.width > 20 && pipsBox.right <= head.right - 8,
      };
    }, AGENT);
  const wide = await state();
  expect(wide).toMatchObject({ titleCut: false, wordsDrawn: true, wordsCut: false, pipsInside: true });
  // The pane narrowed under it.
  let sawWordsGone = false;
  for (const width of [380, 300, 240, 200, 150]) {
    await page.locator(AGENT).evaluate((pane, width) => {
      (pane as HTMLElement).style.flex = `0 0 ${width}px`;
      (pane as HTMLElement).style.width = `${width}px`;
      (pane as HTMLElement).style.minWidth = `${width}px`;
    }, width);
    await expect.poll(async () => (await page.locator(AGENT).boundingBox())!.width).toBeLessThan(width + 1);
    const at = await state();
    expect(at.pipsInside, `at ${width}`).toBe(true);
    // Gone, the words take no room from the title.
    if (at.titleCut) expect(at.wordsWidth, `at ${width}`).toBeLessThan(0.5);
    if (at.titleCut) expect(at.wordsDrawn, `at ${width}`).toBe(false);
    // Nor the gap before them: the head keeps no more than the chip.
    if (at.titleCut) expect(at.slack, `at ${width}`).toBeLessThan(1);
    if (!at.wordsDrawn) sawWordsGone = true;
  }
  expect(sawWordsGone).toBe(true);
}

test.describe("the run's chip", () => {
  test("follows a run from its plan to done", async ({ page }) => {
    await begin(page);
    // Nothing started: the workflow's name, every step to come.
    await expect(words(page)).toHaveText("Plan, work, review");
    expect(await pips(page)).toEqual(["todo", "todo", "todo"]);
    // Right after the title, in the place the quiet tag had.
    const title = (await page.locator(`${AGENT} header .title`).boundingBox())!;
    const box = (await chip(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(title.x + title.width);
    expect(box.x).toBeLessThan(title.x + title.width + 16);

    await call(page, "start", { project: PROJECT, prompt: "Plan it", step: "Plan", name: "Plan the startup fix" });
    await event(page, "session-2", "prompt");
    await expect(words(page)).toHaveText("Plan");
    expect(await pips(page)).toEqual(["live", "todo", "todo"]);

    await event(page, "session-2", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-3", "prompt");
    await expect(words(page)).toHaveText("Work");
    expect(await pips(page)).toEqual(["done", "live", "todo"]);

    await event(page, "session-3", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Review it", step: "Review", work: "session-3", name: "Review the cache fix" });
    await event(page, "session-4", "prompt");
    await expect(words(page)).toHaveText("Review, round 1 of 4");
    expect(await pips(page)).toEqual(["done", "done", "live"]);
    await expect(chip(page)).toHaveAttribute("aria-label", /Review, round 1 of 4\. Plan done, Work done, Review now\./);

    // Sent back: the work's second round, and the review to come again.
    await event(page, "session-4", "stop");
    await call(page, "send", { session: "session-3", text: "Make it smaller" });
    await event(page, "session-3", "prompt");
    await expect(words(page)).toHaveText("Work, round 2 of 4");
    expect(await pips(page)).toEqual(["done", "live", "todo"]);
    // The rail says the round short.
    const workRow = page.getByTestId("started-session").filter({ hasText: "Fix the cache" });
    await expect(workRow.getByTestId("started-role")).toHaveText("Work, 2 of 4");

    await event(page, "session-3", "stop");
    await call(page, "send", { session: "session-4", text: "Look again" });
    await event(page, "session-4", "prompt");
    await expect(words(page)).toHaveText("Review, round 2 of 4");
    const reviewRow = page.getByTestId("started-session").filter({ hasText: "Review the cache fix" });
    await expect(reviewRow.getByTestId("started-role")).toHaveText("Review, 2 of 4");

    // The review and the orchestrator at rest: every pip grey, and the
    // words say the round that finished. Whether it passed is not known.
    await event(page, "session-4", "stop");
    await event(page, "session-1", "stop");
    await expect(words(page)).toHaveText("Review, round 2 of 4 done");
    expect(await pips(page)).toEqual(["done", "done", "done"]);
    await expect(words(page)).not.toHaveText(/^Done/);
  });

  test("counts the pieces in each step, with the rounds in its popover", async ({ page }) => {
    await begin(page);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Review it", step: "Review", work: "session-2", name: "Review the cache fix" });
    await event(page, "session-3", "prompt");
    await call(page, "start", { project: PROJECT, prompt: "Filter", step: "Work", name: "Palette filter" });
    await event(page, "session-4", "prompt");
    await expect(words(page)).toHaveText("1 in Work, 1 in Review");
    expect(await pips(page)).toEqual(["done", "live", "live"]);

    await chip(page).click();
    const popover = page.getByTestId("run-popover");
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId("run-step")).toHaveText([
      /Plan\s*skipped/,
      /Work\s*done · Fix the cache\s*working · Palette filter/,
      /Review\s*round 1 of 4, working · Review the cache fix/,
    ]);
    // Under the chip and inside the pane.
    const box = (await chip(page).boundingBox())!;
    const pop = (await popover.boundingBox())!;
    const pane = (await page.locator(AGENT).boundingBox())!;
    expect(pop.y).toBeGreaterThanOrEqual(box.y + box.height);
    expect(pop.x + pop.width).toBeLessThanOrEqual(pane.x + pane.width);
    // The rules fold out at its foot.
    await expect(page.getByTestId("run-rules")).toHaveCount(0);
    await page.getByTestId("run-rules-toggle").click();
    await expect(page.getByTestId("run-rules")).toContainText('For the step "Work"');
    // A session's name opens it.
    await popover.getByTestId("run-open").filter({ hasText: "Palette filter" }).click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId("workflow-tag-role")).toHaveText("Work");
    await expect(page.getByTestId("workflow-tag-flow")).toHaveText("Plan, work, review·");
  });

  test("turns to the accent while another round waits on the user", async ({ page }) => {
    const once = structuredClone(PLAN_WORK_REVIEW);
    (once.steps[2] as { limit: number }).limit = 1;
    await begin(page, once);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Review it", step: "Review", work: "session-2" });
    await call(page, "start", { project: PROJECT, prompt: "Review again", step: "Review", work: "session-2" });
    const colour = () => chip(page).evaluate((node) => getComputedStyle(node).color);
    const quiet = await colour();
    // The third round is asked about, and the chip says so while it waits.
    await page.evaluate(
      ({ project }) =>
        (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
          id: "c-past",
          tool: "start",
          arguments: { project, prompt: "Once more", step: "Review", work: "session-2" },
          cwd: project,
          session: "session-1",
        }),
      { project: PROJECT },
    );
    await expect(page.getByTestId("conduct-round")).toBeVisible();
    await expect(words(page)).toHaveText("Round 2 of 2 done, asks you");
    expect(await pips(page)).toEqual(["done", "done", "live"]);
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent"));
    expect(await colour()).not.toBe(quiet);
    expect(accent.trim().length).toBeGreaterThan(0);
    // Stopped there by the user: said in the chip's own ink, the review's
    // pip lit, until another round of the piece goes ahead.
    await page.getByTestId("conduct-no").click();
    await expect(words(page)).toHaveText("Stopped at round 2 of 2");
    expect(await pips(page)).toEqual(["done", "done", "live"]);
    expect(await colour()).toBe(quiet);
    // The popover says the same of the review.
    await chip(page).click();
    await expect(page.getByTestId("run-step").nth(2)).toHaveText(/Review\s*round 2 of 2, stopped at the limit ·/);
  });

  test("says a round done only of a session seen at rest, after a restart too", async ({ page }) => {
    await begin(page);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "prompt");
    await event(page, "session-2", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Review it", step: "Review", work: "session-2", name: "Review the cache fix" });
    await event(page, "session-3", "prompt");
    // Closed by the user while at work: its round has not finished.
    const row = page.getByTestId("started-session").filter({ hasText: "Review the cache fix" });
    await row.hover();
    await row.locator("..").getByTestId("close-session").click();
    await expect(row).toHaveCount(0);
    await event(page, "session-1", "stop");
    await expect(words(page)).toHaveText("Review, round 1 of 4");
    expect(await pips(page)).toEqual(["done", "done", "live"]);
    await chip(page).click();
    await expect(page.getByTestId("run-step").nth(2)).toHaveText(/Review\s*round 1 of 4, ended · Review the cache fix/);
    await page.keyboard.press("Escape");

    // Another round seen to its rest is done, and still is once the app
    // comes back without its rows.
    await event(page, "session-1", "prompt");
    await call(page, "start", { project: PROJECT, prompt: "Review it again", step: "Review", work: "session-2", name: "Review again" });
    await event(page, "session-4", "prompt");
    await event(page, "session-4", "stop");
    await event(page, "session-1", "stop");
    await expect(words(page)).toHaveText("Review, round 2 of 4 done");
    await page.reload();
    await expect(words(page)).toHaveText("Review, round 2 of 4 done");
    expect(await pips(page)).toEqual(["done", "done", "done"]);
  });

  test("opens from the keyboard, names its state in words, and gives the keyboard back on Escape", async ({ page }) => {
    await begin(page);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "prompt");
    await expect(chip(page)).toHaveAttribute(
      "aria-label",
      "Plan, work, review: Work. Plan skipped, Work now, Review to come. Show where the run stands",
    );
    await expect(chip(page)).not.toHaveAttribute("aria-controls");
    // A stop of its own on Tab, as every control is.
    await expect(chip(page)).toHaveAttribute("tabindex", "0");
    await chip(page).focus();
    await page.keyboard.press("Enter");
    const popover = page.getByTestId("run-popover");
    await expect(popover).toBeVisible();
    await expect(chip(page)).toHaveAttribute("aria-expanded", "true");
    expect(await popover.getAttribute("id")).toBe(await chip(page).getAttribute("aria-controls"));
    // Tab goes on into the popover, and it stays open.
    await page.keyboard.press("Tab");
    await expect(popover.getByTestId("run-open").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
    // Shown while the pointer rests on it, and gone when it leaves.
    await chip(page).hover();
    await expect(popover).toBeVisible();
    const pane = (await page.locator(AGENT).boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 20);
    await expect(popover).toHaveCount(0);
    // A click on the one the pointer showed holds it, and a second puts it
    // away.
    await chip(page).hover();
    await expect(popover).toBeVisible();
    await chip(page).click();
    await expect(popover).toBeVisible();
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 20);
    await expect(popover).toBeVisible();
    await chip(page).click();
    await expect(popover).toHaveCount(0);
  });

  test("keeps its pips as the header narrows, its words going before the title is cut", async ({ page }) => {
    await begin(page);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "prompt");
    await call(page, "start", { project: PROJECT, prompt: "Filter", step: "Work", name: "Palette filter" });
    await event(page, "session-3", "prompt");
    await expect(words(page)).toHaveText("2 in Work");
    await narrows(page);
  });
});

test.describe("a started session's place", () => {
  test("says its round of the most in its own tag", async ({ page }) => {
    await begin(page);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Review it", step: "Review", work: "session-2", name: "Review the cache fix" });
    await page.getByTestId("started-session").filter({ hasText: "Review the cache fix" }).click();
    await expect(page.getByTestId("workflow-tag-role")).toHaveText("Review, round 1 of 4");
    // Its rules, shown by the pointer resting on the tag, are held by a
    // click.
    const tag = page.getByTestId("workflow-tag");
    const rules = page.getByTestId("workflow-rules");
    await tag.hover();
    await expect(rules).toBeVisible();
    await tag.click();
    const pane = (await page.locator(AGENT).boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 20);
    await expect(rules).toBeVisible();
    await tag.click();
    await expect(rules).toHaveCount(0);
  });
});

test.describe("an integrated orchestrator's thread", () => {
  /** Runs a script against the fake integrated agent, as `f`. */
  const agent = (page: Page, script: string) =>
    page.evaluate((script) => {
      const f = (window as unknown as { __integrated: unknown }).__integrated;
      new Function("f", script)(f);
    }, script);
  const ORCHESTRATOR = "integrated-session-1";

  /** A start the orchestrator makes in its turn: the tool call in the
      thread, the call the core delivers, and the call's answer. */
  async function started(page: Page, args: Record<string, unknown>) {
    await agent(
      page,
      `window.__startCall = f.startTool("int-1", "mcp__chord__start", ${JSON.stringify({ project: PROJECT, ...args })}, { kind: "mcp" });`,
    );
    const content = await call(page, "start", { project: PROJECT, ...args }, ORCHESTRATOR);
    await agent(page, `f.finishTool("int-1", window.__startCall, ${JSON.stringify(content)});`);
  }

  test("shows each started session's step, and its round with what it is doing", async ({ page }) => {
    calls = 0;
    await installFakeCore(page, {
      open: [PROJECT],
      settings: { ...settingsWith(PLAN_WORK_REVIEW), integrated: ["claude-code"] },
    });
    await page.goto("/");
    await page.getByTestId("start-agent").click();
    await expect(page.getByTestId("conversation")).toBeVisible();
    await page.getByTestId("composer-input").fill("Fix the flaky cache test");
    await page.keyboard.press("Enter");
    await expect(words(page)).toHaveText("Plan, work, review");
    await agent(page, `f.startTurn("int-1");`);

    await started(page, { prompt: "Fix the flaky cache test", step: "Work", name: "Fix the cache" });
    await agent(page, `f.startTurn("int-2"); f.endTurn("int-2");`);
    await started(page, { prompt: "Review the fix", step: "Review", work: "integrated-session-2", name: "Review the cache fix" });
    await agent(page, `f.startTurn("int-3");`);

    const thread = page.getByTestId("conversation");
    const rows = thread.getByTestId("started-session");
    await expect(rows).toHaveCount(2);
    // The step before the name, and the round, where there is one, with
    // what the session is doing.
    await expect(thread.getByTestId("started-step")).toHaveText(["Work", "Review"]);
    await expect(rows.nth(0)).toContainText("Fix the cache");
    await expect(rows.nth(1)).toContainText("Review the cache fix");
    await expect(rows.nth(1).getByTestId("started-state")).toHaveText("round 1 of 4, working");
    await expect(words(page)).toHaveText("Review, round 1 of 4");
    // The step stands in a column of its own: the names start level.
    const names = await rows.locator(".name").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().left));
    expect(Math.abs(names[0] - names[1])).toBeLessThan(1);

    // The review rests, and the work is sent back: its row says the round.
    await agent(page, `f.endTurn("int-3");`);
    await call(page, "send", { session: "integrated-session-2", text: "Make it smaller" }, ORCHESTRATOR);
    await agent(page, `f.startTurn("int-2");`);
    await expect(rows.nth(0).getByTestId("started-state")).toHaveText("round 2 of 4, working");
    await expect(words(page)).toHaveText("Work, round 2 of 4");
  });

  test("gives way in an integrated session's header, the title last", async ({ page }) => {
    await installFakeCore(page, {
      open: [PROJECT],
      settings: { ...settingsWith(PLAN_WORK_REVIEW), integrated: ["claude-code"] },
    });
    await page.goto("/");
    await page.getByTestId("start-agent").click();
    await expect(page.getByTestId("branch-readout")).toHaveText("main");
    // The header's chip comes with the first message.
    await page.getByTestId("composer-input").fill("Fix the flaky cache test");
    await page.keyboard.press("Enter");
    await expect(words(page)).toHaveText("Plan, work, review");
    await narrows(page);
  });
});
