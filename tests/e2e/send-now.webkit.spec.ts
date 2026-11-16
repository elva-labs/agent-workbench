import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// A message written while the agent works waits under the thread, and can
// be sent now or taken back, in WebKit as well as Chromium: WebKit is the
// app's webview on macOS, and it lays out and scrolls its own way.

const H = "int-1";
const SEND_NOW = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
const TAKE_BACK = process.platform === "darwin" ? "Meta+Shift+Enter" : "Control+Shift+Enter";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

function calls(page: Page): Promise<{ method: string; [field: string]: unknown }[]> {
  return page.evaluate(() => (window as unknown as { __integrated: { calls: { method: string }[] } }).__integrated.calls);
}

async function open(page: Page, options: { codex?: boolean; look?: "modern" | "terminal"; appearance?: "light" | "dark" } = {}) {
  await installFakeCore(page, {
    open: [PROJECT],
    ...(options.codex ? { agents: ["codex"], integrable: ["codex"] } : {}),
    settings: {
      integrated: [options.codex ? "codex" : "claude-code"],
      ...(options.look ? { look: options.look } : {}),
      ...(options.appearance ? { appearance: options.appearance } : {}),
    },
  });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("conversation")).toBeVisible();
}

const input = (page: Page) => page.getByTestId("composer-input");

/** Sends `text` from the composer. */
async function say(page: Page, text: string) {
  await input(page).fill(text);
  await page.keyboard.press("Enter");
}

/** A turn at work on a long command, with `waiting` sent behind it. */
async function busy(page: Page, ...waiting: string[]) {
  await say(page, "go");
  await agent(page, `f.startTurn("${H}"); f.startTool("${H}", "Bash", { command: "sleep 60" }, { kind: "command" });`);
  for (const text of waiting) await say(page, text);
  await expect(page.locator("[data-testid='user-message'][data-state='queued']")).toHaveCount(waiting.length);
}

const queued = (page: Page) => page.locator("[data-testid='user-message'][data-state='queued']");

