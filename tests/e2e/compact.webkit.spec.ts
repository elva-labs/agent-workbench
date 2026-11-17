import { expect, test, type Page } from "@playwright/test";
import { NO_WORKFLOW, PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

/**
 * Compact mode: the sessions pane out of the layout, slid in over the
 * panes from the window's left edge or by the chord that goes to it. Runs
 * in WebKit as well, the app's own webview on macOS.
 */

const SESSIONS = "[data-testid='sessions-slot'] section[data-pane='sessions']";
const AGENT = "section[data-pane='agent']";
const CHANGES = "section[data-pane='changes']";
const MOD = "ControlOrMeta";
/** How long the pointer is away before the pane goes, as the app has it. */
const AWAY_AFTER = 400;

/** The chord bound to going to the sessions pane in these tests, which is
    not the default, so the tests press the binding and not a key of
    their own. */
const BOUND = { key: "y", shift: false, alt: false };
const PRESS_BOUND = `${MOD}+y`;

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} is not drawn`);
  return box;
}

/** Waits until the slid-in pane stands all the way in, at the window's
    left edge or the frame's padding. */
async function slidIn(page: Page) {
  await expect(page.locator(SESSIONS)).toBeVisible();
  // At rest where its slot stands: the window's edge, or the frame's
  // padding in the terminal look.
  await expect
    .poll(() =>
      page.evaluate((selector) => {
        const pane = document.querySelector(selector)!;
        const slot = document.querySelector("[data-testid='sessions-slot']")!;
        return Math.abs(pane.getBoundingClientRect().left - slot.getBoundingClientRect().left) < 0.5;
      }, SESSIONS),
    )
    .toBe(true);
}

async function slidOut(page: Page) {
  await expect(page.locator(SESSIONS)).toBeHidden();
}

async function start(page: Page, settings: Record<string, unknown> = {}) {
  await installFakeCore(page, { settings: { compact: true, keys: { "focus.sessions": BOUND }, ...settings } });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await slidOut(page);
}

/** Brings the pane in by the bound chord and starts a session from it, so
    there is a row to pick; the pane goes as the session starts. */
async function startSession(page: Page) {
  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  await page.getByTestId("new-session").click();
  await slidOut(page);
}

test("leaves the sessions pane out of the layout and gives the others its width", async ({ page }) => {
  await start(page);
  await slidOut(page);
  const agent = await boxOf(page, AGENT);
  const changes = await boxOf(page, CHANGES);
  // Only the edge before the panes is left: the gap at the right edge in
  // the modern look, the frame's padding in the terminal look.
  expect(agent.x).toBeLessThanOrEqual(10);
  const width = page.viewportSize()!.width;
  expect(changes.x + changes.width).toBeGreaterThan(width - 12);
  // Nothing of the hidden pane takes the keyboard on Tab.
  await expect(page.locator("[data-testid='sessions-slot']")).toHaveAttribute("inert", "");
});

test("slides the pane in at the left edge, and back a moment after the pointer leaves it", async ({ page }) => {
  await start(page);
  await page.mouse.move(600, 400);
  await page.mouse.move(2, 400, { steps: 4 });
  await slidIn(page);
  // Over the panes, pushing nothing.
  expect((await boxOf(page, AGENT)).x).toBeLessThanOrEqual(10);

  // Into the pane and away again: it waits a moment before it goes.
  await page.mouse.move(120, 400, { steps: 3 });
  const away = Date.now();
  await page.mouse.move(900, 400, { steps: 3 });
  await slidOut(page);
  expect(Date.now() - away).toBeGreaterThanOrEqual(AWAY_AFTER - 50);
  // The keyboard never moved.
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
});

test("slides the pane in when the pointer leaves the window by its left edge", async ({ page }) => {
  await start(page);
  await page.mouse.move(400, 400);
  await page.mouse.move(14, 400, { steps: 4 });
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, clientX: 14, clientY: 400, relatedTarget: null }),
    ),
  );
  await slidIn(page);
  // Back in the window, over the pane, it stays; away from it, it goes.
  await page.mouse.move(100, 400, { steps: 2 });
  await page.mouse.move(900, 400, { steps: 3 });
  await slidOut(page);
});

test("holds the pane while a menu is open in it, wherever the pointer goes", async ({ page }) => {
  await page.clock.install();
  await start(page);
  await page.mouse.move(2, 400, { steps: 2 });
  await slidIn(page);
  await page.getByTestId("project-sort").click();
  await page.mouse.move(900, 400, { steps: 3 });
  await page.clock.runFor(AWAY_AFTER * 3);
  await expect(page.locator(SESSIONS)).toBeVisible();

  // The menu put away, the pointer still away, the pane goes.
  await page.keyboard.press("Escape");
  await page.clock.runFor(AWAY_AFTER * 3);
  await slidOut(page);
});

test("slides in with the keyboard by the bound chord, and Escape returns the keyboard", async ({ page }) => {
  await page.clock.install();
  await start(page);
  await page.mouse.move(900, 400);

  // The default chord is not the one bound.
  await page.keyboard.press(`${MOD}+1`);
  await page.clock.runFor(200);
  await slidOut(page);

  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
  expect(await page.evaluate(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane"))).toBe(
    "sessions",
  );
  // The keyboard holds it while the pointer is away.
  await page.mouse.move(1000, 300, { steps: 2 });
  await page.clock.runFor(AWAY_AFTER * 3);
  await expect(page.locator(SESSIONS)).toBeVisible();

  await page.keyboard.press("Escape");
  await slidOut(page);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");

  // The chord again sends it back too.
  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  await page.keyboard.press(PRESS_BOUND);
  await slidOut(page);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
});

test("picking a session sends the pane back, the keyboard in its agent", async ({ page }) => {
  await start(page);
  await startSession(page);
  await startSession(page);
  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  const rows = page.locator(`${SESSIONS} [data-testid='session-row']`);
  await expect(rows).toHaveCount(2);
  await rows.last().click();
  await slidOut(page);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");

  // Picking the project sends it back too, the keyboard where it was.
  await page.keyboard.press(`${MOD}+3`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  await page.locator(`${SESSIONS} [data-row="project:${PROJECT}"]`).click();
  await slidOut(page);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
});

test("goes to a session from the palette without showing the pane", async ({ page }) => {
  await start(page);
  await startSession(page);
  await startSession(page);
  await page.keyboard.press(`${MOD}+p`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  await slidOut(page);
});

test("marks the edge while a session waits for you, and the status bar counts it", async ({ page }) => {
  await start(page);
  await startSession(page);
  await startSession(page);
  await expect(page.getByTestId("compact-mark")).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { __notifyRequest: (request: unknown) => void }).__notifyRequest({
      text: "Tests green, ready to merge.",
      cwd: "/home/ada/dev/demo",
      session: "session-1",
    }),
  );
  await expect(page.getByTestId("compact-mark")).toBeVisible();
  await expect(page.getByTestId("waiting-readout")).toHaveText("1 waiting for you");
  const mark = await boxOf(page, "[data-testid='compact-mark']");
  expect(mark.x).toBeLessThan(8);
});

test("keeps the setting across a reload, and leaves the fold and the width as they were", async ({ page }) => {
  await installFakeCore(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("laid") !== null) return;
    sessionStorage.setItem("laid", "yes");
    localStorage.setItem("workbench.layout", JSON.stringify({ sessions: 340 }));
  });
  await page.goto("/");
  const pane = "section[data-pane='sessions']";
  await expect.poll(async () => Math.round((await boxOf(page, pane)).width)).toBe(340);
  // Folded by its toggle before compact mode comes on.
  await page.keyboard.press(`${MOD}+b`);
  await expect.poll(async () => (await boxOf(page, pane)).width).toBeLessThan(100);

  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("compact-on").click();
  await page.keyboard.press("Escape");
  await slidOut(page);
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").compact, SETTINGS_FILE))
    .toBe(true);

  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await slidOut(page);
  expect((await boxOf(page, AGENT)).x).toBeLessThanOrEqual(10);

  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("compact-on")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("compact-off").click();
  await page.keyboard.press("Escape");
  // Still folded, and open again at the width it had.
  await expect.poll(async () => (await boxOf(page, pane)).width).toBeLessThan(100);
  await page.keyboard.press(`${MOD}+b`);
  await expect.poll(async () => Math.round((await boxOf(page, pane)).width)).toBe(340);
});

/** The colour the page shows at a point, read from a screenshot of it. */
async function pixel(page: Page, x: number, y: number): Promise<string> {
  const shot = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(",");
  }, shot.toString("base64"));
}

for (const look of ["modern", "terminal"] as const)
  test(`stands over the focused card's mark, in the ${look} look`, async ({ page }) => {
    await start(page, { look, appearance: "light" });
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
    // The focused pane's mark: the card's top edge in the modern look, the
    // box's border in the terminal look.
    const card = await boxOf(page, look === "modern" ? `${AGENT} > .body` : AGENT);
    const y = Math.round(card.y) + (look === "modern" ? 1 : 0);
    const mark = await pixel(page, Math.round(card.x + card.width - 60), y);
    await page.mouse.move(2, 400, { steps: 2 });
    await slidIn(page);
    await page.mouse.move(150, 400);
    // Where the mark runs under the pane, the pane's own ground shows, as
    // it does a few pixels further down.
    const over = await pixel(page, 150, y);
    expect(over).not.toBe(mark);
    // In the modern look the pane's own ground shows there, as it does at
    // its empty foot.
    const pane = await boxOf(page, SESSIONS);
    if (look === "modern") expect(over).toBe(await pixel(page, 150, Math.round(pane.y + pane.height - 20)));
  });

