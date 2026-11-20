import { expect, test, type Page } from "@playwright/test";
import { PROJECT, WITH_WORKFLOW, backgroundAtRest, foldedWidth, installFakeCore } from "./fake";

/**
 * The frame every pane lives in: in the modern look the panes stand as
 * cards on the window's ground under headers that lie on it, in the
 * terminal look as boxes, and in both the gap between two panes is the
 * divider. Nothing is drawn in it at rest; it takes hold over the gap and a
 * little into the panes either side, gives way there to a scroll bar or a
 * control, shows a grip as the pointer nears, and draws a line in the
 * accent while dragged or under the keyboard.
 */

const SESSIONS = "section[data-pane='sessions']";
const AGENT = "section[data-pane='agent']";
const CHANGES = "section[data-pane='changes']";
const DIVIDER = ".splitter[data-divider='changes']";
const MOD = "ControlOrMeta";

type Box = { x: number; y: number; width: number; height: number };

async function open(
  page: Page,
  options: { look?: string; appearance?: string; platform?: string; settings?: Record<string, unknown> } = {},
) {
  const { look = "modern", appearance = "light", platform, settings = {} } = options;
  if (platform !== undefined) {
    await page.addInitScript((reported) => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => reported });
    }, platform);
  }
  await installFakeCore(page, { open: [PROJECT], settings: { look, appearance, ...settings } });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
}

async function box(page: Page, selector: string): Promise<Box> {
  return (await page.locator(selector).first().boundingBox())!;
}

/** The colour the page shows at a point, read from a screenshot of it. */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const shot = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, shot.toString("base64"));
}

const lightness = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Whether a point is taken by a divider, and what the pointer looks like
    there. */
function heldAt(page: Page, x: number, y: number) {
  return page.evaluate(
    ([x, y]) => {
      const under = document.elementFromPoint(x, y);
      const divider = under?.closest(".splitter, .junction") ?? null;
      return divider === null ? null : getComputedStyle(under!).cursor;
    },
    [x, y],
  );
}

function gripOpacity(page: Page, selector = DIVIDER) {
  return page.locator(`${selector} > .grip`).evaluate((grip) => Number(getComputedStyle(grip).opacity));
}

function lineOpacity(page: Page, selector = DIVIDER) {
  return page.locator(`${selector} > .line`).evaluate((line) => Number(getComputedStyle(line).opacity));
}

test.describe("the panes in the modern look", () => {
  for (const appearance of ["light", "dark"]) {
    test(`stand as cards on the ground a gap apart, nothing drawn between them, ${appearance}`, async ({ page }) => {
      await open(page, { appearance });
      const agent = await box(page, `${AGENT} > .body`);
      const changes = await box(page, `${CHANGES} > .body`);
      const gap = changes.x - (agent.x + agent.width);
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(gap).toBeLessThanOrEqual(10);
      const y = agent.y + agent.height / 2;
      const between = await pixel(page, agent.x + agent.width + gap / 2, y);
      // The ground in the gap is the ground under the headers, and the
      // cards stand off it, lighter in either theme.
      const ground = await pixel(page, agent.x + agent.width + gap / 2, agent.y - 20);
      expect(between).toEqual(ground);
      expect(lightness(await pixel(page, agent.x + agent.width / 2, y))).toBeGreaterThan(lightness(between));
      // The sessions pane is the ground too.
      const sessions = await box(page, SESSIONS);
      expect(await pixel(page, sessions.x + sessions.width / 2, sessions.y + sessions.height - 60)).toEqual(ground);
    });
  }

  test("lay every header on one band, its card's top edge where the sessions header's rule lies", async ({ page }) => {
    await open(page);
    const sessions = await box(page, `${SESSIONS} > header`);
    for (const pane of [AGENT, CHANGES]) {
      const header = await box(page, `${pane} > header`);
      const card = await box(page, `${pane} > .body`);
      expect(header.y).toBeCloseTo(sessions.y, 0);
      expect(header.height).toBeCloseTo(sessions.height, 0);
      expect(card.y).toBeCloseTo(sessions.y + sessions.height, 0);
    }
    // The band starts at the window's top, the sessions pane at its edge.
    expect(sessions.y).toBeLessThanOrEqual(1);
    expect((await box(page, SESSIONS)).x).toBe(0);
  });

  test("mark the focused card along its top, ending square in its rounded corners", async ({ page }) => {
    await open(page);
    await page.locator(`${CHANGES} > .body`).click({ position: { x: 200, y: 300 } });
    const mark = await page.locator(`${CHANGES} > .body`).evaluate((card) => {
      const style = getComputedStyle(card, "::before");
      return { top: style.borderTopWidth, side: style.borderLeftWidth, bottom: style.borderBottomWidth, height: style.height, radius: style.borderTopLeftRadius };
    });
    expect(mark).toEqual({ top: "2px", side: "2px", bottom: "0px", height: mark.radius, radius: "10px" });
    const agent = await page.locator(`${AGENT} > .body`).evaluate((card) => getComputedStyle(card, "::before").content);
    expect(agent).toBe("none");
  });
});

