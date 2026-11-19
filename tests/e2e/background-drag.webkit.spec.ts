import { expect, test, type Page } from "@playwright/test";
import { backgroundAtRest } from "./fake";
import { openDayOfWork } from "./dayOfWork";

/**
 * A measurement, not a check: how a dot dragged on the background picker's
 * pad keeps up in WebKit, the app's webview on macOS, in a workspace the
 * size of a day's work. Ten projects are open, with past sessions listed,
 * terminals full of coloured output and two conversations as long as real
 * ones kept for days. The first colour is dragged around the pad with the
 * mouse, a move at a time, and the numbers are logged; the test asserts
 * only that the drag repainted the window.
 *
 * Each move is timed from when the page takes it to the end of the frame
 * that shows it. A frame's style, layout and paint run straight after its
 * animation callbacks, so they are done by the first task after them: a
 * message posted from the callback, or the next move, whichever comes
 * first. A second drag over another path forces the style and then the
 * layout right after the handler, to say how much of a step each takes.
 * Every frame's start is recorded, and a gap longer than a frame counts
 * the frames it cost. The page's own animation callbacks are timed by
 * name, with the style and layout forced after them in the second drag.
 *
 * Knobs, read from the environment, for comparing one cost with another:
 *
 *   BG_DRAG_CARDS     the share the cards let through, 0.11 unless given;
 *   BG_DRAG_BARE=1    no terminals and no conversations, only the projects
 *                     and their rows;
 *   BG_DRAG_FREEZE    "sheet" holds the background's stylesheet as it was
 *                     when the drag began, so the window behind the picker
 *                     is never repainted; "image" hands back the first
 *                     image drawn at each size, so the gradient's image
 *                     never changes while the colours do;
 *   BG_DRAG_PACE      milliseconds from one move's start to the next, for
 *                     a hand's pace rather than as fast as the page takes
 *                     them; 0 unless given;
 *   BG_DRAG_CSS       a stylesheet laid over the page before the drag;
 *   BG_DRAG_FRONT     "terminal" brings a terminal in front for the drag,
 *                     rather than the last conversation opened.
 *
 * It runs only when BG_DRAG=1 is set, against a dev server of its own,
 * WebKit only, one worker: it is for reading numbers off, and the check
 * that a dragged colour leaves the background's sheet alone is in the
 * picker's own tests.
 */

const MOD = "ControlOrMeta";
const STEPS = 60;
const FRAME = 1000 / 60;

const cardsShare = Number(process.env.BG_DRAG_CARDS ?? "0.11");
const bare = process.env.BG_DRAG_BARE === "1";
const freeze = process.env.BG_DRAG_FREEZE ?? "";
const pace = Number(process.env.BG_DRAG_PACE ?? "0");
const css = process.env.BG_DRAG_CSS ?? "";
const front = process.env.BG_DRAG_FRONT === "terminal" ? "terminal" : "conversation";

const SETTINGS = {
  appearance: "dark",
  look: "modern",
  palette: "rose",
  backgrounds: {
    rose: {
      dots: [
        { hue: 350, chroma: 0.9 },
        { hue: 40, chroma: 0.9 },
        { hue: 300, chroma: 0.9 },
      ],
      harmony: "analogous",
      strength: 1,
      grain: 0.25,
    },
  },
  cards: cardsShare > 0 ? { rose: cardsShare } : {},
};

async function seed(page: Page) {
  await openDayOfWork(page, { settings: SETTINGS, bare });
  if (front === "terminal" && !bare) {
    const key = await page.getByTestId("terminal").first().getAttribute("data-session");
    await page.locator(`[data-row="session:${key}"]`).click({ timeout: 30_000 });
    await expect(page.locator(`[data-testid='terminal'][data-session='${key}']`)).not.toHaveClass(/hidden/);
  }
}

/** What the window holds, as measured: what the test asked for and what is
    on screen for the style to be worked out over. */
