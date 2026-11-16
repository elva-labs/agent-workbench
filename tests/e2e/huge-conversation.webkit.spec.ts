import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";
import { longHistory } from "./longHistory";

// A conversation resumed with the history of one a session kept for days,
// in WebKit as well as Chromium: every way to its foot arrives at the very
// last row, and going to another session and back, or opening a fold, draws
// nothing again.

const H = "int-1";
const PAST = "past-huge";
const HUGE = "[data-testid='conversation'][data-session='s1']";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

const thread = (page: Page) => page.locator(`${HUGE} [data-testid='thread']`);

const fromFoot = (page: Page) => thread(page).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);

/** Whether the last row drawn is the conversation's last, with its foot
    in the view. */
const footInView = (page: Page) =>
  thread(page).evaluate((node) => {
    const rows = node.querySelector<HTMLElement>("[data-testid='thread-rows']")!;
    const last = rows.lastElementChild!.getBoundingClientRect();
    const view = node.getBoundingClientRect();
    return (parseFloat(rows.style.paddingBottom) || 0) === 0 && last.bottom <= view.bottom + 1 && last.bottom > view.top;
  });

async function openHuge(page: Page) {
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
  await page.evaluate(`window.__integrated.transcript("${PAST}", (${longHistory})({ start: ${now - 4 * 24 * 3_600_000} }))`);
  await page.getByTestId("past-session").click();
  await expect(page.locator(`${HUGE} [data-testid='run-began']`)).toBeVisible();
  await expect(page.locator(`${HUGE} [data-testid='earlier-reading']`)).toHaveCount(0);
  await expect.poll(() => fromFoot(page)).toBeLessThan(2);
}

/** Counts the rows the huge thread draws and lets go of from here on. */
const countRows = (page: Page) =>
  thread(page).evaluate((node) => {
    const counted = window as unknown as { __rowsChanged: number };
    counted.__rowsChanged = 0;
    new MutationObserver((records) => {
      for (const record of records) counted.__rowsChanged += record.addedNodes.length + record.removedNodes.length;
    }).observe(node.querySelector("[data-testid='thread-rows']")!, { childList: true });
  });

const rowsChanged = (page: Page) => page.evaluate(() => (window as unknown as { __rowsChanged: number }).__rowsChanged);

