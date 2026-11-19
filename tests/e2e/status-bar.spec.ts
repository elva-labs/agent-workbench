import { expect, test, type Locator, type Page } from "@playwright/test";
import { PROJECT, WITH_WORKFLOW, NO_WORKFLOW, installFakeCore } from "./fake";

// The status bar at the window's foot: what the session on screen runs on,
// and the allowance of the account it runs under, against the fake core's
// scripted integrated sessions, which report limits as the agents do.

const H = "int-1";
const WORK = {
  list: { Work: { claude: "~/.claude-work", codex: "~/.codex-work" } },
  everywhere: null,
  overrides: { [PROJECT]: "Work" },
};

type Window = { kind: string; percent: number; model?: string; resetsAt?: number; severity?: string | null };

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

function calls(page: Page): Promise<{ method: string; [field: string]: unknown }[]> {
  return page.evaluate(
    () => (window as unknown as { __integrated: { calls: { method: string }[] } }).__integrated.calls,
  );
}

/** The account's limits as the agent reports them, with reset times given
    in seconds from now: taken `age` seconds ago, by a read `read` seconds
    ago, or `read: null` where no read was answered. Without `read`, a read
    took them. */
async function report(
  page: Page,
  windows: Window[],
  options: { plan?: string; age?: number; read?: number | null; id?: string } = {},
) {
  await page.evaluate(
    ({ id, windows, plan, age, read }) => {
      const now = Math.floor(Date.now() / 1000);
      (window as unknown as { __integrated: { limits: (...args: unknown[]) => void } }).__integrated.limits(
        id,
        windows.map((window) => ({ ...window, resetsAt: window.resetsAt === undefined ? null : now + window.resetsAt })),
        { plan: plan ?? null, takenAt: now - age, readAt: read === null ? null : now - (read ?? age) },
      );
    },
    { id: options.id ?? H, windows, plan: options.plan, age: options.age ?? 0, read: options.read },
  );
}

const HOUR = 3600;
const THREE = [
  { kind: "session", percent: 11.2, resetsAt: 2 * HOUR + 10 * 60 + 30 },
  { kind: "weekly", percent: 34, resetsAt: 3 * 24 * HOUR },
  { kind: "weeklyScoped", model: "Fable", percent: 52, resetsAt: 3 * 24 * HOUR },
];

async function open(page: Page, settings: Record<string, unknown> = {}, more: Record<string, unknown> = {}) {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"], ...settings }, ...more });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

const bar = (page: Page) => page.getByTestId("status-bar");
const figure = (page: Page, kind: string) => page.locator(`[data-testid='limit-figure'][data-kind='${kind}']`);

/** A colour as the browser computes it, from the theme's tokens: a token's
    name, or a colour made of them. */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = name.startsWith("--") ? `var(${name})` : name;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
}

const style = (locator: Locator, property: string) =>
  locator.evaluate((node, property) => getComputedStyle(node).getPropertyValue(property), property);

/** Whether an element is drawn whole inside the bar, nothing of it cut. */
async function whole(page: Page, testid: string): Promise<boolean> {
  return page.evaluate((testid) => {
    const node = document.querySelector<HTMLElement>(`[data-testid='${testid}']`);
    const foot = document.querySelector<HTMLElement>("[data-testid='status-bar']")!.getBoundingClientRect();
    if (node === null) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.left >= foot.left && box.right <= foot.right && node.scrollWidth <= node.clientWidth + 1;
  }, testid);
}

/** Whether the word in passing is drawn whole, read together with its text
    in one turn of the page, since it goes by itself. Null once it has gone. */
async function wholeFlash(page: Page): Promise<boolean | null> {
  return page.evaluate(() => {
    const node = document.querySelector<HTMLElement>("[data-testid='flash-readout']");
    if (node === null || (node.textContent ?? "") === "") return null;
    const foot = document.querySelector<HTMLElement>("[data-testid='status-bar']")!.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.left >= foot.left && box.right <= foot.right && node.scrollWidth <= node.clientWidth + 1;
  });
}

/** Sets the window's width and waits for the bar to be measured at it,
    which happens before the frame after next is drawn. */