test("stands under a question asked over the agent", async ({ page }) => {
  const OTHER = "/home/ada/dev/other";
  await page.setViewportSize({ width: 706, height: 800 });
  await installFakeCore(page, {
    open: [PROJECT, OTHER],
    settings: { ...NO_WORKFLOW, compact: true, keys: { "focus.sessions": BOUND } },
  });
  await page.goto("/");
  await slidOut(page);
  await page.getByTestId("start-agent").click();
  await page.evaluate(
    ({ project, other }) =>
      (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
        id: "c-1",
        tool: "start",
        arguments: { project: other, prompt: "Write the release notes." },
        cwd: project,
        session: "session-1",
      }),
    { project: PROJECT, other: OTHER },
  );
  const ask = page.getByTestId("conduct-ask");
  await expect(ask).toBeVisible();
  await page.mouse.move(2, 600, { steps: 2 });
  await slidIn(page);
  await page.mouse.move(150, 600);
  // Where the question and the pane overlap, the question is on top.
  const box = await ask.boundingBox();
  const pane = await boxOf(page, SESSIONS);
  const x = Math.round(Math.max(box!.x, pane.x) + 20);
  expect(x).toBeLessThan(pane.x + pane.width);
  const top = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest("[data-testid='conduct-ask']") !== null,
    [x, Math.round(box!.y + box!.height / 2)],
  );
  expect(top).toBe(true);
});