function census(page: Page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll("*");
    // An element with no box of its own is in a subtree out of layout, as a
    // conversation not in front is, and costs nothing to restyle.
    let laidOut = 0;
    for (const element of all) if ((element as HTMLElement).getClientRects().length > 0) laidOut++;
    const inside = (selector: string) =>
      [...document.querySelectorAll(selector)].reduce((sum, root) => sum + root.querySelectorAll("*").length + 1, 0);
    const fixed: string[] = [];
    for (const element of all) {
      if ((element as HTMLElement).getClientRects().length === 0) continue;
      if (!getComputedStyle(element).backgroundAttachment.includes("fixed")) continue;
      const html = element as HTMLElement;
      fixed.push(html.dataset.testid ?? html.dataset.pane ?? `${element.tagName.toLowerCase()}.${[...element.classList][0] ?? ""}`);
    }
    // The parts that take their colours from the background's properties,
    // as the background's stylesheet names them; whatever is inside one
    // inherits what they set.
    const TINTED = [
      "[data-pane='sessions']",
      "section[data-pane] > header",
      "[data-testid='settings'] > header",
      "[data-testid='settings'] nav",
      "[data-testid='status-bar']",
      "section[data-pane]:not([data-pane='sessions']) > .body",
      "[data-card]",
    ].join(", ");
    let underTint = 0;
    for (const element of all) {
      if ((element as HTMLElement).getClientRects().length > 0 && element.closest(TINTED) !== null) underTint++;
    }
    const sheet = document.getElementById("workbench-background")?.textContent ?? "";
    const urls = [...sheet.matchAll(/url\("([^"]*)"\)/g)].map((match) => match[1].length);
    return {
      projects: document.querySelectorAll("[data-testid='project-head']").length,
      sessionRows: document.querySelectorAll("[data-testid='session-row']").length,
      pastRows: document.querySelectorAll("[data-testid='past-session']").length,
      terminals: document.querySelectorAll("[data-testid='terminal']").length,
      domRendererTerminals: [...document.querySelectorAll("[data-testid='terminal']")].filter(
        (host) => host.querySelector("canvas") === null,
      ).length,
      conversations: document.querySelectorAll("[data-testid='conversation']").length,
      elements: all.length,
      laidOut,
      laidOutUnderTint: underTint,
      // Every rule the page's stylesheets hold, which a style resolver
      // built afresh collects again.
      rules: [...document.styleSheets].reduce((sum, sheet) => sum + sheet.cssRules.length, 0),
      inTerminals: inside("[data-testid='terminal']"),
      inActiveConversation: inside("[data-testid='conversation'].active"),
      inSessionsPane: inside("[data-pane='sessions']"),
      inSettings: inside("[data-testid='settings']"),
      fixedLayers: fixed.length,
      fixedOn: fixed,
      sheetLength: sheet.length,
      urlLengths: urls,
    };
  });
}

type Step = { stamp: number; start: number; handled: number; style: number; layout: number; frame: number };
type Frame = { at: number; now: number; done: number };
/** The page's own animation callbacks in one frame: how long they ran,
    and with `forced`, the style and layout worked out right after them. */
type Callback = { name: string; js: number; style: number; layout: number };
type Recorded = { steps: Step[]; frames: Frame[]; callbacks: Callback[] };

/** Records every move the page takes and every frame from here on: when
    the move was made, when the page began and finished handling it, and
    which frame came next; for each frame, when its animation callback ran
    and when a message posted from it arrived. With `forced`, the style and
    then the layout are worked out right after the handler, and timed. */
function record(page: Page, forced: boolean) {
  return page.evaluate((forced) => {
    const rec = { on: true, steps: [] as Step[], frames: [] as Frame[], callbacks: [] as Callback[] };
    (window as unknown as { __drag: typeof rec }).__drag = rec;
    // The page's own frame callbacks, such as the picker painting the step
    // a move left waiting, are timed; this recorder's own are not.
    const own = window.requestAnimationFrame.bind(window);
    const w = window as unknown as { __rafPlain?: typeof own };
    w.__rafPlain ??= own;
    const plain = w.__rafPlain;
    window.requestAnimationFrame = (callback) =>
      plain((at) => {
        const start = performance.now();
        callback(at);
        const ran = performance.now();
        if (!rec.on) return;
        let style = ran;
        let layout = ran;
        if (forced) {
          void getComputedStyle(document.documentElement).color;
          style = performance.now();
          void document.documentElement.offsetHeight;
          layout = performance.now();
        }
        rec.callbacks.push({ name: callback.name || "anonymous", js: ran - start, style: style - ran, layout: layout - style });
      });
    const take = (event: Event) => {
      if (!rec.on) return;
      rec.steps.push({ stamp: event.timeStamp, start: performance.now(), handled: 0, style: 0, layout: 0, frame: -1 });
    };
    const handled = () => {
      if (!rec.on) return;
      const step = rec.steps[rec.steps.length - 1];
      step.handled = performance.now();
      if (!forced) return;
      void getComputedStyle(document.documentElement).color;
      step.style = performance.now();
      void document.documentElement.offsetHeight;
      step.layout = performance.now();
    };
    addEventListener("pointermove", take, { capture: true });
    addEventListener("pointermove", handled);
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => (rec.frames[event.data as number].done = performance.now());
    const frame = (at: number) => {
      const index = rec.frames.push({ at, now: performance.now(), done: 0 }) - 1;
      for (let back = rec.steps.length - 1; back >= 0 && rec.steps[back].frame < 0; back--) rec.steps[back].frame = index;
      channel.port2.postMessage(index);
      if (rec.on) plain(frame);
      else {
        removeEventListener("pointermove", take, { capture: true });
        removeEventListener("pointermove", handled);
        window.requestAnimationFrame = plain;
      }
    };
    plain(frame);
  }, forced);
}