for (const look of ["modern", "terminal"]) {
  test(`every header in the ${look} look is one height, the titles on one line`, async ({ page }) => {
    await open(page, { look });
    await page.keyboard.press(`${MOD}+j`);
    await expect(page.locator("section[data-pane='terminal']")).toBeVisible();
    const heads = [`${SESSIONS} > header`, `${AGENT} > header`, `${CHANGES} > header`, "section[data-pane='terminal'] .top"];
    const heights = await Promise.all(heads.map(async (head) => (await box(page, head)).height));
    for (const height of heights) expect(height).toBeCloseTo(look === "modern" ? 40 : 35, 0);
    const titles = await Promise.all(
      [`${SESSIONS} > header .title`, `${AGENT} > header .title`, `${CHANGES} > header .title`].map((title) => box(page, title)),
    );
    for (const title of titles) {
      expect(title.y).toBeCloseTo(titles[0].y, 0);
      expect(title.height).toBeCloseTo(titles[0].height, 0);
    }
  });

  test(`a divider in the ${look} look takes hold over the gap and a little into the panes either side, and no further`, async ({ page }) => {
    await open(page, { look });
    const divider = await box(page, DIVIDER);
    // The reach into either pane is 4 pixels in both looks.
    const reach = 4;
    const y = divider.y + divider.height / 2;
    await page.mouse.move(10, y);
    expect(await heldAt(page, divider.x + divider.width / 2, y)).toBe("col-resize");
    expect(await heldAt(page, divider.x - reach + 1, y)).toBe("col-resize");
    expect(await heldAt(page, divider.x + divider.width + reach - 1, y)).toBe("col-resize");
    expect(await heldAt(page, divider.x - reach - 2, y)).toBeNull();
    expect(await heldAt(page, divider.x + divider.width + reach + 2, y)).toBeNull();
    // Nothing is drawn in it at rest.
    expect(await lineOpacity(page)).toBe(0);
    expect(await gripOpacity(page)).toBe(0);
  });
}