/** Where the waiting messages and their lines stand against the thread
    and the composer. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-testid='thread']")!;
    const lines = [...document.querySelectorAll("[data-testid='message-waiting']")].map((line) => line.getBoundingClientRect());
    return {
      threadBottom: scroller.getBoundingClientRect().bottom,
      composerTop: document.querySelector("[data-testid='composer']")!.getBoundingClientRect().top,
      lastLineBottom: lines.at(-1)?.bottom ?? null,
      lastLineTop: lines.at(-1)?.top ?? null,
      fromFoot: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    };
  });

test("sends a waiting message now by interrupting Claude Code's turn, the line saying so", async ({ page }) => {
  await open(page);
  await busy(page, "and this");
  const send = page.getByTestId("send-now");
  await expect(send).toHaveAttribute("title", /^Sends this now: Claude takes it into the running turn, or stops the turn for it \(/);
  // The actions stand on the line under the message, after its words.
  const line = (await page.getByTestId("message-waiting").boundingBox())!;
  const box = (await send.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(line.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(line.y + line.height + 1);
  await send.click();
  await expect(page.getByTestId("turn-outcome").first()).toHaveText("Interrupted");
  await expect(page.getByTestId("user-message").filter({ hasText: "and this" })).toHaveAttribute("data-state", "taken");
  expect((await calls(page)).filter((call) => call.method === "sendNow")).toHaveLength(1);
  await expect(page.getByTestId("send-now")).toHaveCount(0);
});

test("offers send now once, under the last, and says it sends them all in order", async ({ page }) => {
  await open(page);
  await busy(page, "first", "second");
  await expect(page.getByTestId("send-now")).toHaveCount(1);
  await expect(queued(page).last().getByTestId("send-now")).toHaveCount(1);
  await expect(page.getByTestId("send-now")).toHaveAttribute("title", /^Sends the 2 waiting messages now, in order: Claude takes them/);
  // Each of the user's own can be taken back.
  await expect(page.getByTestId("take-back")).toHaveCount(2);
  await page.getByTestId("send-now").click();
  await expect(queued(page)).toHaveCount(0);
  const order = await page.getByTestId("user-message").allTextContents();
  expect(order.findIndex((text) => text.includes("first"))).toBeLessThan(order.findIndex((text) => text.includes("second")));
});

test("takes a waiting message back into the composer, with its words, and the thread lets it go", async ({ page }) => {
  await open(page);
  await busy(page, "a thought to finish");
  await page.getByTestId("take-back").click();
  await expect(queued(page)).toHaveCount(0);
  await expect(input(page)).toHaveValue("a thought to finish");
  await expect(input(page)).toBeFocused();
  expect((await calls(page)).find((call) => call.method === "withdraw")).toMatchObject({ id: H });
});

test("sends now and takes back from the composer by its chords, which its hint names", async ({ page }) => {
  await open(page);
  await busy(page, "one", "two");
  await expect(page.getByTestId("composer-now")).toHaveText(/sends them now, .* takes the newest back\./);
  await input(page).focus();
  await page.keyboard.press(TAKE_BACK);
  await expect(queued(page)).toHaveCount(1);
  await expect(input(page)).toHaveValue("two");
  // What came back is written again, and goes now with what waits.
  await expect(page.getByTestId("composer-now")).toHaveText(/sends this and what waits now, .* takes it back\./);
  await input(page).fill("");
  await expect(page.getByTestId("composer-now")).toHaveText(/sends it now, .* takes it back\./);
  await page.keyboard.press(SEND_NOW);
  await expect(queued(page)).toHaveCount(0);
  await expect(page.getByTestId("user-message").filter({ hasText: "one" })).toHaveAttribute("data-state", "taken");
  await expect(page.getByTestId("composer-now")).toHaveCount(0);
});

test("reaches send now and take back on the thread's arrow walk", async ({ page }) => {
  await open(page);
  await busy(page, "and this");
  // Up from the thread itself is the last thing in view.
  await page.getByTestId("thread").focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("take-back")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("send-now")).toBeFocused();
  // Home and End go to the first and the last, the last being under it.
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await expect(page.getByTestId("take-back")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(queued(page)).toHaveCount(0);
});

test("waits for a request to be answered before it can be sent now, and says so", async ({ page }) => {
  await open(page);
  await busy(page, "and this");
  await agent(page, `f.ask("${H}", "Bash", { command: "rm -rf build" });`);
  await expect(page.getByTestId("message-waiting")).toContainText("Waits for the turn. Answer the request below to send it now");
  await expect(page.getByTestId("send-now")).toHaveCount(0);
  await expect(page.getByTestId("take-back")).toHaveCount(1);
  await input(page).focus();
  await page.keyboard.press(SEND_NOW);
  expect((await calls(page)).some((call) => call.method === "sendNow")).toBe(false);
});

test("adds a waiting message to Codex's running turn without stopping it", async ({ page }) => {
  await open(page, { codex: true });
  await busy(page, "and this");
  await expect(page.getByTestId("send-now")).toHaveAttribute("title", /^Adds this to the running turn without stopping it \(/);
  await page.getByTestId("send-now").click();
  await expect(page.getByTestId("user-message").filter({ hasText: "and this" })).toHaveAttribute("data-state", "taken");
  // The turn goes on.
  await expect(page.getByTestId("stop")).toBeVisible();
  await expect(page.getByTestId("turn-outcome")).toHaveCount(0);
});

for (const look of ["modern", "terminal"] as const) {
  test(`keeps the waiting messages and their lines wholly above the composer at a long thread's foot, in the ${look} look`, async ({ page }) => {
    await open(page, { look });
    // Past the length at which the thread draws only the turns near the view.
    for (let turn = 0; turn < 45; turn++) {
      await say(page, `question ${turn}`);
      await agent(page, `f.turn("${H}", ${JSON.stringify(`Reply ${turn}. `.repeat(20))});`);
    }
    await say(page, "go");
    await agent(page, `f.startTurn("${H}"); f.startTool("${H}", "Bash", { command: "sleep 60" }, { kind: "command" });`);
    const texts = ["and this", "and a second one, long enough to run onto a second line in a narrower pane than this one is"];
    for (const [at, text] of texts.entries()) {
      // A press in the thread just before, as on its own buttons.
      await page.getByTestId("thread").click({ position: { x: 4, y: 4 } });
      await say(page, text);
      await expect(queued(page)).toHaveCount(at + 1);
      // In view as it comes: the line under the last wholly above the
      // composer, the thread at its foot.
      await expect
        .poll(async () => {
          const now = await geometry(page);
          return now.fromFoot < 1 && now.lastLineBottom! <= now.threadBottom && now.lastLineBottom! <= now.composerTop;
        })
        .toBe(true);
    }
    // The dock, coming under them, leaves them in view too.
    await agent(page, `f.ask("${H}", "Bash", { command: "ls" });`);
    await expect(page.getByTestId("permission-dock")).toBeVisible();
    await expect
      .poll(async () => {
        const now = await geometry(page);
        const dock = (await page.getByTestId("permission-dock").boundingBox())!;
        return now.fromFoot < 1 && now.lastLineBottom! <= now.threadBottom && now.lastLineBottom! <= dock.y;
      })
      .toBe(true);
  });
}

/** A long thread, drawn only near the view, in a smaller window, with a
    turn at work on a command, and the core's news of each message sent
    coming 600 ms after it, as over a slow route to another machine. */