// A question in the pane goes with it: whatever puts the pane away
// answers Cancel, so nothing waits out of sight. Only the pointer and a
// press outside wait for the answer.
test("takes a question in the pane away with it, by the chord, Cmd+B or a change of session", async ({ page }) => {
  await page.clock.install();
  await start(page, { integrated: ["claude-code"] });
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await page.evaluate(
    `(() => { const f = window.__integrated; f.send("int-1", crypto.randomUUID(), "Keep the cache."); f.startTurn("int-1"); })()`,
  );
  const question = page.getByTestId("reopen-session");
  await expect(page.locator(`${SESSIONS} .session .dot.working`)).toHaveCount(1);

  const ask = async () => {
    await page.keyboard.press(PRESS_BOUND);
    await slidIn(page);
    await page
      .locator(`${SESSIONS} [data-testid='session-row']`)
      .filter({ has: page.locator(".dot.working") })
      .click({ button: "right" });
    await page.getByTestId("session-menu-reopen").click();
    await expect(question).toBeVisible();
  };

  // The pointer away does not take it: the question holds the pane.
  await ask();
  await page.mouse.move(900, 400, { steps: 2 });
  await page.clock.runFor(AWAY_AFTER * 3);
  await expect(question).toBeVisible();

  await page.keyboard.press(PRESS_BOUND);
  await slidOut(page);
  await expect(question).toHaveCount(0);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  // Back again, nothing waits.
  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  await expect(question).toHaveCount(0);
  await page.keyboard.press("Escape");
  await slidOut(page);

  await ask();
  await page.keyboard.press(`${MOD}+b`);
  await slidOut(page);
  await expect(question).toHaveCount(0);

  // A second session, and the question up over the first's row: stepping
  // to the other session puts the pane away with it.
  await page.keyboard.press(PRESS_BOUND);
  await slidIn(page);
  await page.getByTestId("new-session").click();
  await slidOut(page);
  await ask();
  await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
  await slidOut(page);
  await expect(question).toHaveCount(0);
});

/** The window's traffic lights as the real window places them on macOS:
    the close button's left edge 18 points in, three 14-point buttons 8
    apart, so to 76, on the middle of the header that leads the window,
    which the app measures and reports. A browser has no such buttons, so
    the room is reckoned the same way and checked to hold nothing. */
async function lights(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector("section[data-pane] header")!.getBoundingClientRect();
    const centre = header.top + header.height / 2;
    return { left: 0, right: 84, top: centre - 10, bottom: centre + 10 };
  });
}

