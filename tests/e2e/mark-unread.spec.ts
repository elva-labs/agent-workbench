import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * A session's row menu marks it unread, and an unread row read: the row is
 * drawn as one that went unread by itself, with the line it last showed
 * under its name, and counts as waiting until the session is next opened.
 * The user did it, so nothing is said of it.
 */

const ROW = "[data-testid='session-row']";
const LINE = "Plugin in main-truck staged, need approvals";

const row = (page: Page, name: string) => page.locator(ROW).filter({ hasText: name });

/** Two terminal sessions, the second on screen. */
async function two(page: Page) {
  await installFakeCore(page, { open: [PROJECT], settings: { chime: true } });
  await page.goto("/");
  await page.getByTestId("new-session").click();
  await expect(row(page, "session 1")).toContainText("running");
  await page.getByTestId("new-session").click();
  await expect(page.locator(ROW)).toHaveCount(2);
}

/** What the window asked the system to say, and how often it chimed. */
function said(page: Page): Promise<{ notified: number; chimes: number }> {
  return page.evaluate(() => {
    const fake = window as unknown as { __notified?: unknown[]; __chimes?: number };
    return { notified: fake.__notified?.length ?? 0, chimes: fake.__chimes ?? 0 };
  });
}

const weight = (page: Page, name: string) =>
  row(page, name)
    .locator(".label")
    .evaluate((label) => Number(getComputedStyle(label).fontWeight));

test("marks a read session unread from its menu, with its last line, until it is opened", async ({ page }) => {
  await two(page);
  await page.evaluate(
    (text) =>
      (window as unknown as { __notifyRequest: (request: unknown) => void }).__notifyRequest({
        text,
        cwd: "/home/ada/dev/demo",
        session: "session-1",
      }),
    LINE,
  );
  const first = row(page, "session 1");
  await expect(first.getByTestId("session-note")).toHaveText(LINE);
  const unreadWeight = await weight(page, "session 1");

  // Read, then away again: the line goes with the look.
  await first.click();
  await expect(first.locator(".dot")).not.toHaveClass(/unread/);
  await expect(first.getByTestId("session-note")).toHaveCount(0);
  await row(page, "session 2").click();
  const before = await said(page);

  await first.click({ button: "right" });
  const menu = page.getByTestId("session-menu");
  await expect(menu.getByRole("menuitem").first()).toHaveText("Mark as unread");
  await page.getByTestId("session-menu-unread").click();
  await expect(menu).toHaveCount(0);

  // Drawn as it was when it went unread by itself.
  await expect(first.locator(".dot")).toHaveClass(/unread/);
  await expect(first.getByTestId("session-note")).toHaveText(LINE);
  await expect(first.getByTestId("session-note")).toBeVisible();
  expect(await weight(page, "session 1")).toBe(unreadWeight);
  expect(await weight(page, "session 1")).toBeGreaterThan(await weight(page, "session 2"));
  // The line on a line of its own, under the name.
  const name = (await first.locator(".label").boundingBox())!;
  const note = (await first.getByTestId("session-note").boundingBox())!;
  expect(note.y).toBeGreaterThanOrEqual(name.y + name.height - 1);
  await expect(page.getByTestId("waiting-readout")).toHaveText(/1 waiting/);
  expect(await said(page)).toEqual(before);

  // Unread, the menu offers the way back.
  await first.click({ button: "right" });
  await expect(menu.getByRole("menuitem").first()).toHaveText("Mark as read");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Opening it reads it.
  await first.click();
  await expect(first.locator(".dot")).not.toHaveClass(/unread/);
  await expect(first.getByTestId("session-note")).toHaveCount(0);
  await expect(page.getByTestId("waiting-readout")).toHaveCount(0);
});

test("keeps the session on screen unread until the user leaves it and comes back", async ({ page }) => {
  await two(page);
  const second = row(page, "session 2");

  // From the keyboard: the menu key on the row under the cursor.
  await second.click({ button: "right" });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+F10");
  await expect(page.getByTestId("session-menu").getByRole("menuitem").first()).toHaveText("Mark as unread");
  await page.keyboard.press("Enter");
  await expect(second.locator(".dot")).toHaveClass(/unread/);

  // Still looking at it: the window losing focus and gaining it again, or
  // a click on its own row, reads nothing.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  await second.click();
  await expect(second.locator(".dot")).toHaveClass(/unread/);
  await expect(page.getByTestId("waiting-readout")).toHaveText(/1 waiting/);

  // Away to the other and back.
  await row(page, "session 1").click();
  await expect(second.locator(".dot")).toHaveClass(/unread/);
  await second.click();
  await expect(second.locator(".dot")).not.toHaveClass(/unread/);
  await expect(page.getByTestId("waiting-readout")).toHaveCount(0);
});

test("marks an unread session read from its menu", async ({ page }) => {
  await two(page);
  await page.evaluate(() =>
    (window as unknown as { __notifyRequest: (request: unknown) => void }).__notifyRequest({
      text: "Over to you.",
      cwd: "/home/ada/dev/demo",
      session: "session-1",
    }),
  );
  const first = row(page, "session 1");
  await expect(first.locator(".dot")).toHaveClass(/unread/);
  await first.click({ button: "right" });
  await page.getByTestId("session-menu-read").click();
  await expect(first.locator(".dot")).not.toHaveClass(/unread/);
  await expect(first.getByTestId("session-note")).toHaveCount(0);
  await expect(page.getByTestId("waiting-readout")).toHaveCount(0);
});

/** A hook's word on a session, by its id. */
const hook = (page: Page, sessionId: string, kind: string, note?: string) =>
  page.evaluate(
    ({ sessionId, kind, note }) =>
      (window as unknown as { __sessionEvent: (event: unknown) => void }).__sessionEvent({ sessionId, kind, note }),
    { sessionId, kind, note },
  );

const focus = (page: Page, on: boolean) =>
  page.evaluate((on) => window.dispatchEvent(new Event(on ? "focus" : "blur")), on);

test("ends the mark on screen when the user writes to it, and announces news with its own line", async ({ page }) => {
  await two(page);
  const second = row(page, "session 2");
  await hook(page, "session-2", "prompt");
  await hook(page, "session-2", "stop", "First turn line.");
  await second.click({ button: "right" });
  await page.getByTestId("session-menu-unread").click();
  await expect(second.getByTestId("session-note")).toHaveText("First turn line.");

  // The user's own prompt reads it; the turn that ends in the background is
  // news, and the window coming back to it reads that.
  await hook(page, "session-2", "prompt");
  await expect(second.locator(".dot")).not.toHaveClass(/unread/);
  await focus(page, false);
  await hook(page, "session-2", "stop", "Done.");
  await expect(second.locator(".dot")).toHaveClass(/unread/);
  await focus(page, true);
  await expect(second.locator(".dot")).not.toHaveClass(/unread/);

  // Marked away from it, then a turn of its own ends: the new line, on the
  // row and in the notification.
  const first = row(page, "session 1");
  await hook(page, "session-1", "prompt");
  await hook(page, "session-1", "stop", "Old line.");
  await first.click();
  await second.click();
  await first.click({ button: "right" });
  await page.getByTestId("session-menu-unread").click();
  await expect(first.getByTestId("session-note")).toHaveText("Old line.");
  await focus(page, false);
  await hook(page, "session-1", "stop", "Background job done.");
  await expect(first.getByTestId("session-note")).toHaveText("Background job done.");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __notified?: { body: string }[] }).__notified?.at(-1)?.body),
    )
    .toBe("Background job done.");
});
