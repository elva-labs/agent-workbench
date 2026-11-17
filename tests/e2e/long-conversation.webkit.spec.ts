import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

// A conversation of hundreds of turns, in WebKit as well as Chromium:
// WebKit, the app's webview on macOS, scrolls and clamps its own way, and
// the thread draws only the turns near the view.

const H = "int-1";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

const fromFoot = (page: Page) =>
  page.getByTestId("thread").evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);

/** Turns the wheel over the thread `times` times by `delta`, and waits
    until the page is told the view landed where the wheel takes it.
    WebKit on Linux eases a wheel's scroll in over the frames after the
    wheel has turned, and a browser tells the page of a scroll at the frame
    after it moves: what is read before then is read mid-scroll. */
async function wheel(page: Page, delta: number, times = 1) {
  const view = page.getByTestId("thread");
  await view.hover();
  const from = await view.evaluate((node) => {
    const heard = node as HTMLElement & { told?: number };
    if (heard.told === undefined) node.addEventListener("scroll", () => (heard.told = node.scrollTop));
    heard.told = node.scrollTop;
    return node.scrollTop;
  });
  for (let step = 0; step < times; step++) await page.mouse.wheel(0, delta);
  await expect
    .poll(() => view.evaluate((node, to) => Math.abs((node as HTMLElement & { told?: number }).told! - to), from + delta * times))
    .toBeLessThan(1);
}

/** Marks what stands at the top of the view: the innermost block reaching
    into it from above. Answers how far below the top of the view it is. */
const markTop = (page: Page) =>
  page.getByTestId("thread").evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    node.querySelector("[data-mark]")?.removeAttribute("data-mark");
    let at: Element = node.querySelector("[data-testid='thread-rows']")!;
    for (;;) {
      const next = [...at.children].find((child) => {
        const box = child.getBoundingClientRect();
        return box.height > 0 && box.bottom > top;
      });
      if (next === undefined) break;
      at = next;
    }
    at.setAttribute("data-mark", "");
    return at.getBoundingClientRect().top - top;
  });

/** How far below the top of the view the marked block is now. */
const markedAt = (page: Page) =>
  page
    .getByTestId("thread")
    .evaluate((node) => node.querySelector("[data-mark]")!.getBoundingClientRect().top - node.getBoundingClientRect().top);

/** Switches the look as an edit to the settings file would, and with it
    the conversation's type size; first moves the view by `by` in the same
    task, so the thread is told of that scroll only after the rows moved. */
const switchLook = (page: Page, look: "modern" | "terminal", by = 0) =>
  page.evaluate(
    ({ key, look, by }) => {
      document.querySelector("[data-testid='thread']")!.scrollTop += by;
      const next = { ...JSON.parse(localStorage.getItem(key) ?? "{}"), look };
      localStorage.setItem(key, JSON.stringify(next));
      (window as unknown as { __settingsChanged: (settings: unknown) => void }).__settingsChanged({
        appearance: "system",
        look: "modern",
        palette: "teal",
        terminalFont: "system",
        interfaceFont: "system",
        keys: {},
        hooks: { everywhere: true, overrides: {} },
        themes: {},
        ...next,
      });
    },
    { key: SETTINGS_FILE, look, by },
  );

/** Whether the rows drawn cover the whole view, top to bottom. */
const covered = (page: Page) =>
  page.getByTestId("thread").evaluate((node) => {
    const view = node.getBoundingClientRect();
    const rows = [...node.querySelectorAll("[data-testid='thread-rows'] > [data-row]")].map((row) => row.getBoundingClientRect());
    return rows.some((row) => row.top <= view.top + 1) && rows.some((row) => row.bottom >= view.bottom - 1);
  });