test.describe("a divider", () => {
  test("fades a grip in as the pointer nears, follows it along, and holds it full on the reach", async ({ page }) => {
    await open(page);
    const divider = await box(page, DIVIDER);
    const y = divider.y + 200;
    await page.mouse.move(divider.x - 200, y);
    await expect.poll(() => gripOpacity(page)).toBe(0);
    await page.mouse.move(divider.x - 14, y, { steps: 3 });
    await expect.poll(() => gripOpacity(page)).toBeGreaterThan(0);
    expect(await gripOpacity(page)).toBeLessThan(1);
    const grip = await box(page, `${DIVIDER} > .grip`);
    expect(Math.abs(grip.y + grip.height / 2 - y)).toBeLessThanOrEqual(1);
    await page.mouse.move(divider.x + divider.width / 2, y + 60, { steps: 2 });
    await expect.poll(() => gripOpacity(page)).toBe(1);
    const moved = await box(page, `${DIVIDER} > .grip`);
    expect(Math.abs(moved.y + moved.height / 2 - (y + 60))).toBeLessThanOrEqual(1);
  });

  test("draws its line while dragged, and the drag moves it as the pointer goes", async ({ page }) => {
    await open(page);
    const before = await box(page, CHANGES);
    const divider = await box(page, DIVIDER);
    const x = divider.x + divider.width / 2;
    const y = divider.y + 200;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 40, y, { steps: 4 });
    expect(await lineOpacity(page)).toBe(1);
    await page.mouse.up();
    expect(await lineOpacity(page)).toBe(0);
    expect((await box(page, CHANGES)).width).toBeCloseTo(before.width + 40, 0);
  });

  test("under the keyboard draws its line with the grip at its middle, and the status bar names the keys", async ({ page }) => {
    await open(page);
    const width = (await box(page, CHANGES)).width;
    await page.locator(DIVIDER).focus();
    await page.keyboard.press("ArrowLeft");
    expect((await box(page, CHANGES)).width).toBeCloseTo(width + 8, 0);
    expect(await lineOpacity(page)).toBe(1);
    await expect(page.getByTestId("flash-readout")).toHaveText("Arrows resize, Shift for more, Home resets");
    const divider = await box(page, DIVIDER);
    const grip = await box(page, `${DIVIDER} > .grip`);
    expect(Math.abs(grip.y + grip.height / 2 - (divider.y + divider.height / 2))).toBeLessThanOrEqual(1);
    await page.keyboard.press("Home");
    expect((await box(page, CHANGES)).width).toBeCloseTo(width, 0);
    await page.locator(`${AGENT} > .body`).click();
    await expect(page.getByTestId("flash-readout")).toHaveText("");
    expect(await lineOpacity(page)).toBe(0);
  });

  test("gives way to a scroll bar at the edge of the pane under its reach", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
    await page.goto("/");
    await page.getByTestId("start-agent").click();
    await expect(page.getByTestId("conversation")).toBeVisible();
    const divider = await box(page, DIVIDER);
    const x = divider.x - 2;
    const y = divider.y + 300;
    // A thread too short to scroll leaves the reach to the divider.
    await page.mouse.move(x, y, { steps: 2 });
    await expect.poll(() => heldAt(page, x, y)).toBe("col-resize");
    await page.evaluate(`(() => { const f = window.__integrated;
      for (let at = 0; at < 8; at++) {
        f.send("int-1", crypto.randomUUID(), "Question " + at);
        f.turn("int-1", "Answer " + at + ": " + "a sentence that fills the thread. ".repeat(20));
      } })()`);
    const thread = page.getByTestId("thread");
    await expect.poll(() => thread.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    const edge = (await thread.boundingBox())!;
    expect(edge.x + edge.width).toBeGreaterThan(x);
    await page.mouse.move(x - 30, y);
    await page.mouse.move(x, y, { steps: 2 });
    await expect.poll(() => heldAt(page, x, y)).toBeNull();
    await expect(page.locator(DIVIDER)).toHaveAttribute("data-yield-before", "");
    // The gap itself still takes hold.
    expect(await heldAt(page, divider.x + divider.width / 2, y)).toBe("col-resize");
  });
});

test.describe("where a divider between panes meets the one over the terminal panel", () => {
  test("the pointer drags both, and a double-click puts both back", async ({ page }) => {
    await open(page);
    await page.keyboard.press(`${MOD}+j`);
    const panel = page.locator("[data-testid='terminal-slot']").first();
    await expect(panel).toBeVisible();
    const junction = page.locator("[data-testid='junction'][data-side='changes']");
    await expect(junction).toBeVisible();
    const meet = (await junction.boundingBox())!;
    const changes = await box(page, CHANGES);
    const height = (await panel.boundingBox())!.height;
    const x = meet.x + meet.width / 2;
    const y = meet.y + meet.height / 2;
    expect(await heldAt(page, x, y)).toBe("move");
    await page.mouse.move(x, y);
    await expect(page.locator(DIVIDER)).toHaveAttribute("data-met", "");
    await expect(page.locator(".splitter[data-divider='terminal']")).toHaveAttribute("data-met", "");
    await page.mouse.down();
    await page.mouse.move(x + 30, y - 40, { steps: 5 });
    await page.mouse.up();
    expect((await box(page, CHANGES)).width).toBeCloseTo(changes.width - 30, 0);
    expect((await panel.boundingBox())!.height).toBeCloseTo(height + 40, 0);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("chord.layout") ?? "{}"));
    expect(stored.terminal).toBeCloseTo(height + 40, 0);
    const moved = (await junction.boundingBox())!;
    await page.mouse.dblclick(moved.x + moved.width / 2, moved.y + moved.height / 2);
    await expect.poll(async () => (await box(page, CHANGES)).width).toBeCloseTo(changes.width, 0);
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeCloseTo(height, 0);
  });
});