async function slowLongThread(page: Page) {
  await page.setViewportSize({ width: 980, height: 720 });
  await open(page);
  for (let turn = 0; turn < 45; turn++) {
    await say(page, `question ${turn}`);
    await agent(page, `f.turn("${H}", ${JSON.stringify(`Reply ${turn}. `.repeat(20))});`);
  }
  await say(page, "go");
  await agent(page, `f.startTurn("${H}"); f.startTool("${H}", "Bash", { command: "sleep 60" }, { kind: "command" });`);
  await expect.poll(async () => (await geometry(page)).fromFoot).toBeLessThan(1);
  await agent(page, `const send = f.send.bind(f); f.send = (...args) => { setTimeout(() => send(...args), 600); };`);
}

/** The waiting line, wholly in view above the composer, or the way back
    down offered. */
const seenOrOffered = async (page: Page) => {
  const now = await geometry(page);
  const pill = await page.getByTestId("jump-latest").count();
  return pill > 0 || (now.lastLineBottom !== null && now.lastLineBottom <= now.threadBottom && now.lastLineBottom <= now.composerTop);
};

test("follows a message sent just after the wheel nudged the thread a little off its foot", async ({ page }) => {
  await slowLongThread(page);
  await page.getByTestId("thread").hover();
  await page.mouse.wheel(0, -20);
  await expect.poll(async () => (await geometry(page)).fromFoot).toBeGreaterThan(5);
  await say(page, "and this");
  await expect(queued(page)).toHaveCount(1);
  // Long enough for every move the thread makes of itself to have landed.
  await page.waitForTimeout(800);
  await expect.poll(() => seenOrOffered(page)).toBe(true);
  await expect.poll(async () => (await geometry(page)).fromFoot).toBeLessThan(1);
});

test("follows a message sent just before a click in the thread's gutter", async ({ page }) => {
  await slowLongThread(page);
  await say(page, "and this");
  await page.getByTestId("thread").click({ position: { x: 4, y: 200 } });
  await expect(queued(page)).toHaveCount(1);
  await page.waitForTimeout(800);
  await expect.poll(() => seenOrOffered(page)).toBe(true);
});