test.describe("a long conversation", () => {
  const PAST = "past-long";
  const TURNS = 300;

  /** A past conversation of `TURNS` turns, each a question, two commands
      and a reply with a link; every seventh reply runs long, so the turns
      are of uneven height. */
  const long = (start: number) => {
    const items: unknown[] = [];
    let at = start;
    for (let turn = 1; turn <= TURNS; turn++) {
      const message = `m-${turn}`;
      items.push({ at, event: { type: "message", message, state: "sent", error: null, text: `Question ${turn}`, images: [] } });
      items.push({ at, event: { type: "turnStarted", messages: [message] } });
      for (const step of [1, 2]) {
        const call = `c-${turn}-${step}`;
        items.push({ at, event: { type: "toolStarted", call, parent: null, name: "Bash", kind: "command" } });
        items.push({ at, event: { type: "toolInput", call, parent: null, delta: null, input: { command: `ls part-${step}` }, truncated: false } });
        items.push({ at, event: { type: "toolFinished", call, parent: null, output: "a.ts\nb.ts", error: false, truncated: false, changes: [] } });
      }
      const more = turn % 7 === 0 ? Array.from({ length: 12 }, (_, line) => `\n\nMore on turn ${turn}, paragraph ${line}.`).join("") : "";
      const text = `Reply ${turn}, see [the notes](https://example.com/${turn}).${more}`;
      items.push({ at, event: { type: "text", block: `b-${turn}`, parent: null, text, done: true } });
      items.push({ at, event: { type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: 1000, usage: null } });
      at += 60_000;
    }
    return items;
  };

  async function openLong(page: Page) {
    const now = Date.now();
    await installFakeCore(page, {
      open: [PROJECT],
      settings: { integrated: ["claude-code"] },
      transcripts: [{ id: PAST, modified: Math.floor(now / 1000) - 60, size: 100, title: "Question 1" }],
    });
    await page.addInitScript(
      ({ project, past }) => localStorage.setItem("workbench.mine", JSON.stringify({ [project]: [past] })),
      { project: PROJECT, past: PAST },
    );
    await page.goto("/");
    await agent(page, `f.transcript("${PAST}", ${JSON.stringify(long(now - TURNS * 60_000 - 3_600_000))});`);
    await page.getByTestId("past-session").click();
    await expect(page.getByTestId("agent-text").last()).toContainText(`Reply ${TURNS},`);
  }

  /** The turn of the message or run the keyboard is in. */
  const focusedTurn = (page: Page) =>
    page.evaluate(() => {
      const at = document.activeElement;
      const run = at?.closest<HTMLElement>("[data-testid='agent-run']");
      if (run) return run.dataset.turn ?? null;
      return at?.closest("[data-testid='user-message']")?.textContent?.match(/Question (\d+)/)?.[1] ?? null;
    });

  /** How many stops the arrows make in one turn: those of the first
      question and the first run. */
  const stopsPerTurn = (page: Page) =>
    page.evaluate(() => {
      const [question, run] = [...document.querySelectorAll<HTMLElement>("[data-testid='thread-rows'] > [data-row]")];
      return [question, run]
        .flatMap((row) => [...row.querySelectorAll<HTMLElement>("[data-thread-item], a[href]")])
        .filter((item) => item.getClientRects().length > 0).length;
    });

  const thread = (page: Page) => page.getByTestId("thread");

  test("opens at its foot and draws only the turns near the view", async ({ page }) => {
    await openLong(page);
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await expect(page.getByTestId("agent-text").last()).toBeInViewport();
    // A screen's worth and a little either side, not three hundred turns.
    expect(await page.getByTestId("agent-run").count()).toBeLessThan(40);
    await expect(thread(page).getByText("Question 1", { exact: true })).toHaveCount(0);
    // The thread is as tall as all of it, so the scrollbar says where the
    // view is in the whole conversation.
    const tall = await thread(page).evaluate((node) => node.scrollHeight / node.clientHeight);
    expect(tall).toBeGreaterThan(TURNS / 10);
  });

  test("keeps what the reader looks at in place while the turns above it are drawn", async ({ page }) => {
    await openLong(page);
    await thread(page).hover();
    for (let step = 0; step < 12; step++) {
      const word = (await page.getByTestId("user-message").first().locator(".bubble").textContent())!.trim();
      const same = page.getByText(word, { exact: true });
      const before = (await same.boundingBox())!.y;
      await page.mouse.wheel(0, -400);
      // The same words, moved by what the wheel moved and no more, however
      // tall the turns drawn above turned out to be.
      await expect.poll(async () => Math.abs((await same.boundingBox())!.y - before - 400)).toBeLessThan(1.5);
    }
    await expect(page.getByTestId("jump-latest")).toHaveCount(0);
  });

  test("walks to the first and the last with Home and End, and past what is drawn with the arrows", async ({ page }) => {
    await openLong(page);
    await page.getByTestId("work-line").last().focus();
    await page.keyboard.press("Home");
    await expect.poll(() => focusedTurn(page)).toBe("1");
    const first = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
    await expect(page.locator(":focus")).toBeInViewport();
    await expect(page.getByText(`Reply ${TURNS},`)).toHaveCount(0);
    // Twenty turns' worth of steps down is the same stop of turn 21, well
    // past what was drawn at the top.
    const steps = 20 * (await stopsPerTurn(page));
    for (let step = 0; step < steps; step++) await page.keyboard.press("ArrowDown");
    await expect.poll(() => focusedTurn(page)).toBe("21");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null)).toBe(first);
    await expect(page.locator(":focus")).toBeInViewport();
    for (let step = 0; step < steps; step++) await page.keyboard.press("ArrowUp");
    await expect.poll(() => focusedTurn(page)).toBe("1");
    await page.keyboard.press("End");
    await expect.poll(() => focusedTurn(page)).toBe(String(TURNS));
    await expect(page.locator(":focus")).toBeInViewport();
    await expect(thread(page).getByText("Question 1", { exact: true })).toHaveCount(0);
  });

  test("keeps a fold open while it is out of view", async ({ page }) => {
    await openLong(page);
    await page.getByTestId("work-line").last().focus();
    await page.keyboard.press("Home");
    await expect.poll(() => focusedTurn(page)).toBe("1");
    const first = page.getByTestId("agent-run").filter({ has: page.getByText("Reply 1,") }).getByTestId("work-line");
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("End");
    await expect.poll(() => focusedTurn(page)).toBe(String(TURNS));
    await expect(page.getByText("Reply 1,")).toHaveCount(0);
    await page.keyboard.press("Home");
    await expect(first).toHaveAttribute("aria-expanded", "true");
    const run = page.getByTestId("agent-run").filter({ has: page.getByText("Reply 1,") });
    await expect(run.getByTestId("step")).toHaveCount(2);
    // Drawn again, its Copy copies what it said.
    await run.getByTestId("copy-reply").click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? []))
      .toEqual(["Reply 1, see [the notes](https://example.com/1)."]);
  });

  test("keeps what is selected drawn while the reader scrolls away from it", async ({ page }) => {
    await openLong(page);
    const last = page.getByTestId("agent-text").last();
    await last.evaluate((node) => document.getSelection()!.selectAllChildren(node));
    // Six screens up, where the foot would no longer be drawn.
    await wheel(page, -900, 6);
    await expect.poll(() => fromFoot(page)).toBeGreaterThan(4000);
    await expect(last).not.toBeInViewport();
    await expect(page.getByText(`Reply ${TURNS},`)).toHaveCount(1);
    expect(await page.evaluate(() => document.getSelection()!.toString())).toContain(`Reply ${TURNS},`);
    // Let go, the foot is drawn no more.
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    await page.mouse.wheel(0, -10);
    await expect(page.getByText(`Reply ${TURNS},`)).toHaveCount(0);
  });

  test("follows a reply streaming at its foot and draws no more for it", async ({ page }) => {
    await openLong(page);
    const drawn = await page.getByTestId("thread-rows").locator(":scope > [data-row]").count();
    await page.getByTestId("composer-input").fill("And one more");
    await page.keyboard.press("Enter");
    await agent(page, `f.startTurn("${H}");`);
    for (let at = 0; at < 20; at++)
      await agent(page, `f.emit("${H}", { type: "text", block: "streamed", parent: null, text: "Streaming paragraph ${at}, long enough to wrap onto a line of its own as it comes in.\\n\\n", done: false });`);
    await expect(page.getByTestId("agent-text").last()).toContainText("Streaming paragraph 19");
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    expect(await page.getByTestId("thread-rows").locator(":scope > [data-row]").count()).toBeLessThanOrEqual(drawn + 2);
    // Scrolled up, it stays where the reader is while the reply goes on.
    await wheel(page, -3000);
    const before = await markTop(page);
    await agent(page, `f.emit("${H}", { type: "text", block: "streamed", parent: null, text: "One more paragraph.\\n\\n", done: false });`);
    await expect(page.getByTestId("jump-latest")).toBeVisible();
    expect(Math.abs((await markedAt(page)) - before)).toBeLessThan(1);
  });

  test("draws the turns around the view wherever the view is moved to, not only by the user", async ({ page }) => {
    await openLong(page);
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    // As a screen reader's cursor, a find bar or a drag of a selection
    // would move it, which the thread does not hear as the user scrolling.
    await thread(page).evaluate((node) => (node.scrollTop = node.scrollHeight / 2));
    await expect.poll(() => covered(page)).toBe(true);
    await expect.poll(() => fromFoot(page)).toBeGreaterThan(5000);
    await expect(page.getByText(`Reply ${TURNS},`)).toHaveCount(0);
  });

  test("goes to the first and the last with Home and End on the thread itself", async ({ page }) => {
    await openLong(page);
    await thread(page).focus();
    await page.keyboard.press("Home");
    await expect.poll(() => thread(page).evaluate((node) => node.scrollTop)).toBe(0);
    await expect(thread(page).getByText("Question 1", { exact: true })).toBeInViewport();
    await expect(thread(page)).toBeFocused();
    await page.keyboard.press("End");
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await expect(page.getByText(`Reply ${TURNS},`)).toBeInViewport();
    // At the foot, it follows what comes.
    await agent(page, `f.turn("${H}", "One more reply, at the foot.");`);
    await expect(thread(page).getByText("One more reply, at the foot.")).toBeInViewport();
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
  });

  test("tells a screen reader what comes, never the turns drawn as the reader scrolls", async ({ page }) => {
    await openLong(page);
    await expect(thread(page)).toHaveAttribute("aria-live", "off");
    const said = page.getByTestId("thread-said");
    await expect(said).toHaveAttribute("aria-live", "polite");
    await wheel(page, -900, 5);
    await expect.poll(() => fromFoot(page)).toBeGreaterThan(3000);
    await expect(said).toHaveText("");
    await page.getByTestId("composer-input").fill("And one more");
    await page.keyboard.press("Enter");
    await agent(page, `f.turn("${H}", "A **new** reply.");`);
    await expect(said).toContainText("A new reply.");
  });

  test("keeps the keyboard on its item while the view goes elsewhere", async ({ page, browserName }) => {
    await openLong(page);
    const last = page.getByTestId("work-line").last();
    await last.focus();
    await expect.poll(() => focusedTurn(page)).toBe(String(TURNS));
    await wheel(page, -700, 10);
    await expect.poll(() => fromFoot(page)).toBeGreaterThan(5000);
    await expect(last).toBeFocused();
    // The walk goes on from it, not from where the view is.
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => focusedTurn(page)).toBe(String(TURNS));
    // WebKit puts the view back where the wheel left it after the thread
    // scrolls to the item; the item keeps the keyboard there all the same.
    if (browserName !== "webkit") await expect(page.locator(":focus")).toBeInViewport();
  });

  test("keeps the line read in place when the type size changes", async ({ page }) => {
    await openLong(page);
    await wheel(page, -600, 6);
    await expect.poll(() => fromFoot(page)).toBeGreaterThan(3000);
    const rows = page.getByTestId("thread-rows");
    await expect(rows).toHaveCSS("font-size", "13.5px");
    const before = await markTop(page);
    // The terminal look sets the conversation's type a size smaller.
    await switchLook(page, "terminal");
    await expect(rows).toHaveCSS("font-size", "12.5px");
    await expect.poll(async () => Math.abs((await markedAt(page)) - before)).toBeLessThan(2);
    // The type changing in the frame the view moves, as a font or a width
    // can come in during a fling: the block moves with the view and by
    // nothing else. The line read is what stands at the top of the view
    // now: the smaller type can have taken the block marked before wholly
    // above it.
    const held = await markTop(page);
    await switchLook(page, "modern", -200);
    await expect(rows).toHaveCSS("font-size", "13.5px");
    await expect.poll(async () => Math.abs((await markedAt(page)) - held - 200)).toBeLessThan(2);
  });
});
