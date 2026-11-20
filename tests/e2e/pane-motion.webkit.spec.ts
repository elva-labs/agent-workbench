import { expect, test, type Page } from "@playwright/test";
import { PROJECT } from "./fake";
import { openDayOfWork } from "./dayOfWork";

/**
 * A measurement, not a check: how the panes' motions keep to the display's
 * rate in WebKit, the app's webview on macOS, in a workspace the size of a
 * day's work with a changes tree of a few thousand files and a long
 * conversation on screen. Each motion is started by its key or click, and
 * every frame from then until a few frames after the panes have stopped is
 * recorded and logged; the test asserts only that each motion happened.
 *
 * The motions, in order: the changes pane closed and opened by its toggle,
 * a file opened in the viewer and the viewer closed, the sessions pane
 * folded and opened, the terminal panel opened for the first time, closed,
 * opened a second time and closed, and the window flipped to Editor and
 * back to Agent.
 *
 * For each frame it logs how long after the one before it began, how long
 * the frame took from its start to the end of its style, layout and paint
 * (a message posted from its animation callback arrives once they are
 * done), how long the page's own animation callbacks and the work they set
 * off took, and how long resize observers took. The input's own task, the
 * handler and everything it mounted or unmounted, is timed apart, and with
 * PANE_MOTION_FORCED=1 the style and layout it left are worked out at its
 * end and timed too, as are the style and layout after each animation
 * callback. A gap longer than a frame counts the frames it cost.
 *
 * Knobs, read from the environment:
 *
 *   PANE_MOTION_FILES   how many changed files the tree holds, 3000 unless
 *                       given;
 *   PANE_MOTION_BARE=1  no terminals and no conversations;
 *   PANE_MOTION_ONLY    a comma-separated list of the motions to log;
 *   PANE_MOTION_FRAMES=1 logs each motion's frames one by one;
 *   PANE_MOTION_CSS     a stylesheet laid over the page before the motions.
 *
 * It runs only when PANE_MOTION=1 is set, against a dev server of its own,
 * WebKit only, one worker:
 *
 *   PANE_MOTION=1 CHORD_DEV_PORT=14538 npx playwright test tests/e2e/pane-motion.webkit.spec.ts --project webkit --workers 1
 */

const MOD = "ControlOrMeta";
const FRAME = 1000 / 60;

const fileCount = Number(process.env.PANE_MOTION_FILES ?? "3000");
const bare = process.env.PANE_MOTION_BARE === "1";
const forced = process.env.PANE_MOTION_FORCED === "1";
const only = (process.env.PANE_MOTION_ONLY ?? "").split(",").filter((name) => name !== "");
const perFrame = process.env.PANE_MOTION_FRAMES === "1";
const css = process.env.PANE_MOTION_CSS ?? "";

const FILES: string[] = [];
for (let area = 0; fileCount > FILES.length; area++)
  for (let part = 0; part < 10; part++)
    for (let file = 0; file < 10 && FILES.length < fileCount; file++)
      FILES.push(`src/area${area}/part${part}/file${area}-${part}-${file}.ts`);

const SETTINGS = { appearance: "dark", look: "modern" };

/** Times the page's animation callbacks and resize observers from the
    start, with the work each sets off before the next task; nothing is
    counted until a recording is on. */
function instrument() {
  const rec = { on: false, forced: false, js: 0, ro: 0, style: 0, layout: 0 };
  const w = window as unknown as { __motion: typeof rec; __rafPlain: typeof requestAnimationFrame };
  w.__motion = rec;
  const plain = window.requestAnimationFrame.bind(window);
  w.__rafPlain = plain;
  window.requestAnimationFrame = (callback) =>
    plain((at) => {
      if (!rec.on) return callback(at);
      const start = performance.now();
      callback(at);
      const ran = performance.now();
      rec.js += ran - start;
      // Effects the callback set off flush in a microtask queued before
      // this one.
      queueMicrotask(() => {
        const flushed = performance.now();
        rec.js += flushed - ran;
        if (!rec.forced) return;
        void getComputedStyle(document.documentElement).color;
        const styled = performance.now();
        void document.documentElement.offsetHeight;
        rec.style += styled - flushed;
        rec.layout += performance.now() - styled;
      });
    });
  const Observer = window.ResizeObserver;
  window.ResizeObserver = class extends Observer {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        if (!rec.on) return callback(entries, observer);
        const start = performance.now();
        callback(entries, observer);
        const ran = performance.now();
        rec.ro += ran - start;
        queueMicrotask(() => (rec.ro += performance.now() - ran));
      });
    }
  };
}

type Frame = { at: number; now: number; done: number; js: number; ro: number; style: number; layout: number; shape: string };
type Input = { start: number; handled: number; style: number; layout: number; done: number };
type Recorded = { frames: Frame[]; input: Input | null };

