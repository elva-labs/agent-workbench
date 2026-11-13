import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * Browser tabs belong to the session that opened them: the fold, its count
 * and the tab strip show the tabs of the session on screen, each session
 * keeps its own tab in front, and closing a session closes its tabs. A tab
 * opened with no session on screen belongs to the project.
 */

const CHANGES = "section[data-pane='changes']";

async function push(
  page: Page,
  request: {
    id: string;
    tool: string;
    arguments?: Record<string, unknown>;
    session?: string | null;
  },
) {
  await page.evaluate(
    ({ project, request }) =>
      (
        window as unknown as { __browserRequest: (call: unknown) => void }
      ).__browserRequest({
        id: request.id,
        tool: request.tool,
        arguments: request.arguments ?? {},
        cwd: project,
        session: request.session ?? null,
      }),
    { project: PROJECT, request },
  );
}

interface Answer {
  id: string;
  content: string | null;
  error: string | null;
}

const answerTo = async (page: Page, id: string) => {
  const all = await page.evaluate(
    () =>
      (window as unknown as { __browserAnswers?: Answer[] }).__browserAnswers ??
      [],
  );
  return all.find((answer) => answer.id === id) ?? null;
};

async function ask(
  page: Page,
  id: string,
  tool: string,
  session: string,
  args: Record<string, unknown> = {},
) {
  await push(page, { id, tool, session, arguments: args });
  await expect.poll(() => answerTo(page, id)).not.toBeNull();
  return (await answerTo(page, id))!;
}

/** The tabs the fake core holds, every session's. */
const allTabs = (page: Page) =>
  page.evaluate(async () => {
    const core = (window as unknown as {
      __WORKBENCH_CORE__: { browserTabs(): Promise<{ tabs: unknown[] }> };
    }).__WORKBENCH_CORE__;
    return (await core.browserTabs()).tabs.length;
  });

async function twoSessions(page: Page) {
  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session").click();
  await expect(page.locator("[data-testid='session-row']")).toHaveCount(2);
  await expect(page.locator(".session.on")).toContainText("session 2");
}

/** Opens a tab by hand from the fold and gives it an address. */
async function openByHand(page: Page, address: string) {
  await page.getByTestId("browser-fold-new-tab").click();
  const field = page.getByTestId("browser-address");
  await field.fill(address);
  await field.press("Enter");
  await expect(page.getByTestId("browser-tab")).not.toHaveCount(0);
}

const toSession1 = (page: Page) =>
  page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
const toSession2 = (page: Page) =>
  page.keyboard.press("ControlOrMeta+Shift+ArrowDown");

test.beforeEach(async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator(CHANGES)).toBeVisible();
});

test("a tab opened by hand stays with the session it was opened beside", async ({ page }) => {
  await twoSessions(page);
  await openByHand(page, "example.com");
  await expect(page.getByTestId("browser-fold")).toContainText("Browser (1)");
  await expect(page.getByTestId("browser-tab")).toHaveCount(1);

  await toSession1(page);
  await expect(page.locator(".session.on")).toContainText("session 1");
  await expect(page.getByTestId("browser-fold")).toContainText("Browser (0)");

  await toSession2(page);
  await expect(page.locator(".session.on")).toContainText("session 2");
  await expect(page.getByTestId("browser-fold")).toContainText("Browser (1)");
  await expect(page.getByTestId("browser-tab")).toHaveCount(1);
  await expect(page.getByTestId("browser-address")).toHaveValue(/example\.com/);
});

test("each session keeps its own tab in front", async ({ page }) => {
  await twoSessions(page);
  await openByHand(page, "example.com");
  await page.getByTestId("browser-new-tab").click();
  const field = page.getByTestId("browser-address");
  await field.fill("example.org");
  await field.press("Enter");
  // The first of session 2's two tabs is the one in front.
  await page.getByTestId("browser-tab-select").first().click();
  await expect(field).toHaveValue(/example\.com/);

  await toSession1(page);
  await expect(page.locator(".session.on")).toContainText("session 1");
  await page.getByTestId("browser-fold").click();
  await openByHand(page, "example.net");
  await expect(page.getByTestId("browser-tab")).toHaveCount(1);
  await expect(field).toHaveValue(/example\.net/);

  await toSession2(page);
  await expect(page.locator(".session.on")).toContainText("session 2");
  await expect(page.getByTestId("browser-tab")).toHaveCount(2);
  await expect(field).toHaveValue(/example\.com/);
  await expect(page.locator("[data-testid='browser-tab'].active")).toHaveAttribute("data-tab-id", "1");
});