async function stopRecording(page: Page): Promise<Recorded> {
  // Two frames more, so the last move's frame is in.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(), 0))),
      ),
  );
  return page.evaluate(() => {
    const rec = (window as unknown as { __drag: Recorded & { on: boolean } }).__drag;
    rec.on = false;
    return { steps: rec.steps, frames: rec.frames, callbacks: rec.callbacks };
  });
}

const quantile = (values: number[], q: number) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const round = (value: number) => Math.round(value * 10) / 10;
const spread = (values: number[]) => ({
  median: round(quantile(values, 0.5)),
  p90: round(quantile(values, 0.9)),
  max: round(Math.max(...values)),
});

/** What the window is painted with: the background's stylesheet, and what
    a background being picked lays on the root over it. */
const painting = (page: Page) =>
  page.evaluate(
    () =>
      `${document.getElementById("workbench-background")?.textContent ?? ""}${document.documentElement.getAttribute("style") ?? ""}`,
  );

/** Drags the first dot around the pad, a move at a time, on a circle of
    `radius` radii, so each drag's colours are its own and nothing is
    drawn from what an earlier one kept. */
async function drag(page: Page, radius: number, forced: boolean) {
  const box = (await page.getByTestId("background-pad").boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2, r: box.width / 2 };
  const dot = (await page.getByTestId("background-dot").first().boundingBox())!;
  const from = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 };
  const startAngle = Math.atan2(from.y - centre.y, from.x - centre.x);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const before = await painting(page);
  await record(page, forced);
  const started = Date.now();
  for (let step = 1; step <= STEPS; step++) {
    const angle = startAngle + (step / STEPS) * Math.PI * 1.6;
    const r = centre.r * (radius + 0.05 * Math.sin((step / STEPS) * Math.PI));
    const due = started + step * pace;
    if (pace > 0 && Date.now() < due) await page.waitForTimeout(due - Date.now());
    await page.mouse.move(centre.x + Math.cos(angle) * r, centre.y + Math.sin(angle) * r);
  }
  const took = Date.now() - started;
  const recorded = await stopRecording(page);
  const after = await painting(page);
  await page.mouse.up();
  return { ...recorded, took, repainted: before !== after, sheetDuring: after.length };
}