/** What a person could reach or read in the lights' room: controls, tab
    stops, fields and pane titles that are drawn and not inert. */
function underLights(page: Page, room: { left: number; right: number; top: number; bottom: number }) {
  return page.evaluate((room) => {
    const found: string[] = [];
    const selector = "button, a[href], input, textarea, select, [role='button'], [tabindex]:not([tabindex='-1']), header .title";
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (element.closest("[inert]") !== null) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none") continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right <= room.left || box.left >= room.right || box.bottom <= room.top || box.top >= room.bottom) continue;
      found.push(`${element.tagName.toLowerCase()} ${element.dataset.testid ?? element.className} at ${Math.round(box.left)}`);
    }
    return found;
  }, room);
}

for (const look of ["modern", "terminal"] as const)
  test(`keeps the traffic lights' corner clear in every state, in the ${look} look`, async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
    await installFakeCore(page, { settings: { look, keys: { "focus.sessions": BOUND } } });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await page.getByTestId("new-session").click();
    const room = await lights(page);
    const clear = async (state: string) => expect(await underLights(page, room), state).toEqual([]);

    await clear("open");
    await page.keyboard.press(`${MOD}+b`);
    await expect.poll(async () => (await boxOf(page, "section[data-pane='sessions']")).width).toBeLessThan(100);
    await clear("folded");
    await page.keyboard.press(`${MOD}+b`);

    await page.keyboard.press(`${MOD}+,`);
    await page.getByTestId("compact-on").click();
    await page.keyboard.press("Escape");
    await slidOut(page);
    await clear("compact, hidden");
    await page.mouse.move(2, 400, { steps: 2 });
    await slidIn(page);
    await clear("compact, slid in");
    await page.mouse.move(900, 400, { steps: 3 });
    await slidOut(page);
    await page.keyboard.press(`${MOD}+Shift+E`);
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
    await clear("compact, editing");
    await page.keyboard.press(PRESS_BOUND);
    await slidIn(page);
    await clear("compact, editing, slid in");
  });

// Where the app draws the window's own buttons, the menu button that stands
// in for a menu bar leads the window in compact mode, clear of the pane's
// edge, and the pane slid in over it holds its own in the same place.
test("puts the menu button at the start of the leading header off macOS", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" }));
  await start(page);
  const menu = page.locator(`${AGENT} [data-testid='app-menu']`);
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(6);
  expect(box!.x).toBeLessThan(20);
  await page.mouse.move(2, 400, { steps: 2 });
  await slidIn(page);
  const own = await page.locator(`${SESSIONS} [data-testid='app-menu']`).boundingBox();
  expect(Math.abs(own!.y - box!.y)).toBeLessThanOrEqual(1);
});

// The peek while reviewing, the one the window had before compact mode,
// stands over the focused card's mark as the slid-in pane does.
test("peeks over the focused card's mark while reviewing", async ({ page }) => {
  await installFakeCore(page, { settings: { appearance: "light" } });
  // A pane wide enough to reach well over the agent's card.
  await page.addInitScript(() => localStorage.setItem("workbench.layout", JSON.stringify({ sessions: 420 })));
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await page.getByTestId("new-session").click();
  await page.locator("[data-testid='file-tree']").getByText("mod.rs", { exact: true }).click();
  await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
  await page.keyboard.press(`${MOD}+2`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  // The columns ease into the reviewing shape: the card is read once it
  // stands still, two frames apart.
  await expect
    .poll(() =>
      page.evaluate(
        (selector) =>
          new Promise<boolean>((resolve) => {
            const read = () => JSON.stringify(document.querySelector(selector)!.getBoundingClientRect());
            const first = read();
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(read() === first)));
          }),
        `${AGENT} > .body`,
      ),
    )
    .toBe(true);
  const card = await boxOf(page, `${AGENT} > .body`);
  const y = Math.round(card.y) + 1;
  const mark = await pixel(page, Math.round(card.x + card.width - 30), y);
  // The pointer resting on the folded column peeks it, the keyboard left
  // in the agent.
  await page.mouse.move(30, 500, { steps: 2 });
  const pane = "section[data-pane='sessions']";
  await expect.poll(async () => Math.round((await boxOf(page, pane)).width)).toBe(420);
  // Read where the peeked pane stands over the agent's card.
  const x = Math.round(card.x + 30);
  expect(x).toBeLessThan((await boxOf(page, pane)).x + (await boxOf(page, pane)).width);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  expect(await pixel(page, x, y)).not.toBe(mark);
});