test.describe("the folded sessions column", () => {
  const platforms = [
    { name: "macOS", reported: "MacIntel", modern: 86, terminal: 74 },
    { name: "Linux", reported: "Linux x86_64", modern: 50, terminal: 50 },
  ];
  for (const platform of platforms) {
    for (const look of ["modern", "terminal"] as const) {
      test(`is ${platform[look]} wide on ${platform.name} in the ${look} look, in and out of full screen`, async ({ page }) => {
        await open(page, { look, platform: platform.reported });
        await page.keyboard.press(platform.name === "macOS" ? "Meta+b" : "Control+b");
        await expect.poll(async () => (await box(page, SESSIONS)).width).toBeCloseTo(platform[look], 0);
        expect(await foldedWidth(page)).toBe(platform[look]);
        const agent = await box(page, `${AGENT} > header .title`);
        await page.evaluate(() => (window as unknown as { __fullScreen: (on: boolean) => void }).__fullScreen(true));
        await expect(page.locator(SESSIONS)).toBeVisible();
        expect((await box(page, SESSIONS)).width).toBeCloseTo(platform[look], 0);
        expect(await box(page, `${AGENT} > header .title`)).toEqual(agent);
      });
    }
  }

  test("on macOS holds the window's buttons on the ground with even room either side, and shows the start of each name", async ({ page }) => {
    await open(page, { platform: "MacIntel" });
    await page.getByTestId("start-agent").click();
    await page.keyboard.press("Meta+b");
    await expect.poll(async () => (await box(page, SESSIONS)).width).toBeCloseTo(86, 0);
    // The buttons stand 18 to 76 pixels in, on the header row's middle.
    const card = await box(page, `${AGENT} > .body`);
    expect(card.x - 76).toBeCloseTo(18, 0);
    const header = await box(page, `${SESSIONS} > header`);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __controlsCentre?: number }).__controlsCentre)).toBe(
      Math.round(header.y + header.height / 2),
    );
    const name = page.locator(`${SESSIONS} [data-testid='session-row'] .label`).first();
    await expect(name).toBeVisible();
    expect((await name.boundingBox())!.x).toBeLessThan(86);
  });

  test("on Linux keeps the menu button on its ground, and the window controls stand flush in the window's corner", async ({ page }) => {
    await open(page, { platform: "Linux x86_64" });
    const controls = await box(page, "[data-testid='window-controls']");
    const viewport = page.viewportSize()!;
    expect(controls.x + controls.width).toBeCloseTo(viewport.width, 0);
    expect(controls.y).toBe(0);
    const header = await box(page, `${CHANGES} > header`);
    expect(controls.height).toBeCloseTo(header.y + header.height, 0);
    await page.keyboard.press("Control+b");
    await expect.poll(async () => (await box(page, SESSIONS)).width).toBeCloseTo(50, 0);
    const menu = await box(page, `${SESSIONS} [data-testid='app-menu']`);
    const column = await box(page, SESSIONS);
    expect(menu.x - column.x).toBeCloseTo(column.x + column.width - (menu.x + menu.width), 0);
  });

  test("on Linux in the terminal look keeps the window controls in the box at the right", async ({ page }) => {
    await open(page, { look: "terminal", platform: "Linux x86_64" });
    const controls = await box(page, "[data-testid='window-controls']");
    const pane = await box(page, CHANGES);
    expect(controls.x + controls.width).toBeCloseTo(pane.x + pane.width - 1, 0);
  });
});