test("a tab an agent opens for another session shows when the user switches to it", async ({ page }) => {
  await twoSessions(page);
  const opened = await ask(page, "o1", "browser_open", "session-1", { url: "http://localhost:3000" });
  expect(opened.error).toBeNull();
  await expect(page.getByTestId("browser-fold")).toContainText("Browser (0)");
  await expect(page.getByTestId("mode-readout")).toHaveText("working");

  await page.locator("[data-testid='session-row']").first().click();
  await expect(page.locator(".session.on")).toContainText("session 1");
  await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
  await expect(page.getByTestId("browser-fold")).toContainText("Browser (1)");
  await expect(page.getByTestId("browser-tab")).toHaveCount(1);
});

test("with no session on screen the tab belongs to the project and shows there", async ({ page }) => {
  await openByHand(page, "example.com");
  await expect(page.getByTestId("browser-fold")).toContainText("Browser (1)");

  // The sessions pane is folded while reviewing: focusing it brings it back.
  await page.keyboard.press("ControlOrMeta+1");
  await page.getByTestId("new-session").click();
  await expect(page.locator(".session.on")).toContainText("session 1");
  await expect(page.getByTestId("browser-fold")).toContainText("Browser (0)");

  await expect(page.getByTestId("mode-readout")).toHaveText("working");
  await page.getByTestId("session-row").hover();
  await page.getByTestId("close-session").click();
  await expect(page.getByTestId("session-row")).toHaveCount(0);
  await expect(page.getByTestId("browser-fold")).toContainText("Browser (1)");
});

test("closing a session closes its tabs, and no one else's", async ({ page }) => {
  await twoSessions(page);
  await page.getByTestId("new-session").click();
  await expect(page.locator(".session.on")).toContainText("session 3");
  // Both open off screen, so the sessions pane stays in view.
  await ask(page, "c1", "browser_open", "session-1", { url: "http://localhost:3000" });
  await ask(page, "c2", "browser_open", "session-2", { url: "http://localhost:4000" });
  expect(await allTabs(page)).toBe(2);

  await page.getByTestId("close-session").first().click({ force: true });
  await expect(page.locator("[data-testid='session-row']")).toHaveCount(2);
  await expect.poll(() => allTabs(page)).toBe(1);
  const left = await ask(page, "c3", "browser_tabs", "session-2");
  expect(left.content).toContain("localhost:4000");
});

test("the tools act within the calling session's own tabs", async ({ page }) => {
  await twoSessions(page);
  await ask(page, "t1", "browser_open", "session-1", { url: "http://localhost:3000" });
  await ask(page, "t2", "browser_open", "session-2", { url: "http://localhost:4000" });

  const one = await ask(page, "t3", "browser_tabs", "session-1");
  expect(one.content).toContain("localhost:3000");
  expect(one.content).not.toContain("localhost:4000");
  const two = await ask(page, "t4", "browser_tabs", "session-2");
  expect(two.content).toContain("localhost:4000");
  expect(two.content).not.toContain("localhost:3000");

  // Tab 2 is session 2's: session 1 may not read or close it.
  const read = await ask(page, "t5", "browser_snapshot", "session-1", { tab: 2 });
  expect(read.error).toBe("Tab 2 belongs to another session.");
  const close = await ask(page, "t6", "browser_close", "session-1", { tab: 2 });
  expect(close.error).toBe("Tab 2 belongs to another session.");
  expect(await allTabs(page)).toBe(2);
});

test("a row carries one mark, the state dot, and says agent in its meta when an agent opened it", async ({ page }) => {
  await page.getByTestId("new-session").click();
  await expect(page.locator("[data-testid='session-row']")).toHaveCount(1);
  await ask(page, "m1", "browser_open", "session-1", { url: "http://localhost:3000" });
  await page.getByTestId("browser-fold").click();
  await page.getByTestId("browser-new-tab").click();
  const field = page.getByTestId("browser-address");
  await field.fill("example.com");
  await field.press("Enter");

  const rows = page.getByTestId("browser-fold-row");
  await expect(rows).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect(rows.nth(index).getByTestId("browser-fold-dot")).toHaveCount(1);
    await expect(rows.nth(index).locator(".agent-mark")).toHaveCount(0);
  }
  await expect(rows.nth(0).getByTestId("browser-fold-agent")).toHaveText("agent");
  await expect(rows.nth(1).getByTestId("browser-fold-agent")).toHaveCount(0);
  await expect(page.getByTestId("browser-tab").locator(".agent-mark")).toHaveCount(0);
});