/** Starts recording every frame, and the next key or click the page takes. */
function record(page: Page) {
  return page.evaluate((forced) => {
    const w = window as unknown as {
      __motion: { on: boolean; forced: boolean; js: number; ro: number; style: number; layout: number };
      __rafPlain: typeof requestAnimationFrame;
      __recorded: Recorded & { stop: () => void };
    };
    const rec = w.__motion;
    const plain = w.__rafPlain;
    const frames: Frame[] = [];
    let input: Input | null = null;
    // What moves: the columns, the terminal panel's height, the mode, and
    // which panes are in the page.
    const shape = () => {
      const shell = document.querySelector<HTMLElement>("main.shell");
      const group = document.querySelector<HTMLElement>(".terminal-group");
      return [
        shell?.style.gridTemplateColumns,
        group?.style.height,
        shell?.dataset.mode,
        document.querySelector("section[data-pane='changes']") !== null,
        document.querySelector("[data-testid='viewer']") !== null,
      ].join("|");
    };
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      const frame = frames[event.data as number];
      frame.done = performance.now();
      frame.js = rec.js;
      frame.ro = rec.ro;
      frame.style = rec.style;
      frame.layout = rec.layout;
      frame.shape = shape();
      rec.js = 0;
      rec.ro = 0;
      rec.style = 0;
      rec.layout = 0;
    };
    const frame = (at: number) => {
      const index = frames.push({ at, now: performance.now(), done: 0, js: 0, ro: 0, style: 0, layout: 0, shape: "" }) - 1;
      channel.port2.postMessage(index);
      if (rec.on) plain(frame);
    };
    const taken = () => {
      if (input !== null || !rec.on) return;
      input = { start: performance.now(), handled: 0, style: 0, layout: 0, done: 0 };
      const ping = new MessageChannel();
      ping.port1.onmessage = () => (input!.done = performance.now());
      ping.port2.postMessage(0);
    };
    // After the page's own handlers and the effects they flushed.
    const handled = () => {
      if (input === null || input.handled > 0) return;
      input.handled = performance.now();
      if (!forced) return;
      void getComputedStyle(document.documentElement).color;
      input.style = performance.now();
      void document.documentElement.offsetHeight;
      input.layout = performance.now();
    };
    for (const type of ["keydown", "click"]) {
      addEventListener(type, taken, { capture: true });
      addEventListener(type, handled);
    }
    rec.on = true;
    rec.forced = forced;
    rec.js = 0;
    rec.ro = 0;
    rec.style = 0;
    rec.layout = 0;
    plain(frame);
    w.__recorded = {
      frames,
      get input() {
        return input;
      },
      stop: () => {
        rec.on = false;
        rec.forced = false;
        for (const type of ["keydown", "click"]) {
          removeEventListener(type, taken, { capture: true });
          removeEventListener(type, handled);
        }
      },
    } as Recorded & { stop: () => void };
  }, forced);
}

/** Waits until the shape has held still for a quarter of a second after the
    input, then stops recording. */
async function stop(page: Page): Promise<Recorded> {
  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __recorded: Recorded }).__recorded;
      const input = r.input;
      if (input === null) return false;
      const after = r.frames.filter((frame) => frame.done > 0 && frame.at >= input.start - 20);
      if (after.length < 4) return false;
      const last = after[after.length - 1];
      const changed = after.findLastIndex((frame, at) => at > 0 && frame.shape !== after[at - 1].shape);
      const since = changed < 0 ? after[0].at : after[changed].at;
      return last.at - since > 250;
    },
    undefined,
    { timeout: 30_000, polling: 50 },
  );
  return page.evaluate(() => {
    const r = (window as unknown as { __recorded: Recorded & { stop: () => void } }).__recorded;
    r.stop();
    return { frames: r.frames.filter((frame) => frame.done > 0), input: r.input };
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
  max: round(values.length === 0 ? NaN : Math.max(...values)),
});

/** The motion's frames: from the first frame after the input to three
    frames after the last one whose shape changed, the settling included. */
function summarise(motion: string, { frames, input }: Recorded) {
  expect(input, `${motion}: the input was taken`).not.toBeNull();
  const from = frames.findIndex((frame) => frame.at >= input!.start);
  const before = frames[from - 1]?.shape;
  let last = -1;
  for (let at = Math.max(from, 1); at < frames.length; at++) if (frames[at].shape !== frames[at - 1].shape) last = at;
  expect(last, `${motion}: the panes moved`).toBeGreaterThanOrEqual(from);
  const span = frames.slice(from, Math.min(frames.length, last + 4));
  // Each frame's gap from the one before, the first from the input.
  const gaps = span.map((frame, at) => frame.at - (at === 0 ? input!.start : span[at - 1].at));
  const work = span.map((frame) => frame.done - frame.at);
  const dropped = gaps.slice(1).reduce((sum, gap) => sum + Math.max(0, Math.round(gap / FRAME) - 1), 0);
  const shapes = new Set(span.map((frame) => frame.shape)).size - (span[0].shape === before ? 1 : 0);
  const result = {
    motion,
    // From the input to the end of the first frame drawn after it.
    toFirstFrame: round(span[0].done - input!.start),
    // The input's own task: its handlers and the effects they flushed,
    // and with PANE_MOTION_FORCED the style and layout they left.
    handler: round(input!.handled - input!.start),
    ...(forced ? { handlerStyle: round(input!.style - input!.handled), handlerLayout: round(input!.layout - input!.style) } : {}),
    task: round(input!.done - input!.start),
    frames: span.length,
    steps: shapes,
    ms: round(span[span.length - 1].done - input!.start),
    gaps: spread(gaps.slice(1)),
    longestFrame: round(Math.max(...work)),
    framesDropped: dropped,
    work: spread(work),
    js: spread(span.map((frame) => frame.js)),
    ro: spread(span.map((frame) => frame.ro)),
    ...(perFrame
      ? {
          // Gap, whole frame, the page's callbacks, resize observers, and
          // with PANE_MOTION_FORCED the style and layout after the callbacks.
          each: span.map((frame, at) =>
            [gaps[at], work[at], frame.js, frame.ro, ...(forced ? [frame.style, frame.layout] : [])].map(round),
          ),
        }
      : {}),
  };
  if (only.length === 0 || only.includes(motion)) console.log(`[pane-motion] ${JSON.stringify(result)}`);
  return result;
}