test.describe("a conversation as long as a real one kept for days", () => {
  test("opens at its foot, with the line where it was resumed just above the composer", async ({ page }) => {
    await openHuge(page);
    await expect.poll(() => footInView(page)).toBe(true);
    const line = (await page.locator(`${HUGE} [data-testid='run-began']`).boundingBox())!;
    const view = (await thread(page).boundingBox())!;
    const composer = (await page.locator(`${HUGE} [data-testid='composer']`).boundingBox())!;
    expect(view.y + view.height - (line.y + line.height)).toBeLessThan(40);
    expect(composer.y).toBeGreaterThanOrEqual(view.y + view.height - 1);
  });

  test("reaches its foot by the wheel from its top", async ({ page }) => {
    await openHuge(page);
    await thread(page).focus();
    await page.keyboard.press("Home");
    await expect.poll(() => thread(page).evaluate((node) => node.scrollTop)).toBe(0);
    await thread(page).hover();
    for (let step = 0; step < 300 && (await fromFoot(page)) > 1; step++) await page.mouse.wheel(0, 5000);
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await expect.poll(() => footInView(page)).toBe(true);
  });

  test("reaches its foot when the scroll bar is dragged to its end", async ({ page }) => {
    await openHuge(page);
    await thread(page).focus();
    await page.keyboard.press("Home");
    await expect.poll(() => thread(page).evaluate((node) => node.scrollTop)).toBe(0);
    // Held on the scroll bar and moved down to its end, a frame at a time,
    // then held there a moment, as a hand does.
    await thread(page).evaluate(async (node) => {
      node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      for (let step = 1; step <= 40; step++) {
        node.scrollTop = ((node.scrollHeight - node.clientHeight) * step) / 40;
        await frame();
      }
      for (let step = 0; step < 20; step++) {
        node.scrollTop = node.scrollHeight;
        await frame();
      }
      window.dispatchEvent(new PointerEvent("pointerup"));
    });
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await expect.poll(() => footInView(page)).toBe(true);
  });

  test("reaches its foot with End on the thread and with Latest", async ({ page }) => {
    await openHuge(page);
    await thread(page).focus();
    await page.keyboard.press("Home");
    await expect.poll(() => thread(page).evaluate((node) => node.scrollTop)).toBe(0);
    await page.keyboard.press("End");
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await expect.poll(() => footInView(page)).toBe(true);
    // A few screens up, something comes, and Latest goes to it.
    await thread(page).hover();
    for (let step = 0; step < 4; step++) await page.mouse.wheel(0, -1500);
    await expect.poll(() => fromFoot(page)).toBeGreaterThan(3000);
    await agent(page, `f.turn("${H}", "Something new at the foot.\\n\\nWith a second paragraph.");`);
    await page.locator(`${HUGE} [data-testid='jump-latest']`).click();
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await expect(page.locator(`${HUGE} [data-testid='agent-text']`).last()).toContainText("With a second paragraph.");
    await expect.poll(() => footInView(page)).toBe(true);
  });

  test("follows a reply streaming at its foot at every piece", async ({ page }) => {
    await openHuge(page);
    const furthest = await page.evaluate(
      async ({ id, selector }) => {
        const f = (window as unknown as { __integrated: { startTurn: (id: string) => void; emit: (id: string, event: unknown) => void } }).__integrated;
        const node = document.querySelector<HTMLElement>(selector)!;
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        f.startTurn(id);
        await frame();
        let furthest = 0;
        for (let piece = 0; piece < 120; piece++) {
          f.emit(id, { type: "text", block: "streamed", parent: null, text: `Piece ${piece} of a reply that streams in. `, done: false });
          await frame();
          furthest = Math.max(furthest, node.scrollHeight - node.scrollTop - node.clientHeight);
        }
        return furthest;
      },
      { id: H, selector: `${HUGE} [data-testid='thread']` },
    );
    expect(furthest).toBeLessThan(2);
    await expect(page.locator(`${HUGE} [data-testid='agent-text']`).last()).toContainText("Piece 119");
  });

  test("stays at its foot when the window is resized", async ({ page }) => {
    await openHuge(page);
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await expect.poll(() => footInView(page)).toBe(true);
  });

  test("going to another session and back draws no row again and keeps its place", async ({ page }) => {
    await openHuge(page);
    await page.getByTestId("new-session").click();
    await expect(page.locator("[data-testid='conversation'][data-session='s2'] [data-testid='composer-input']")).toBeVisible();
    await countRows(page);
    const huge = page.locator("[data-row='session:s1'] [data-testid='session-row']");
    const other = page.locator("[data-row='session:s2'] [data-testid='session-row']");
    for (let round = 0; round < 3; round++) {
      await huge.click();
      await expect(page.locator(HUGE)).toHaveClass(/active/);
      await other.click();
      await expect(page.locator("[data-testid='conversation'][data-session='s2']")).toHaveClass(/active/);
    }
    await huge.click();
    await expect(page.locator(HUGE)).toHaveClass(/active/);
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await expect.poll(() => footInView(page)).toBe(true);
    expect(await rowsChanged(page)).toBe(0);
  });

  test("lays out none of what a conversation behind another holds", async ({ page }) => {
    await openHuge(page);
    await page.getByTestId("new-session").click();
    await expect(page.locator("[data-testid='conversation'][data-session='s2'] [data-testid='composer-input']")).toBeVisible();
    // Behind the new one, the long conversation takes no room in the
    // window's layout, however much it holds.
    expect(await page.locator(HUGE).evaluate((node) => node.getClientRects().length)).toBe(0);
    expect(await thread(page).evaluate((node) => node.querySelectorAll("[data-row]").length)).toBeGreaterThan(0);
  });

  test("keeps the line read when going to another session and back", async ({ page }) => {
    await openHuge(page);
    await thread(page).hover();
    for (let step = 0; step < 6; step++) await page.mouse.wheel(0, -1200);
    await expect.poll(() => fromFoot(page)).toBeGreaterThan(5000);
    // The innermost block at the top of the view, and how far below the
    // top it stands.
    const mark = () =>
      thread(page).evaluate((node) => {
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
    const marked = () =>
      thread(page).evaluate((node) => node.querySelector("[data-mark]")!.getBoundingClientRect().top - node.getBoundingClientRect().top);
    await expect.poll(async () => Math.abs((await mark()) - (await mark()))).toBeLessThan(1);
    const before = await mark();
    await page.getByTestId("new-session").click();
    await expect(page.locator("[data-testid='conversation'][data-session='s2']")).toHaveClass(/active/);
    await page.locator("[data-row='session:s1'] [data-testid='session-row']").click();
    await expect(page.locator(HUGE)).toHaveClass(/active/);
    await expect.poll(async () => Math.abs((await marked()) - before)).toBeLessThan(1);
    await expect(page.locator(`${HUGE} [data-testid='jump-latest']`)).toHaveCount(0);
  });

  test("goes on to what came while it was behind another session, when it was at its foot", async ({ page }) => {
    await openHuge(page);
    // At the foot by the reader's own hand.
    await thread(page).hover();
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => fromFoot(page)).toBeGreaterThan(1000);
    for (let step = 0; step < 20 && (await fromFoot(page)) > 1; step++) await page.mouse.wheel(0, 1000);
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await page.getByTestId("new-session").click();
    await expect(page.locator("[data-testid='conversation'][data-session='s2']")).toHaveClass(/active/);
    // More than a few screens of it.
    for (let turn = 0; turn < 4; turn++)
      await agent(page, `f.turn("${H}", "What came while the session was behind, ${turn}.\\n\\n${"A paragraph that runs on. ".repeat(150)}");`);
    await page.locator("[data-row='session:s1'] [data-testid='session-row']").click();
    await expect(page.locator(HUGE)).toHaveClass(/active/);
    await expect.poll(() => fromFoot(page)).toBeLessThan(2);
    await expect(page.locator(`${HUGE} [data-testid='agent-text']`).last()).toContainText("What came while the session was behind, 3.");
    await expect.poll(() => footInView(page)).toBe(true);
  });

  test("opening and closing a fold draws no other row", async ({ page }) => {
    await openHuge(page);
    await countRows(page);
    const line = page.locator(`${HUGE} [data-testid='work-line']`).last();
    await line.click();
    await expect(line).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`${HUGE} [data-testid='work-steps']`).last()).toBeVisible();
    await line.click();
    await expect(line).toHaveAttribute("aria-expanded", "false");
    expect(await rowsChanged(page)).toBe(0);
  });
});
