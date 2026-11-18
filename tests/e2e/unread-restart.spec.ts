import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * A row unread when the window goes is unread when it comes back, with the
 * line under its name, whether it went unread by itself or was marked by
 * hand, and counts as waiting; coming back says nothing of it. The one the
 * restore puts on screen is not read by being put there.
 */

const ROW = "[data-testid='session-row']";
const LINE = "Plugin in main-truck staged, need approvals";

const row = (page: Page, name: string) => page.locator(ROW).filter({ hasText: name });

/** The newest session's agent sets its terminal's title, as Claude Code
    does, which names its row. */
function title(page: Page, name: string) {
  return page.evaluate((name) => {
    const w = window as unknown as {
      __spawns: { ptyId: string }[];
      __say: (id: string, text: string) => void;
    };
    w.__say(w.__spawns[w.__spawns.length - 1].ptyId, `\x1b]0;\u2733 ${name}\x07`);
  }, name);
}

/** Two sessions, Alpha and Beta, the second on screen. Each is named by
    the title its agent sets, which a row keeps across a restart. */
async function two(page: Page) {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await page.getByTestId("new-session").click();
  await expect(page.locator(ROW)).toHaveCount(1);
  await title(page, "Alpha");
  await expect(row(page, "Alpha")).toHaveCount(1);
  await page.getByTestId("new-session").click();
  await expect(page.locator(ROW)).toHaveCount(2);
  await title(page, "Beta");
  await expect(row(page, "Beta")).toHaveCount(1);
}

function notify(page: Page, session: string, text: string) {
  return page.evaluate(
    ({ session, text }) =>
      (window as unknown as { __notifyRequest: (request: unknown) => void }).__notifyRequest({
        text,
        cwd: "/home/ada/dev/demo",
        session,
      }),
    { session, text },
  );
}

const notified = (page: Page) =>
  page.evaluate(() => (window as unknown as { __notified?: unknown[] }).__notified?.length ?? 0);

test("brings an unread row back unread, with its line, and says nothing of it", async ({ page }) => {
  await two(page);
  await notify(page, "session-1", LINE);
  const first = row(page, "Alpha");
  await expect(first.locator(".dot")).toHaveClass(/unread/);

  await page.reload();
  await expect(page.locator(ROW)).toHaveCount(2);
  await expect(first.locator(".dot")).toHaveClass(/unread/);
  await expect(first.getByTestId("session-note")).toHaveText(LINE);
  await expect(page.getByTestId("waiting-readout")).toHaveText(/1 waiting/);
  await expect(row(page, "Beta").locator(".dot")).not.toHaveClass(/unread/);
  expect(await notified(page)).toBe(0);

  // Opened, it is read, and stays read through the next reload.
  await first.click();
  await expect(first.locator(".dot")).not.toHaveClass(/unread/);
  await page.reload();
  await expect(page.locator(ROW)).toHaveCount(2);
  await expect(page.getByTestId("waiting-readout")).toHaveCount(0);
});

test("brings a mark made by hand back with the line it put back", async ({ page }) => {
  await two(page);
  await notify(page, "session-1", LINE);
  const first = row(page, "Alpha");
  await first.click();
  await row(page, "Beta").click();
  await expect(first.getByTestId("session-note")).toHaveCount(0);
  await first.click({ button: "right" });
  await page.getByTestId("session-menu-unread").click();
  await expect(first.getByTestId("session-note")).toHaveText(LINE);

  await page.reload();
  await expect(first.locator(".dot")).toHaveClass(/unread/);
  await expect(first.getByTestId("session-note")).toHaveText(LINE);
  await first.click({ button: "right" });
  await expect(page.getByTestId("session-menu").getByRole("menuitem").first()).toHaveText("Mark as read");
});

test("keeps the unread row it puts on screen unread until the user leaves it and comes back", async ({ page }) => {
  await two(page);
  const second = row(page, "Beta");
  await second.click({ button: "right" });
  await page.getByTestId("session-menu-unread").click();
  await expect(second.locator(".dot")).toHaveClass(/unread/);

  await page.reload();
  await expect(page.locator(ROW)).toHaveCount(2);
  await expect(page.locator(".session.on")).toContainText("Beta");
  await expect(second.locator(".dot")).toHaveClass(/unread/);
  await expect(page.getByTestId("waiting-readout")).toHaveText(/1 waiting/);

  await row(page, "Alpha").click();
  await expect(second.locator(".dot")).toHaveClass(/unread/);
  await second.click();
  await expect(second.locator(".dot")).not.toHaveClass(/unread/);
});