test("the grip fades without motion where the system asks for less of it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  const duration = await page.locator(`${DIVIDER} > .grip`).evaluate((grip) => getComputedStyle(grip).transitionDuration);
  expect(duration).toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const eased = await page.locator(`${DIVIDER} > .grip`).evaluate((grip) => getComputedStyle(grip).transitionDuration);
  expect(eased).not.toBe("0s");
});

test("more contrast outlines the cards and draws a line in the dividers inside a pane", async ({ page }) => {
  await open(page);
  await page.getByTestId("file-tree").getByText("mod.rs").first().click();
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "reviewing");
  const edge = () => page.locator(`${AGENT} > .body`).evaluate((card) => getComputedStyle(card, "::after").borderTopColor);
  const inner = page.getByRole("separator", { name: "Resize the file tree" }).locator(".rest");
  const rest = () => inner.evaluate((line) => getComputedStyle(line).backgroundColor);
  expect(await edge()).toBe("rgba(0, 0, 0, 0)");
  expect(await rest()).toBe("rgba(0, 0, 0, 0)");
  await page.emulateMedia({ contrast: "more" });
  await expect.poll(edge).not.toBe("rgba(0, 0, 0, 0)");
  await expect.poll(rest).not.toBe("rgba(0, 0, 0, 0)");
});

// The ground is the darkest tone let through by the strength, so short of
// full strength, where the background alone shows, the headers on it stay
// apart from the cards.
test("over a background of the user's own in dark, the ground under the headers is darker than the cards", async ({ page }) => {
  const dusk = {
    dots: [
      { hue: 282, chroma: 0.85 },
      { hue: 352, chroma: 0.8 },
    ],
    harmony: "free",
    strength: 0.45,
    grain: 0,
  };
  await open(page, { appearance: "dark", settings: { backgrounds: { teal: dusk } } });
  await expect(page.locator("html")).toHaveAttribute("data-background", "");
  await backgroundAtRest(page);
  const card = await box(page, `${AGENT} > .body`);
  const header = await box(page, `${AGENT} > header`);
  // In the gap past the agent's header, clear of anything it holds.
  const ground = await pixel(page, card.x + card.width + 4, header.y + header.height / 2);
  const solid = await pixel(page, card.x + card.width / 2, card.y + card.height / 2);
  expect(lightness(ground)).toBeLessThan(lightness(solid));
  // The header carries no ground of its own: what shows through it is the
  // window's.
  expect(await page.locator(`${AGENT} > header`).evaluate((head) => getComputedStyle(head).backgroundImage)).toBe("none");
});