function summarise(label: string, run: Awaited<ReturnType<typeof drag>>) {
  const { frames } = run;
  const steps = run.steps.filter((step) => step.frame >= 0);
  // A frame's style, layout and paint run straight after its animation
  // callbacks, in the same task, so they are done by the start of the
  // first task after it: the message posted from the callback, or the
  // next move taken, whichever came first.
  const doneAt = (index: number) => {
    const frame = frames[index];
    const next = run.steps.find((step) => step.start > frame.now);
    return Math.min(frame.done > 0 ? frame.done : Infinity, next?.start ?? Infinity);
  };
  const first = steps.length > 0 ? steps[0].start : frames[0].now;
  const last = steps.length > 0 ? doneAt(steps[steps.length - 1].frame) : frames[frames.length - 1].now;
  const during = frames.filter((frame) => frame.now >= first - FRAME && frame.now <= last + FRAME).map((frame) => frame.at);
  const gaps = during.slice(1).map((at, index) => at - during[index]);
  const long = gaps.filter((gap) => gap > FRAME * 1.05);
  const dropped = long.reduce((sum, gap) => sum + Math.max(0, Math.round(gap / FRAME) - 1), 0);
  // How many moves each frame took in.
  const perFrame = new Map<number, number>();
  for (const step of steps) perFrame.set(step.frame, (perFrame.get(step.frame) ?? 0) + 1);
  const counts = [...perFrame.values()];
  const result = {
    label,
    moves: run.steps.length,
    seconds: round(run.took / 1000),
    sheetDuring: run.sheetDuring,
    frames: during.length,
    framesWithMoves: counts.length,
    movesPerFrame: { one: counts.filter((n) => n === 1).length, more: counts.filter((n) => n > 1).length, most: Math.max(0, ...counts) },
    // From the page taking a move to the end of the frame that shows it.
    stepToPainted: spread(steps.map((step) => doneAt(step.frame) - step.start)),
    // From the move being made to the page taking it.
    queued: spread(steps.map((step) => step.start - step.stamp)),
    handler: spread(steps.map((step) => step.handled - step.start)),
    // From the frame's animation callback to the frame being done: its
    // style, layout and paint, less what was forced before it.
    frameWork: spread([...perFrame.keys()].map((index) => doneAt(index) - frames[index].now)),
    frameGaps: spread(gaps),
    longGaps: long.length,
    framesDropped: dropped,
    ...(run.steps.some((step) => step.style > 0)
      ? {
          style: spread(steps.map((step) => step.style - step.handled)),
          layout: spread(steps.map((step) => step.layout - step.style)),
        }
      : {}),
    // The page's own frame callbacks, and what was forced after them.
    ...(run.callbacks.length > 0
      ? {
          callbacks: run.callbacks.length,
          callbackJs: Object.fromEntries(
            [...new Set(run.callbacks.map((callback) => callback.name))].map((name) => {
              const own = run.callbacks.filter((callback) => callback.name === name);
              return [name, { count: own.length, ...spread(own.map((callback) => callback.js)) }];
            }),
          ),
          ...(run.callbacks.some((callback) => callback.style > 0)
            ? {
                callbackStyle: spread(run.callbacks.map((callback) => callback.style)),
                callbackLayout: spread(run.callbacks.map((callback) => callback.layout)),
              }
            : {}),
        }
      : {}),
  };
  console.log(`[background-drag] ${JSON.stringify(result)}`);
  return result;
}

test("a dot dragged on the pad, in a workspace the size of a day's work", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "a measurement of WebKit, the app's webview on macOS");
  test.skip(process.env.BG_DRAG !== "1", "a measurement, run when asked with BG_DRAG=1");
  test.setTimeout(600_000);
  await seed(page);
  if (freeze === "image") {
    await page.evaluate(() => {
      const first = new Map<string, string>();
      const draw = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, ...args: Parameters<typeof draw>) {
        const key = `${this.width}x${this.height}`;
        const known = first.get(key);
        if (known !== undefined) return known;
        const url = draw.apply(this, args);
        first.set(key, url);
        return url;
      };
    });
  }

  if (css !== "") {
    await page.evaluate((css) => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
    }, css);
  }

  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("background-picker")).toBeVisible();
  await page.getByTestId("background-pad").scrollIntoViewIfNeeded();
  await backgroundAtRest(page);
  if (freeze === "sheet") {
    await page.evaluate(() => {
      const sheet = document.getElementById("workbench-background")!;
      const held = sheet.textContent;
      Object.defineProperty(sheet, "textContent", { get: () => held, set: () => {}, configurable: true });
    });
  }
  // How often frames come with nothing to do, for the gaps below to be
  // read against: headless WebKit's frame clock need not run at 60 Hz.
  const idle = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const at: number[] = [];
        const frame = (now: number) => {
          at.push(now);
          if (at.length < 61) requestAnimationFrame(frame);
          else resolve(at.slice(1).map((now, index) => now - at[index]));
        };
        requestAnimationFrame(frame);
      }),
  );
  console.log(
    `[background-drag] ${JSON.stringify({ variant: { cards: cardsShare, bare, freeze, pace, css, front }, idleFrameGaps: spread(idle), census: await census(page) })}`,
  );

  // A first drag warms what a first move works out once; it is not counted.
  await drag(page, 0.5, false);
  await backgroundAtRest(page);

  const natural = await drag(page, 0.6, false);
  if (freeze !== "sheet") expect(natural.repainted).toBe(true);
  summarise("natural", natural);
  await backgroundAtRest(page);

  const forced = await drag(page, 0.7, true);
  summarise("forced", forced);
});