async function motion(page: Page, name: string, act: () => Promise<void>) {
  await settle(page);
  await record(page);
  await act();
  return summarise(name, await stop(page));
}

/** Two quiet frames and an idle moment, so one motion's settling is not
    counted in the next. */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(), 300))),
      ),
  );
}

test("the panes' motions, in a workspace the size of a day's work", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "a measurement of WebKit, the app's webview on macOS");
  test.skip(process.env.PANE_MOTION !== "1", "a measurement, run when asked with PANE_MOTION=1");
  test.setTimeout(600_000);

  await page.addInitScript(instrument);
  await openDayOfWork(page, {
    settings: SETTINGS,
    bare,
    fixture: {
      files: FILES,
      status: FILES.map((path) => ({ path, status: "M", add: 30, del: 12, binary: false })),
    },
  });
  // A diff of a real file's length in the viewer.
  await page.evaluate(() => {
    const core = (window as unknown as { __CHORD_CORE__: Record<string, unknown> }).__CHORD_CORE__;
    const lines: { kind: string; text: string; old: number | null; new: number | null }[] = [];
    for (let hunk = 0; hunk < 12; hunk++) {
      lines.push({ kind: "hunk", text: `@@ -${hunk * 40 + 1},30 +${hunk * 40 + 1},34 @@`, old: null, new: null });
      for (let line = 0; line < 34; line++) {
        const n = hunk * 40 + line + 1;
        const kind = line % 9 === 3 ? "del" : line % 7 === 2 ? "add" : "ctx";
        const text = `  const value${n} = compute(${n}, options.${["width", "height", "depth"][n % 3]}) // a line of ordinary code`;
        lines.push({ kind, text, old: kind === "add" ? null : n, new: kind === "del" ? null : n });
      }
    }
    core.gitDiff = async () => ({ lines, binary: false, truncated: false });
  });
  if (css !== "") {
    await page.evaluate((css) => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
    }, css);
  }
  const tree = page.locator("[data-testid='file-tree']");
  await expect.poll(() => tree.locator("[role='treeitem']").count(), { timeout: 30_000 }).toBeGreaterThan(FILES.length);
  await expect(page.locator(`[data-row="project:${PROJECT}"]`)).toBeVisible();

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
    `[pane-motion] ${JSON.stringify({ variant: { files: fileCount, bare, forced, css }, idleFrameGaps: spread(idle), elements: await page.evaluate(() => document.querySelectorAll("*").length) })}`,
  );

  const changes = page.locator("section[data-pane='changes']");
  await motion(page, "changes-close", () => page.keyboard.press(`${MOD}+\\`));
  await expect(changes).toHaveCount(0);
  await motion(page, "changes-open", () => page.keyboard.press(`${MOD}+\\`));
  await expect(changes).toBeVisible();

  await motion(page, "viewer-open", () => tree.getByText("file0-0-3.ts", { exact: true }).click());
  await expect(page.getByTestId("viewer")).toBeVisible();
  await motion(page, "viewer-close", () => page.keyboard.press("Escape"));
  await expect(page.getByTestId("viewer")).toHaveCount(0);

  await motion(page, "sessions-fold", () => page.keyboard.press(`${MOD}+b`));
  await motion(page, "sessions-open", () => page.keyboard.press(`${MOD}+b`));

  const shells = () =>
    page.evaluate(() => Object.keys((window as unknown as { __CHORD_TERMINALS__?: object }).__CHORD_TERMINALS__ ?? {}).length);
  const before = await shells();
  await motion(page, "terminal-first", () => page.keyboard.press(`${MOD}+j`));
  expect(await shells()).toBe(before + 1);
  await motion(page, "terminal-hide", () => page.keyboard.press(`${MOD}+j`));
  await motion(page, "terminal-second", () => page.keyboard.press(`${MOD}+j`));
  await motion(page, "terminal-hide-again", () => page.keyboard.press(`${MOD}+j`));

  await motion(page, "editor", () => page.keyboard.press(`${MOD}+Shift+e`));
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "editing");
  await motion(page, "agent", () => page.keyboard.press(`${MOD}+Shift+e`));
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "working");
});