test.describe("the focused card's mark", () => {
  /** How far a colour is from another, channel by channel. */
  const far = (a: [number, number, number], b: [number, number, number]) =>
    Math.max(...a.map((value, at) => Math.abs(value - b[at])));

  async function accent(page: Page): Promise<[number, number, number]> {
    return page.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const [r, g, b] = getComputedStyle(probe).color.match(/\d+/g)!.map(Number);
      probe.remove();
      return [r, g, b] as [number, number, number];
    });
  }

  test("lies under an agent's question, which stands over the panes", async ({ page }) => {
    await open(page);
    await page.locator(`${AGENT} > .body`).click({ position: { x: 100, y: 200 } });
    await page.evaluate((project) => {
      (window as unknown as { __settingsRequest: (call: unknown) => void }).__settingsRequest({
        id: "c-1",
        tool: "settings_change",
        arguments: { palette: "amber", reason: "The user asked for warmer colours." },
        cwd: project,
        session: null,
      });
    }, PROJECT);
    const ask = page.getByTestId("settings-ask");
    await expect(ask).toBeVisible();
    const question = (await ask.boundingBox())!;
    const card = await box(page, `${AGENT} > .body`);
    // The question straddles the card's top edge, where the mark runs.
    expect(question.y).toBeLessThan(card.y);
    expect(question.y + question.height).toBeGreaterThan(card.y + 2);
    const under = await pixel(page, question.x + question.width / 2, card.y + 1);
    expect(far(under, await accent(page))).toBeGreaterThan(40);
  });

  for (const contrast of [false, true]) {
    test(`stands over the editor's find bar${contrast ? ", the outline too under more contrast" : ""}`, async ({ page }) => {
      await page.setViewportSize({ width: 1728, height: 1000 });
      if (contrast) await page.emulateMedia({ contrast: "more" });
      await open(page);
      await page.getByTestId("mode-editor").click();
      await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "editing");
      await page.getByTestId("file-tree").getByText("README.md").dblclick();
      await page.locator(".cm-content").click();
      await page.keyboard.press(`${MOD}+f`);
      await expect(page.getByTestId("find-field")).toBeFocused();
      const card = await box(page, `${CHANGES} > .body`);
      const find = (await page.locator(".cm-panels-top").boundingBox())!;
      // The find bar runs along the card's top over the editor.
      expect(find.y).toBeCloseTo(card.y, 0);
      const colour = await accent(page);
      for (const x of [find.x + find.width / 2, card.x + card.width - 12]) {
        expect(far(await pixel(page, x, card.y + 0.5), colour)).toBeLessThan(40);
      }
      if (contrast) {
        // Off the focus mark, at the card's right edge under the find bar,
        // the outline still shows.
        await page.locator(`${AGENT} > .body`).click({ position: { x: 100, y: 300 } });
        const edge = await page.locator(`${CHANGES} > .body`).evaluate((body) => getComputedStyle(body, "::after").borderRightColor);
        const right = await pixel(page, card.x + card.width - 1, find.y + find.height / 2);
        const rule = edge.match(/\d+/g)!.slice(0, 3).map(Number) as [number, number, number];
        expect(far(right, rule)).toBeLessThan(24);
      }
    });
  }
});

test("the peeked sessions pane stands over the agent's card as a sheet, with a shadow", async ({ page }) => {
  await open(page);
  await page.getByTestId("file-tree").getByText("mod.rs").first().click();
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "reviewing");
  await page.keyboard.press(`${MOD}+1`);
  await expect(page.locator(".sessions-slot.peeking")).toHaveCount(1);
  const shadow = await page.locator(`.sessions-slot.peeking ${SESSIONS}`).evaluate((pane) => getComputedStyle(pane).boxShadow);
  expect(shadow).not.toBe("none");
});