async function settled(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

test.describe("the session on screen", () => {
  test("says its model and effort, then the account with its three windows as text", async ({ page }) => {
    await open(page, { accounts: WORK });
    await agent(page, `f.configure("${H}", { effort: "high" });`);
    await report(page, THREE, { plan: "team" });
    await expect(page.getByTestId("model-readout")).toHaveText("Sonnet");
    await expect(page.getByTestId("effort-readout")).toHaveText("high");
    await expect(page.getByTestId("account-readout")).toHaveText("account: Work");
    await expect(page.getByTestId("limit-figure")).toHaveText(["5h11%", "Week34%", "Fable52%"]);
    // Nothing shouts: every figure is in the bar's own ink, at no more
    // than medium weight, and no age shows for figures just taken.
    const ink = await token(page, "--ink-2");
    for (const kind of ["session", "weekly", "weeklyScoped"]) {
      await expect(figure(page, kind)).toHaveAttribute("data-tone", "normal");
      expect(await style(figure(page, kind), "color")).toBe(ink);
    }
    await expect(page.getByTestId("limits-age")).toHaveCount(0);
    // In order: the focus, what the session is doing and where, the model
    // and effort, the account and its figures. The mode is the corner's
    // switch to say, so the bar does not.
    await expect(page.getByTestId("state-readout")).toHaveText("idle");
    await expect(page.getByTestId("folder-readout")).toHaveText("demo");
    await expect(page.getByTestId("folder-readout")).toHaveAttribute("title", PROJECT);
    await expect(page.getByTestId("branch-readout")).toHaveText("main");
    await expect(page.getByTestId("status-bar")).not.toContainText(/reviewing|editing/);
    const xs = await Promise.all(
      [
        "focus-readout",
        "state-readout",
        "folder-readout",
        "branch-readout",
        "model-readout",
        "effort-readout",
        "account-readout",
        "limits-readout",
      ].map(
        async (id) => (await page.getByTestId(id).boundingBox())!.x,
      ),
    );
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  test("puts what waits for you and the passing word at the right end", async ({ page }) => {
    await open(page);
    // A second session, which finishes while the first is on screen.
    await page.getByTestId("new-session").click();
    await expect(page.getByTestId("session-row")).toHaveCount(2);
    await page.getByTestId("session-row").filter({ hasText: "session 1" }).click();
    await report(page, THREE);
    await agent(page, `f.turn("int-2", "Done.");`);
    await expect(page.getByTestId("waiting-readout")).toHaveText("1 waiting for you");
    const foot = (await bar(page).boundingBox())!;
    const waiting = (await page.getByTestId("waiting-readout").boundingBox())!;
    const figures = (await page.getByTestId("limits-readout").boundingBox())!;
    expect(waiting.x).toBeGreaterThan(figures.x + figures.width + 100);
    expect(foot.x + foot.width - (waiting.x + waiting.width)).toBeLessThan(40);
    // A word in passing stands just before what waits, which stays put.
    await page.keyboard.press("ControlOrMeta+=");
    await expect(page.getByTestId("flash-readout")).not.toHaveText("");
    const word = (await page.getByTestId("flash-readout").boundingBox())!;
    expect(word.x + word.width).toBeLessThanOrEqual(waiting.x);
    expect(waiting.x - (word.x + word.width)).toBeLessThan(20);
    expect((await page.getByTestId("waiting-readout").boundingBox())!.x).toBe(waiting.x);
    // Without accounts named the figures stand alone.
    await expect(page.getByTestId("account-readout")).toHaveCount(0);
    await expect(page.getByTestId("limit-figure")).toHaveCount(3);
  });

  for (const appearance of ["light", "dark"])
    test(`marks a window near its end, and one reached with when it resets, in words as well as tone, ${appearance}`, async ({
      page,
    }) => {
      await open(page, { accounts: WORK, appearance });
      await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
      const ink = await token(page, "--ink-2");
      await report(page, [
        { kind: "session", percent: 92, resetsAt: 40 * 60 + 30, severity: "warning" },
        { kind: "weekly", percent: 71, resetsAt: 3 * 24 * HOUR, severity: "normal" },
        { kind: "weeklyScoped", model: "Fable", percent: 58, resetsAt: 3 * 24 * HOUR, severity: "normal" },
      ]);
      const near = figure(page, "session");
      await expect(near).toHaveAttribute("data-tone", "warn");
      // The theme's warning tone, deepened a little toward the ink so it
      // holds 4.5:1 on the bar.
      expect(await style(near, "color")).toBe(await token(page, "color-mix(in srgb, var(--ansi-yellow) 88%, var(--ink))"));
      expect(Number(await style(near, "font-weight"))).toBeGreaterThanOrEqual(600);
      expect(await style(figure(page, "weekly"), "color")).toBe(ink);
      // Near is not yet reached: no reset time in the bar.
      await expect(near).toHaveText("5h92%");

      await report(page, [
        { kind: "session", percent: 38, resetsAt: 3 * HOUR, severity: "normal" },
        { kind: "weekly", percent: 100, resetsAt: 40 * 60 + 30, severity: "reached" },
        { kind: "weeklyScoped", model: "Fable", percent: 64, resetsAt: 3 * 24 * HOUR, severity: "normal" },
      ]);
      const reached = figure(page, "weekly");
      await expect(reached).toHaveAttribute("data-tone", "error");
      await expect(reached).toHaveText("Week100%· resets in 40 min");
      expect(await style(reached, "color")).toBe(await token(page, "--del"));
      expect(Number(await style(reached, "font-weight"))).toBeGreaterThanOrEqual(600);
    });

  test("takes 80% as near its end where the agent gives no reading, and draws a window past its reset as reset", async ({ page }) => {
    await open(page);
    await report(page, [
      { kind: "session", percent: 100, resetsAt: -60 },
      { kind: "weekly", percent: 81 },
    ]);
    await expect(figure(page, "session")).toHaveText("5hreset");
    await expect(figure(page, "session")).toHaveAttribute("data-tone", "normal");
    await expect(figure(page, "weekly")).toHaveAttribute("data-tone", "warn");
  });

  test("shows a clock and the age once the figures are fifteen minutes old", async ({ page }) => {
    await open(page, { accounts: WORK });
    await report(page, THREE, { age: 3 * HOUR + 60 });
    await expect(page.getByTestId("limits-age")).toHaveText("3 h ago");
    await expect(page.getByTestId("limits-age").locator("svg")).toBeVisible();
    // Each report newer than the last, as the store keeps only the newest.
    await report(page, THREE, { age: 15 * 60 + 30 });
    await expect(page.getByTestId("limits-age")).toHaveText("15 min ago");
    await report(page, THREE, { age: 14 * 60 });
    await expect(page.getByTestId("limits-age")).toHaveCount(0);
  });

  test("counts the age from the last read, not from a push since", async ({ page }) => {
    await open(page, { accounts: WORK });
    // With no read answered, a push's own time is all there is.
    await report(page, THREE, { age: 60, read: null });
    await expect(page.getByTestId("limit-figure")).toHaveCount(3);
    await expect(page.getByTestId("limits-age")).toHaveCount(0);
    // A push just now moved the session window; the read before it, which
    // the other windows are from, is twenty minutes old.
    await report(page, THREE, { age: 0, read: 20 * 60 + 30 });
    await expect(page.getByTestId("limits-age")).toHaveText("20 min ago");
    await page.getByTestId("account-group").click();
    await expect(page.getByTestId("allowance-updated")).toHaveText(
      "Some figures are from just now, the rest from 20 min ago",
    );
  });

  test("shows only the windows a Codex account has", async ({ page }) => {
    await installFakeCore(page, {
      open: [PROJECT],
      agents: ["codex"],
      integrable: ["codex"],
      settings: { integrated: ["codex"], accounts: { ...WORK, list: { personal: { claude: null, codex: "~/.codex-personal" } }, overrides: { [PROJECT]: "personal" } } },
    });
    await page.goto("/");
    await page.getByTestId("start-agent").click();
    await expect(page.getByTestId("composer-input")).toBeFocused();
    await report(page, [
      { kind: "session", percent: 23, resetsAt: HOUR + 35 * 60 },
      { kind: "weekly", percent: 41, resetsAt: 4 * 24 * HOUR },
    ], { plan: "plus" });
    await expect(page.getByTestId("model-readout")).toHaveText("gpt-5-codex");
    await expect(page.getByTestId("account-readout")).toHaveText("account: personal");
    await expect(page.getByTestId("limit-figure")).toHaveText(["5h23%", "Week41%"]);
    await page.getByTestId("account-group").click();
    await expect(page.getByTestId("allowance-plan")).toHaveText("Codex · Plus");
  });
});

test.describe("the bar's text", () => {
  for (const look of ["modern", "terminal"])
    for (const appearance of ["light", "dark"])
      test(`holds 4.5:1 against the bar, quiet, near and reached alike, ${look} ${appearance}`, async ({ page }) => {
        await open(page, { accounts: WORK, look, appearance });
        await agent(page, `f.configure("${H}", { effort: "high" });`);
        await report(
          page,
          [
            { kind: "session", percent: 92, resetsAt: HOUR, severity: "warning" },
            { kind: "weekly", percent: 100, resetsAt: 2 * HOUR, severity: "reached" },
            { kind: "weeklyScoped", model: "Fable", percent: 52, resetsAt: 3 * 24 * HOUR },
          ],
          { age: 3 * HOUR },
        );
        await expect(page.getByTestId("limits-age")).toBeVisible();
        const ratios = await bar(page).evaluate((foot) => {
          const rgb = (color: string): number[] => {
            const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(color);
            if (srgb) return srgb.slice(1, 4).map((part) => Number(part) * 255);
            return (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          };
          const lum = (color: string) => {
            const [r, g, b] = rgb(color).map((part) => {
              const v = part / 255;
              return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const ground = lum(getComputedStyle(foot).backgroundColor);
          const out: Record<string, number> = {};
          for (const node of foot.querySelectorAll<HTMLElement>("span")) {
            const own = [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent!.trim() !== "");
            if (!own || node.getClientRects().length === 0) continue;
            const text = lum(getComputedStyle(node).color);
            const ratio = (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05);
            out[`${node.className.split(" ")[0]} "${node.textContent!.trim()}"`] = Math.round(ratio * 100) / 100;
          }
          return out;
        });
        expect(Object.keys(ratios).length).toBeGreaterThan(8);
        for (const [what, ratio] of Object.entries(ratios)) expect(ratio, what).toBeGreaterThanOrEqual(4.5);
      });
});

test.describe("a terminal session", () => {
  test("names the model it was started on as plain text, and nothing it does not know", async ({ page }) => {
    await installFakeCore(page, { open: [PROJECT], settings: { accounts: WORK, ...WITH_WORKFLOW } });
    await page.goto("/");
    await page.getByTestId("start-agent").click();
    await expect(page.locator("section[data-pane='agent'] .xterm")).toBeVisible();
    const model = page.getByTestId("model-readout");
    await expect(model).toHaveText("Fable");
    expect(await model.evaluate((node) => node.tagName)).toBe("SPAN");
    // The agent may have changed it since, in its own terminal.
    await expect(model).toHaveAttribute("title", "The model the session was started on");
    await expect(page.getByTestId("effort-readout")).toHaveCount(0);
    // No integrated session on the account has said its limits.
    await expect(page.getByTestId("account-readout")).toHaveText("account: Work");
    await expect(page.getByTestId("limit-figure")).toHaveCount(0);
    expect(await page.getByTestId("account-group").evaluate((node) => node.tagName)).toBe("SPAN");
  });

  test("shows nothing of the model where it was started on the agent's own, and the limits another session on the account reported", async ({ page }) => {
    await installFakeCore(page, { open: [PROJECT], settings: { accounts: WORK, ...NO_WORKFLOW } });
    await page.goto("/");
    await page.getByTestId("start-other").click();
    await expect(page.getByTestId("conversation")).toBeVisible();
    await report(page, THREE);
    // Under the project's account, which the palette offers first.
    await page.getByTestId("new-session").click();
    await page.keyboard.press("Enter");
    await expect(page.locator("section[data-pane='agent'] .xterm").first()).toBeVisible();
    await expect(page.getByTestId("model-readout")).toHaveCount(0);
    await expect(page.getByTestId("session-settings")).toHaveCount(0);
    await expect(page.getByTestId("account-readout")).toHaveText("account: Work");
    await expect(page.getByTestId("limit-figure")).toHaveCount(3);
  });

  test("shows the figures its machine kept for the account with their age, then those it read", async ({ page }) => {
    /** Puts figures on the fake machine for the account, read `age`
        seconds ago. */
    const kept = (percents: number[], age: number) =>
      page.evaluate(
        ({ percents, age }) => {
          const now = Math.floor(Date.now() / 1000);
          (window as unknown as { __accountLimits: unknown }).__accountLimits = {
            "claude-code ~/.claude-work": {
              type: "limits",
              agent: "claude-code",
              plan: "max",
              windows: [
                { kind: "session", model: null, percent: percents[0], resetsAt: now + 7200, severity: null },
                { kind: "weekly", model: null, percent: percents[1], resetsAt: now + 3 * 86_400, severity: null },
              ],
              readAt: now - age,
              takenAt: now - age,
            },
          };
        },
        { percents, age },
      );
    await installFakeCore(page, { open: [PROJECT], settings: { accounts: WORK, ...NO_WORKFLOW } });
    await page.goto("/");
    await kept([11, 34], 3 * HOUR);
    await page.getByTestId("start-agent").click();
    await expect(page.locator("section[data-pane='agent'] .xterm")).toBeVisible();
    // No session on the account is integrated, and its figures show.
    await expect(page.getByTestId("limit-figure")).toHaveText(["5h11%", "Week34%"]);
    await expect(page.getByTestId("limits-age")).toHaveText("3 h ago");
    // What was kept was asked for first, then a read.
    const asked = await page.evaluate(() => (window as unknown as { __limitsAsked: unknown[] }).__limitsAsked);
    expect(asked.slice(0, 2)).toMatchObject([
      { project: PROJECT, agent: "claude-code", configDir: "~/.claude-work", read: false },
      { project: PROJECT, agent: "claude-code", configDir: "~/.claude-work", read: true },
    ]);
    // A session that comes on screen asks again, and fresh figures replace
    // the old, their age gone.
    await kept([12, 35], 0);
    await page.getByTestId("new-session").click();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("limit-figure")).toHaveText(["5h12%", "Week35%"]);
    await expect(page.getByTestId("limits-age")).toHaveCount(0);
  });
});

test("with no session selected, says only the focus and what waits", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { accounts: WORK } });
  await page.goto("/");
  await expect(page.getByTestId("focus-readout")).toBeVisible();
  for (const id of [
    "state-readout",
    "folder-readout",
    "branch-readout",
    "model-readout",
    "effort-readout",
    "account-readout",
    "account-group",
    "limit-figure",
  ])
    await expect(page.getByTestId(id)).toHaveCount(0);
});

test.describe("a narrow window", () => {
  const STEPS: [string, string][] = [
    ["chrome", "focus-readout"],
    ["folder", "folder-readout"],
    ["prefix", "account-readout"],
    ["fold", "limit-figure"],
    ["branch", "branch-readout"],
    ["reset", "limit-figure"],
  ];

  test("lets the focus go first, then the folder, the prefix, the figures but one, the branch and the reset time, and never cuts the state or what waits", async ({
    page,
  }) => {
    await open(page, { accounts: WORK });
    // A second session that finishes while the first is on screen, so
    // something waits for you.
    await page.getByTestId("new-session").click();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("session-row")).toHaveCount(2);
    await page.getByTestId("session-row").filter({ hasText: "session 1" }).click();
    await agent(page, `f.turn("int-2", "Done."); f.configure("${H}", { effort: "high" });`);
    await expect(page.getByTestId("waiting-readout")).toHaveText("1 waiting for you");
    await report(page, [
      { kind: "session", percent: 38, resetsAt: 3 * HOUR },
      { kind: "weekly", percent: 100, resetsAt: 3 * 24 * HOUR, severity: "reached" },
      { kind: "weeklyScoped", model: "Fable", percent: 64, resetsAt: 3 * 24 * HOUR },
    ]);
    await page.keyboard.press("ControlOrMeta+=");
    await expect(page.getByTestId("flash-readout")).not.toHaveText("");
    const seen: string[] = [];
    for (let width = 1440; width >= 380; width -= 20) {
      await settled(page, width);
      const fit = (await bar(page).getAttribute("data-fit")) ?? "";
      const taken = fit.split(" ").filter(Boolean);
      // Steps are only ever taken in order.
      expect(taken, `at ${width}`).toEqual(STEPS.slice(0, taken.length).map(([step]) => step));
      if (!seen.includes(fit)) seen.push(fit);
      // What a step hides is hidden, and what it has not reached is drawn.
      await expect(page.getByTestId("focus-readout")).toBeVisible({ visible: !taken.includes("chrome") });
      await expect(page.getByTestId("folder-readout")).toBeVisible({ visible: !taken.includes("folder") });
      await expect(page.getByTestId("branch-readout")).toBeVisible({ visible: !taken.includes("branch") });
      await expect(page.locator(".pre")).toBeVisible({ visible: !taken.includes("prefix") });
      await expect(page.locator("[data-testid='limit-figure']:visible")).toHaveCount(taken.includes("fold") ? 1 : 3);
      // Folded, the figure that stays is the reached week.
      if (taken.includes("fold")) await expect(figure(page, "weekly")).toBeVisible();
      await expect(page.locator(".rs")).toBeVisible({ visible: !taken.includes("reset") });
      // What the session is doing and what waits for you are never cut,
      // nor is a word in passing.
      expect(await whole(page, "state-readout"), `state at ${width}`).toBe(true);
      expect(await whole(page, "waiting-readout"), `waiting at ${width}`).toBe(true);
      // The word goes by itself, so it is said again at each width and
      // read in the same turn as its text.
      await page.keyboard.press("ControlOrMeta+=");
      await expect(page.getByTestId("flash-readout")).not.toHaveText("");
      expect(await wholeFlash(page), `flash at ${width}`).not.toBe(false);
    }
    // Every step was taken on the way down.
    expect(seen).toEqual(STEPS.map((_, at) => STEPS.slice(0, at).map(([step]) => step).join(" ")).concat(STEPS.map(([step]) => step).join(" ")));
    // The figure's own words go with it until the end: nothing is drawn
    // past the bar's edge.
    expect(await bar(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    // And back again as the window grows.
    await page.setViewportSize({ width: 1440, height: 800 });
    await expect(bar(page)).toHaveAttribute("data-fit", "");
  });

  test("cuts nothing short before every step is taken, not by a fraction of a pixel", async ({ page }) => {
    await open(page, { accounts: WORK });
    await report(page, THREE);
    const fit = async (width: number) => {
      await settled(page, width);
      return (await bar(page).getAttribute("data-fit")) ?? "";
    };
    // The bar's width in whole pixels hides a part over by less than half
    // of one; a quarter pixel more padding at a time brings that about
    // whatever the font's widths.
    for (const extra of [0, 0.25, 0.5, 0.75]) {
      await bar(page).evaluate((node, extra) => (node.style.paddingLeft = `${12 + extra}px`), extra);
      let [low, high] = [400, 1440];
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if ((await fit(middle)) === "") high = middle;
        else low = middle;
      }
      expect(await fit(high)).toBe("");
      const cut = await page.evaluate(() => {
        const who = document.querySelector("[data-testid='account-readout']")!.getBoundingClientRect();
        const name = document.querySelector("[data-testid='account-readout'] .name")!.getBoundingClientRect();
        return name.right - who.right;
      });
      expect(cut, `${extra} px more at ${high}`).toBeLessThanOrEqual(0.01);
    }
  });

  test("takes no step for a word in passing, which is drawn over the parts before it", async ({ page }) => {
    await open(page, { accounts: WORK });
    await report(page, [
      { kind: "session", percent: 38, resetsAt: 3 * HOUR },
      { kind: "weekly", percent: 100, resetsAt: 3 * 24 * HOUR, severity: "reached" },
    ]);
    const fit = async (width: number) => {
      await settled(page, width);
      return (await bar(page).getAttribute("data-fit")) ?? "";
    };
    // The narrowest window where nothing has given way: a pixel less and
    // the focus and the mode go.
    let [low, high] = [400, 1440];
    expect(await fit(low)).not.toBe("");
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if ((await fit(middle)) === "") high = middle;
      else low = middle;
    }
    expect(await fit(high)).toBe("");
    const before = await Promise.all(
      ["focus-readout", "model-readout", "account-group"].map(async (id) => (await page.getByTestId(id).boundingBox())!.x),
    );
    // The word goes by itself after a moment: the page's clock stands
    // still until the checks are done, so it is there for all of them.
    await page.clock.install();
    await page.keyboard.press("ControlOrMeta+=");
    const word = page.getByTestId("flash-readout");
    await expect(word).not.toHaveText("");
    await page.clock.runFor(100);
    await expect(bar(page)).toHaveAttribute("data-fit", "");
    const after = await Promise.all(
      ["focus-readout", "model-readout", "account-group"].map(async (id) => (await page.getByTestId(id).boundingBox())!.x),
    );
    expect(after).toEqual(before);
    // There is no room for it, so it covers the end of the figures, whole
    // and on the bar's own background.
    // Read in one turn of the page, since the word goes by itself.
    const covers = await page.evaluate(() => {
      const word = document.querySelector<HTMLElement>("[data-testid='flash-readout']")!;
      const figures = document.querySelector("[data-testid='limits-readout']")!.getBoundingClientRect();
      const foot = document.querySelector("[data-testid='status-bar']")!.getBoundingClientRect();
      const box = word.getBoundingClientRect();
      return {
        text: word.textContent,
        whole: box.width > 0 && box.left >= foot.left && box.right <= foot.right && word.scrollWidth <= word.clientWidth + 1,
        over: box.x < figures.x + figures.width,
      };
    });
    expect(covers.text).not.toBe("");
    expect(covers.whole).toBe(true);
    expect(covers.over).toBe(true);
    expect(await style(word, "background-color")).toBe(await style(bar(page), "background-color"));
    await page.clock.runFor(2000);
    await expect(word).toHaveText("");
    await expect(bar(page)).toHaveAttribute("data-fit", "");
  });

  test("gives way the same in editor mode", async ({ page }) => {
    await open(page, { accounts: WORK });
    await report(page, THREE);
    await page.getByTestId("mode-editor").click();
    await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "editing");
    await page.setViewportSize({ width: 460, height: 800 });
    await expect(bar(page)).toHaveAttribute("data-fit", /chrome/);
    await expect(page.getByTestId("model-readout")).toBeVisible();
    expect(await bar(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  });
});

test.describe("the allowance popover", () => {
  test("shows every window with a meter, its share and when it resets, the account and plan, and how old the figures are", async ({
    page,
  }) => {
    await open(page, { accounts: WORK });
    await report(page, [
      { kind: "session", percent: 38, resetsAt: 3 * HOUR + 5 * 60 + 30 },
      { kind: "weekly", percent: 100, resetsAt: 40 * 60 + 30, severity: "reached" },
      { kind: "weeklyScoped", model: "Fable", percent: 64, resetsAt: 3 * 24 * HOUR },
    ], { plan: "team" });
    await page.getByTestId("account-group").click();
    const popover = page.getByTestId("allowance-popover");
    await expect(popover).toBeVisible();
    await expect(page.getByTestId("allowance-account")).toHaveText("Work");
    await expect(page.getByTestId("allowance-plan")).toHaveText("Claude Code · Team");
    const rows = page.getByTestId("allowance-row");
    await expect(rows.locator(".nm")).toHaveText(["Session (5 hours)", "Week", "Week, Fable only"]);
    await expect(rows.locator(".pc")).toHaveText(["38%", "100%", "64%"]);
    await expect(page.getByTestId("allowance-reset")).toHaveText([
      "resets in 3 h 5 min",
      "Reached, resets in 40 min",
      /^resets \w+day \d/,
    ]);
    const meter = (await rows.nth(1).locator(".m").boundingBox())!;
    const fill = (await rows.nth(1).locator(".m b").boundingBox())!;
    expect(Math.abs(fill.width - meter.width)).toBeLessThan(1);
    await expect(page.getByTestId("allowance-updated")).toHaveText("Updated just now");
    // Above the bar, inside the window.
    const box = (await popover.boundingBox())!;
    const foot = (await bar(page).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(foot.y);
    expect(box.x).toBeGreaterThanOrEqual(0);
  });

  test("says in words how old the figures are", async ({ page }) => {
    await open(page);
    await report(page, THREE, { age: 3 * HOUR + 60, plan: "max" });
    await page.getByTestId("account-group").click();
    await expect(page.getByTestId("allowance-account")).toHaveText("Claude Code");
    await expect(page.getByTestId("allowance-plan")).toHaveText("Max");
    await expect(page.getByTestId("allowance-updated")).toHaveText(
      "Figures from 3 hours ago",
    );
  });

  test("goes on Escape or a press elsewhere, and the keyboard goes back where it was", async ({ page }) => {
    await open(page, { accounts: WORK });
    await report(page, THREE);
    const input = page.getByTestId("composer-input");
    await input.fill("half a thought");
    await page.getByTestId("account-group").click();
    await expect(page.getByTestId("allowance-popover")).toBeVisible();
    await expect(page.getByTestId("account-group")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("allowance-popover")).toHaveCount(0);
    await expect(input).toBeFocused();
    // Escape put the popover away and nothing else: no turn to stop, the
    // words still there.
    await expect(input).toHaveValue("half a thought");

    await page.getByTestId("account-group").click();
    await expect(page.getByTestId("allowance-popover")).toBeVisible();
    await page.getByTestId("thread").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("allowance-popover")).toHaveCount(0);
  });
});

test.describe("the model and the effort", () => {
  test("open the same choices as the composer, and change the session's setting", async ({ page }) => {
    await open(page, { accounts: WORK });
    await agent(page, `f.configure("${H}", { effort: "high" });`);
    const model = page.getByTestId("model-readout");
    await model.click();
    const menu = page.getByTestId("status-model-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("status-model-option").locator(".name")).toHaveText(["Default (recommended)", "Haiku", "Sonnet"]);
    const sonnet = page.getByTestId("status-model-option").filter({ has: page.locator(".name", { hasText: /^Sonnet$/ }) });
    await expect(sonnet).toHaveAttribute("aria-checked", "true");
    // Above the bar, from the word that opened it.
    const box = (await menu.boundingBox())!;
    const word = (await model.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual((await bar(page).boundingBox())!.y);
    expect(Math.abs(box.x - word.x)).toBeLessThan(12);
    await page.getByTestId("status-model-option").filter({ hasText: "Haiku" }).click();
    await expect(menu).toHaveCount(0);
    await expect(model).toHaveText("Haiku");
    await expect(page.getByTestId("model-chip")).toHaveText("Haiku");
    expect((await calls(page)).filter((call) => call.method === "configure").at(-1)).toMatchObject({
      settings: { model: "haiku" },
    });
    await expect(page.getByTestId("composer-input")).toBeFocused();

    // The agent offers Haiku with no efforts, so the bar names none; Sonnet
    // takes them.
    await expect(page.getByTestId("effort-readout")).toHaveCount(0);
    await expect(page.getByTestId("session-settings")).toHaveText("Haiku");
    await model.click();
    await sonnet.click();
    const effort = page.getByTestId("effort-readout");
    await effort.click();
    await expect(page.getByTestId("status-effort-option").locator(".name")).toHaveText(["Low", "Medium", "High"]);
    await expect(page.getByTestId("status-effort-option").filter({ hasText: "High" })).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("status-effort-option").filter({ hasText: "Low" }).click();
    await expect(effort).toHaveText("low");
    expect((await calls(page)).filter((call) => call.method === "configure").at(-1)).toMatchObject({
      settings: { effort: "low" },
    });
  });

  test("are one menu at a time, and a press elsewhere puts it away", async ({ page }) => {
    await open(page);
    await agent(page, `f.configure("${H}", { effort: "high" });`);
    await page.getByTestId("model-readout").click();
    await expect(page.getByTestId("status-model-menu")).toBeVisible();
    await page.getByTestId("effort-readout").click();
    await expect(page.getByTestId("status-model-menu")).toHaveCount(0);
    await expect(page.getByTestId("status-effort-menu")).toBeVisible();
    await page.getByTestId("thread").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("status-effort-menu")).toHaveCount(0);
  });
});

test.describe("what the bar opens", () => {
  for (const which of ["model-readout", "account-group"])
    test(`stays open above its control as the window changes size, and keeps the keyboard: ${which}`, async ({ page }) => {
      await open(page, { accounts: WORK });
      await report(page, THREE);
      const input = page.getByTestId("composer-input");
      await input.fill("draft");
      const control = page.getByTestId(which);
      await control.click();
      const opened = page.getByTestId(which === "model-readout" ? "status-model-menu" : "allowance-popover");
      await expect(opened).toBeVisible();
      const owner = await page.evaluate(() => document.activeElement?.closest("[data-testid]")?.getAttribute("data-testid"));
      for (const width of [1300, 1160, 900]) {
        await settled(page, width);
        await expect(opened).toBeVisible();
        // Above the bar, from its control, inside the window.
        const box = (await opened.boundingBox())!;
        const from = (await control.boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual((await bar(page).boundingBox())!.y);
        expect(box.x, `at ${width}`).toBeLessThanOrEqual(from.x);
        expect(box.x + box.width, `at ${width}`).toBeGreaterThan(from.x + 12);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        // The keyboard is where it was, in what is open.
        expect(
          await page.evaluate(() => document.activeElement?.closest("[data-testid]")?.getAttribute("data-testid")),
        ).toBe(owner);
      }
      await page.keyboard.press("Escape");
      await expect(opened).toHaveCount(0);
      await expect(input).toBeFocused();
      await page.keyboard.type("x");
      await expect(input).toHaveValue("draftx");
    });

  test("goes when a chord takes the keyboard elsewhere, and leaves it there", async ({ page }) => {
    await open(page, { accounts: WORK });
    await report(page, THREE);
    await page.getByTestId("model-readout").click();
    await expect(page.getByTestId("status-model-menu")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+1");
    await expect(page.getByTestId("status-model-menu")).toHaveCount(0);
    await expect(page.getByTestId("model-readout")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
    expect(await page.evaluate(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane"))).toBe(
      "sessions",
    );

    // The composer's menus go the same way.
    await page.getByTestId("composer-input").focus();
    await page.getByTestId("model-chip").click();
    await expect(page.getByTestId("model-menu")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+1");
    await expect(page.getByTestId("model-menu")).toHaveCount(0);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
    // A press on the chip that opened it still closes it.
    await page.getByTestId("model-chip").click();
    await expect(page.getByTestId("model-menu")).toBeVisible();
    await page.getByTestId("model-chip").click();
    await expect(page.getByTestId("model-menu")).toHaveCount(0);
  });
});