test("leaves a thread at its foot where a scroll nobody here made put it, as a screen reader does", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await open(page);
  // Long enough to scroll, short enough to be drawn whole.
  for (let turn = 0; turn < 12; turn++) {
    await say(page, `question ${turn}`);
    await agent(page, `f.turn("${H}", ${JSON.stringify(`Reply ${turn}. `.repeat(20))});`);
  }
  await expect.poll(async () => (await geometry(page)).fromFoot).toBeLessThan(1);
  // What stands just above the view, brought into it with no wheel, key
  // or touch, as a screen reader brings what it reads; then the frames in
  // which the thread hears of the scroll and would move back.
  await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>("[data-testid='thread']")!;
    const top = scroller.getBoundingClientRect().top;
    const above = [...scroller.querySelectorAll<HTMLElement>("p")].filter((p) => p.getBoundingClientRect().bottom < top);
    above.at(-1)!.dataset.read = "";
    above.at(-1)!.scrollIntoView({ block: "nearest" });
    for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
  });
  const read = (await page.locator("[data-read]").boundingBox())!;
  const view = (await page.getByTestId("thread").boundingBox())!;
  expect(read.y).toBeGreaterThanOrEqual(view.y - 1);
  expect(read.y + read.height).toBeLessThanOrEqual(view.y + view.height + 1);
});

test("brings a message that comes to wait into view just after a press in the thread", async ({ page }) => {
  await open(page);
  for (let turn = 0; turn < 10; turn++) {
    await say(page, `question ${turn}`);
    await agent(page, `f.turn("${H}", ${JSON.stringify(`Reply ${turn}. `.repeat(60))});`);
  }
  // Long enough to scroll, short enough to be drawn whole.
  expect(await page.getByTestId("thread").evaluate((node) => node.scrollHeight > 2 * node.clientHeight)).toBe(true);
  await say(page, "go");
  await agent(page, `f.startTurn("${H}"); f.startTool("${H}", "Bash", { command: "sleep 60" }, { kind: "command" });`);
  await expect.poll(async () => (await geometry(page)).fromFoot).toBeLessThan(1);
  // A message another session sent, heard as the user presses in the
  // thread, which the thread takes for a fold opened rather than news.
  await page.getByTestId("thread").dispatchEvent("pointerdown");
  await agent(
    page,
    `f.emit("${H}", { type: "message", message: "99999999-9999-4999-8999-999999999999", state: "queued", error: null, text: "From the lead: look at the tests too", images: [] });`,
  );
  await expect(queued(page)).toHaveCount(1);
  await expect
    .poll(async () => {
      const now = await geometry(page);
      return now.fromFoot < 1 && now.lastLineBottom! <= now.composerTop;
    })
    .toBe(true);
});

test("keeps the line of a message waiting in a resumed session above the composer", async ({ page }) => {
  const now = Date.now();
  await installFakeCore(page, {
    open: [PROJECT],
    settings: { integrated: ["claude-code"] },
    transcripts: [{ id: "past", modified: Math.floor(now / 1000) - 60, size: 100, title: "Question 1" }],
  });
  await page.addInitScript(
    ({ project }) => localStorage.setItem("workbench.mine", JSON.stringify({ [project]: ["past"] })),
    { project: PROJECT },
  );
  await page.goto("/");
  const items = Array.from({ length: 30 }, (_, at) => [
    { at: now - 3_600_000 + at * 60_000, event: { type: "message", message: `m-${at}`, state: "sent", error: null, text: `Question ${at}`, images: [] } },
    { at: now - 3_600_000 + at * 60_000, event: { type: "turnStarted", messages: [`m-${at}`] } },
    { at: now - 3_600_000 + at * 60_000, event: { type: "text", block: `b-${at}`, parent: null, text: `Reply ${at}. `.repeat(30), done: true } },
    { at: now - 3_600_000 + at * 60_000, event: { type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: 1000, usage: null } },
  ]).flat();
  await agent(page, `f.transcript("past", ${JSON.stringify(items)});`);
  await page.getByTestId("past-session").click();
  await say(page, "go on");
  await expect(page.getByTestId("run-began")).toBeVisible();
  await agent(page, `f.startTurn("${H}"); f.startTool("${H}", "Bash", { command: "sleep 60" }, { kind: "command" });`);
  await say(page, "and this");
  await expect(queued(page)).toHaveCount(1);
  await expect
    .poll(async () => {
      const now = await geometry(page);
      return now.fromFoot < 1 && now.lastLineBottom! <= now.threadBottom && now.lastLineBottom! <= now.composerTop;
    })
    .toBe(true);
  const at = await geometry(page);
  // The resumed-here line stands above the turn, in the thread.
  const began = (await page.getByTestId("run-began").boundingBox())!;
  expect(began.y + began.height).toBeLessThanOrEqual(at.lastLineTop!);
});