test("the headers' quiet text holds 4.5:1 on the light ground", async ({ page }) => {
  await open(page);
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("state-readout")).toHaveText("running");
  // A session in a worktree, which the changes header names.
  await page.evaluate((project) => {
    (window as unknown as { __cwds: Record<string, string> }).__cwds = { "pty-1": `${project}/.claude/worktrees/feature` };
  }, PROJECT);
  const meta = page.locator(`${CHANGES} > header .meta`);
  await expect(meta).toHaveText("worktree feature", { timeout: 6000 });
  const ratio = await meta.evaluate((text) => {
    // Read as rgb(), or as color(srgb ...) on a scale of one for a mix.
    const channels = (colour: string) => {
      const values = colour.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      return colour.startsWith("color(") ? values.map((value) => value * 255) : values;
    };
    const lum = (colour: string) => {
      const [r, g, b] = channels(colour).map((value) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ground = getComputedStyle(document.querySelector(".frame")!).backgroundColor;
    const [a, b] = [lum(getComputedStyle(text).color), lum(ground)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test("the background picker's small window draws the ground with a card standing on it", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("background-picker")).toBeVisible();
  const mini = page.locator("[data-testid='background-picker'] .mini").first();
  const window = (await mini.boundingBox())!;
  const card = (await mini.locator(".card").boundingBox())!;
  // Clear of the sessions column on the left, under the header row, and
  // in from the right and the foot.
  expect(card.x - window.x).toBeGreaterThan(window.width / 4);
  expect(card.y - window.y).toBeGreaterThanOrEqual(8);
  expect(window.x + window.width - (card.x + card.width)).toBeGreaterThan(1);
  expect(window.y + window.height - (card.y + card.height)).toBeGreaterThan(4);
});

// A round of review past the workflow's limit is asked in the
// orchestrator's dock, over its composer: inside its card, clear of the
// card's rounded corners.
test("the dock's round question stands inside the agent's card, clear of its corners", async ({ page }) => {
  const conduct = (id: string, args: Record<string, unknown>) =>
    page.evaluate(
      ({ project, id, args }) =>
        (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
          id,
          tool: "start",
          arguments: { project, prompt: "Go", ...args },
          cwd: project,
          session: "integrated-session-1",
        }),
      { project: PROJECT, id, args },
    );
  const answered = (id: string) =>
    page.evaluate(
      (id) =>
        ((window as unknown as { __conductAnswers?: { id: string }[] }).__conductAnswers ?? []).some(
          (answer) => answer.id === id,
        ),
      id,
    );
  const once = structuredClone(WITH_WORKFLOW);
  (once.workflows.list[0].steps[1] as { limit: number }).limit = 1;
  await open(page, { settings: { integrated: ["claude-code"], ...once } });
  await page.getByTestId("start-agent").click();
  const conversation = page.locator("[data-testid='conversation'].active");
  await expect(conversation.getByTestId("composer-input")).toBeEnabled();
  await conduct("c-start", { name: "Fix the cache", step: "Work" });
  await expect.poll(() => answered("c-start")).toBe(true);
  for (const id of ["c-2", "c-3"]) {
    await conduct(id, { step: "Review", work: "integrated-session-2" });
    await expect.poll(() => answered(id)).toBe(true);
  }
  await conduct("c-4", { step: "Review", work: "integrated-session-2", prompt: "Look once more" });
  const dock = conversation.getByTestId("round-dock");
  await expect(dock).toBeVisible();
  const card = await box(page, `${AGENT} > .body`);
  const inside = (await dock.boundingBox())!;
  const radius = 10;
  expect(inside.x - card.x).toBeGreaterThanOrEqual(radius);
  expect(card.x + card.width - (inside.x + inside.width)).toBeGreaterThanOrEqual(radius);
  expect(inside.y).toBeGreaterThan(card.y + radius);
  // The composer stands under it, and both clear the card's foot.
  const composer = (await conversation.getByTestId("composer").boundingBox())!;
  expect(composer.y).toBeGreaterThanOrEqual(inside.y + inside.height);
  expect(card.y + card.height - (composer.y + composer.height)).toBeGreaterThanOrEqual(radius);
});

// Find in the conversation opens a bar near the card's top right: inside
// the card, clear of its rounded corner, and under the card's mark, which
// runs on above it.
test("the conversation's find bar stands inside the agent's card, under its mark", async ({ page }) => {
  await open(page, { settings: { integrated: ["claude-code"] } });
  await page.getByTestId("start-agent").click();
  const input = page.getByTestId("composer-input");
  await expect(input).toBeVisible();
  await input.fill("The cache is built again on every start.");
  await page.keyboard.press("Enter");
  await input.click();
  await page.keyboard.press(`${MOD}+f`);
  await expect(page.getByTestId("conversation-find-input")).toBeFocused();
  const bar = (await page.getByTestId("conversation-find-bar").boundingBox())!;
  const card = await box(page, `${AGENT} > .body`);
  const radius = 10;
  expect(card.x + card.width - (bar.x + bar.width)).toBeGreaterThanOrEqual(radius);
  expect(bar.y - card.y).toBeGreaterThan(2);
  expect(bar.x).toBeGreaterThan(card.x);
  const accent = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const [r, g, b] = getComputedStyle(probe).color.match(/\d+/g)!.map(Number);
    probe.remove();
    return [r, g, b];
  });
  const above = await pixel(page, bar.x + bar.width / 2, card.y + 0.5);
  expect(Math.max(...above.map((value, at) => Math.abs(value - accent[at])))).toBeLessThan(40);
});