for (const appearance of ["light", "dark"] as const) {
  test(`draws the actions in the accent, on the line's own size, in ${appearance}`, async ({ page }) => {
    await open(page, { appearance });
    await busy(page, "and this");
    const drawn = await page.evaluate(() => {
      const line = document.querySelector("[data-testid='message-waiting']")!;
      const send = document.querySelector("[data-testid='send-now']")!;
      // The accent as the line's own place paints it.
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      line.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return {
        lineSize: getComputedStyle(line).fontSize,
        sendSize: getComputedStyle(send).fontSize,
        accent,
        send: getComputedStyle(send).color,
        lineColour: getComputedStyle(line).color,
      };
    });
    expect(drawn.sendSize).toBe(drawn.lineSize);
    expect(drawn.send).toBe(drawn.accent);
    expect(drawn.send).not.toBe(drawn.lineColour);
  });
}

test("sends what is written now, with what waits, on the chord", async ({ page }) => {
  await open(page);
  await busy(page, "first");
  await input(page).fill("and this, written after");
  await expect(page.getByTestId("composer-now")).toHaveText(/sends this and what waits now/);
  await page.keyboard.press(SEND_NOW);
  await expect(input(page)).toHaveValue("");
  await expect(page.getByTestId("user-message").filter({ hasText: "and this, written after" })).toHaveAttribute("data-state", "taken");
  await expect(page.getByTestId("user-message").filter({ hasText: "first" }).last()).toHaveAttribute("data-state", "taken");
  expect((await calls(page)).filter((call) => call.method === "sendNow")).toHaveLength(1);
});

test("puts the words back though the answer to taking them back is lost", async ({ page }) => {
  await open(page);
  await busy(page, "a thought to finish");
  await agent(page, `f.withdrawAnswer = "the agent did not answer in time";`);
  await page.getByTestId("take-back").click();
  await expect(queued(page)).toHaveCount(0);
  await expect(input(page)).toHaveValue("a thought to finish");
  // Nothing failed that the user needs to know of.
  await expect(page.getByTestId("composer-now")).not.toContainText("Not taken back");
});

test("says Codex's messages are on their way until Codex takes them", async ({ page }) => {
  await open(page, { codex: true });
  await busy(page, "and this");
  await agent(page, `f.holdSteers = true;`);
  await page.getByTestId("send-now").click();
  await expect(page.getByTestId("message-waiting")).toHaveText("Sending now");
  await expect(page.getByTestId("send-now")).toHaveCount(0);
  await expect(page.getByTestId("take-back")).toHaveCount(0);
  await agent(page, `f.releaseSteers();`);
  await expect(page.getByTestId("user-message").filter({ hasText: "and this" })).toHaveAttribute("data-state", "taken");
});

for (const look of ["modern", "terminal"] as const) {
  test(`keeps Send now and Take back together when the line wraps, in the ${look} look`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 720 });
    await open(page, { look });
    await busy(page, "first", "second");
    await agent(page, `f.ask("${H}", "Bash", { command: "ls" });`);
    await agent(page, `f.answer("${H}", f.events.findLast((e) => e.type === "permissionAsked").request, "allow");`);
    const lastLine = page.getByTestId("message-waiting").last();
    // The line is too long for one row at this width.
    const rows = await lastLine.evaluate((line) => line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight));
    expect(rows).toBeGreaterThan(1.5);
    const send = (await lastLine.getByTestId("send-now").boundingBox())!;
    const take = (await lastLine.getByTestId("take-back").boundingBox())!;
    expect(Math.abs(send.y - take.y)).toBeLessThan(2);
  });
}

