import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * Shells belong to the session they were opened beside: the panel lists,
 * follows and cycles through the shells of the session on screen, each
 * session keeps its own in front, and switching stops nothing. Closing a
 * session closes its shells, asking first while one has something running.
 * A shell opened with no session on screen belongs to the project. The
 * processes fold lists what runs under the session on screen and its
 * shells.
 */

const TERMINAL = "section[data-pane='terminal']";
const ROW = "[data-testid='terminal-row']";
/** A shell's place in the panel, every one mounted, the shown ones on. */
const SLOT = `${TERMINAL} [data-testid='terminal-slot']`;
const SESSION = "[data-testid='session-row']";

/** Cmd on macOS, Ctrl elsewhere. */
const MOD = "ControlOrMeta";

/** The row of the session with this name, wherever the order puts it. */
const named = (page: Page, name: string) =>
  page.locator(SESSION).filter({ has: page.locator(".label", { hasText: new RegExp(`^${name}$`) }) });

const writes = (page: Page) =>
  page.evaluate(() => ((window as unknown as { __written?: unknown[] }).__written ?? []).length);

/** Types into whatever has the keyboard; the pty it reached. */
async function typeInto(page: Page, text: string) {
  const from = await writes(page);
  await page.keyboard.type(text);
  let reached: string[] = [];
  await expect
    .poll(async () => {
      const sent = await page.evaluate(
        (from) => ((window as unknown as { __written?: [string, string][] }).__written ?? []).slice(from),
        from,
      );
      reached = [...new Set(sent.map(([id]) => id))];
      return sent.map(([, data]) => data).join("");
    })
    .toBe(text);
  expect(reached).toHaveLength(1);
  return reached[0];
}

/** Says something runs under a pty, as the core would read it. */
function running(page: Page, pty: string, command: string) {
  return page.evaluate(
    ({ pty, command }) => {
      const w = window as unknown as { __processes?: Record<string, unknown[]> };
      (w.__processes ??= {})[pty] = [
        { pid: 20, parent: 10, name: command.split(" ")[0], command, cpu: 0, memory: 0, started: 1 },
      ];
    },
    { pty, command },
  );
}

async function twoSessions(page: Page) {
  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session").click();
  await expect(page.locator(SESSION)).toHaveCount(2);
  await expect(page.locator(".session.on")).toContainText("session 2");
}

/** Closes a session from its row's ×. */
async function closeSession(page: Page, name: string) {
  await named(page, name).hover();
  await named(page, name).locator("..").getByTestId("close-session").click();
}

test.beforeEach(async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
});

test("shows the shells of the session on screen, and keeps every shell as it was across a switch", async ({ page }) => {
  await twoSessions(page);
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.getByTestId("terminal-owner")).toHaveText("Shells of session 2");
  const two = await typeInto(page, "a");
  await page.locator(`${SLOT}.on`).evaluate((slot) => slot.setAttribute("data-kept", "two"));
  await page.getByTestId("new-terminal").click();
  await expect(page.locator(ROW)).toHaveCount(2);

  // Session 1 has none of its own: the panel stays open and offers one,
  // starting nothing by itself.
  await named(page, "session 1").click();
  await expect(page.locator(TERMINAL)).toBeVisible();
  await expect(page.locator(ROW)).toHaveCount(0);
  await expect(page.getByTestId("terminal-owner")).toHaveText("Shells of session 1");
  await expect(page.getByTestId("terminal-status")).toContainText("No shell open for this session.");
  await expect(page.locator(SLOT)).toHaveCount(2);
  await page.getByTestId("start-terminal").click();
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.locator(ROW)).toHaveText(/shell 1/);
  const one = await typeInto(page, "b");
  expect(one).not.toBe(two);

  // Back on session 2: its shells, the one it had in front, the same
  // terminal it was, still at its pty.
  await named(page, "session 2").click();
  await expect(page.locator(ROW)).toHaveCount(2);
  await expect(page.locator(ROW).nth(1)).toHaveAttribute("aria-current", "true");
  await page.locator(ROW).first().click();
  await expect(page.locator(`${SLOT}.on[data-kept='two']`)).toBeVisible();
  expect(await typeInto(page, "c")).toBe(two);
  await expect(page.locator(SLOT)).toHaveCount(3);

  // Cycling stays among session 2's shells.
  await page.keyboard.press(`Shift+${MOD}+ArrowDown`);
  await expect(page.locator(ROW).nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press(`Shift+${MOD}+ArrowDown`);
  await expect(page.locator(ROW).first()).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".session.on")).toContainText("session 2");
});

test("keeps a shell opened with no session on screen in reach beside a session, at the foot", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.getByTestId("terminal-owner")).toHaveText("Shells of demo");
  const own = await typeInto(page, "a");
  await running(page, own, "npm run dev");

  // The session has none of its own. The project's shell stays listed,
  // apart and under the project's name, and in front, so the dev server
  // is in sight; the fold lists it under the same name.
  await page.getByTestId("new-session").click();
  await expect(page.locator(SESSION)).toHaveCount(1);
  await expect(page.getByTestId("terminal-owner")).toHaveText("Shells of session 1");
  await expect(page.getByTestId("terminal-none")).toHaveText("None open.");
  const foot = page.getByTestId("terminal-project-shells");
  await expect(foot).toContainText("Shells of demo");
  await expect(foot.locator(ROW)).toHaveCount(1);
  await expect(foot.locator(ROW)).toHaveAttribute("aria-current", "true");
  await expect(page.locator(`${SLOT}.on`)).toHaveCount(1);
  await page.getByTestId("processes-fold").click();
  await expect(page.getByTestId("process-row")).toHaveCount(1);
  await expect(page.getByTestId("process-row")).toContainText("shell 1 of demo");

  // The session's own come first, and cycling stays among them.
  await page.getByTestId("new-terminal").click();
  await page.getByTestId("new-terminal").click();
  await expect(page.locator(ROW)).toHaveCount(3);
  await expect(page.getByTestId("terminal-none")).toHaveCount(0);
  await expect(page.locator(ROW).nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press(`Shift+${MOD}+ArrowDown`);
  await expect(page.locator(ROW).nth(0)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press(`Shift+${MOD}+ArrowDown`);
  await expect(page.locator(ROW).nth(1)).toHaveAttribute("aria-current", "true");

  // Picked, it is shown with the keyboard in it, and closing it asks as
  // closing any busy shell does, naming whose it is.
  await foot.locator(ROW).click();
  await expect(foot.locator(ROW)).toHaveAttribute("aria-current", "true");
  expect(await typeInto(page, "b")).toBe(own);
  await foot.locator(ROW).hover();
  await foot.getByTestId("close-terminal").click();
  await expect(page.getByTestId("close-shell")).toContainText("Close shell 1 of demo?");
  await page.getByTestId("close-shell-cancel").click();
  await expect(foot.locator(ROW)).toHaveCount(1);

  // With the session gone, it is the one owner's own again.
  await closeSession(page, "session 1");
  await expect(page.locator(SESSION)).toHaveCount(0);
  await expect(foot).toHaveCount(0);
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.getByTestId("terminal-owner")).toHaveText("Shells of demo");
});

test("starts the shell it opens with after a reload beside the session on screen", async ({ page }) => {
  await page.getByTestId("new-session").click();
  await expect(page.locator(SESSION)).toHaveCount(1);
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(ROW)).toHaveCount(1);

  await page.reload();
  await expect(page.locator(TERMINAL)).toBeVisible();
  await expect(page.locator(SESSION)).toHaveCount(1);
  const name = await page.locator(".session.on .label").textContent();
  await expect(page.getByTestId("terminal-owner")).toHaveText(`Shells of ${name}`);
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.locator(SLOT)).toHaveCount(1);
  await expect(page.locator(`${SLOT}.on`)).toBeVisible();
  await expect(page.getByTestId("terminal-project-shells")).toHaveCount(0);
  await expect(page.getByTestId("terminal-status")).toHaveCount(0);
});

test("closes a session's shells with it, and asks first while one has something running", async ({ page }) => {
  await twoSessions(page);
  await page.keyboard.press(`${MOD}+j`);
  const pty = await typeInto(page, "a");
  await running(page, pty, "npm run dev");
  await named(page, "session 1").click();
  await page.getByTestId("start-terminal").click();
  await expect(page.locator(ROW)).toHaveCount(1);

  // Session 2's dev server is not stopped without a word: the question goes
  // up in the sessions pane, in the words the window's own close uses.
  await closeSession(page, "session 2");
  const strip = page.getByTestId("close-owner");
  await expect(strip).toContainText("Close session 2 with 1 busy shell running?");
  await expect(strip).toContainText("“npm run dev” is running in shell 1. Closing the session stops it.");
  await expect(page.getByTestId("close-owner-cancel")).toBeFocused();
  await page.getByTestId("close-owner-cancel").click();
  await expect(strip).toBeHidden();
  await expect(page.locator(SESSION)).toHaveCount(2);
  await expect(page.locator(SLOT)).toHaveCount(2);

  await closeSession(page, "session 2");
  await expect(page.getByTestId("close-owner-confirm")).toHaveText("Close session");
  await page.getByTestId("close-owner-confirm").click();
  await expect(page.locator(SESSION)).toHaveCount(1);
  await expect(page.locator(SLOT)).toHaveCount(1);
  // Session 1's own shell is untouched, and still on screen.
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.locator(TERMINAL)).toBeVisible();

  // One at an idle prompt goes with its session, asking nothing.
  await closeSession(page, "session 1");
  await expect(strip).toBeHidden();
  await expect(page.locator(SESSION)).toHaveCount(0);
  await expect(page.locator(SLOT)).toHaveCount(0);
  // The panel stays, with what is on screen next.
  await expect(page.locator(TERMINAL)).toBeVisible();
  await expect(page.getByTestId("terminal-status")).toContainText("No shell open for this project.");
});

test("asks before Close project while a shell that started in it is busy, naming whose it is", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  const own = await typeInto(page, "a");
  await running(page, own, "npm run dev");
  await page.getByTestId("new-session").click();
  await expect(page.locator(SESSION)).toHaveCount(1);
  await page.getByTestId("new-terminal").click();
  const theirs = await typeInto(page, "b");
  await running(page, theirs, "make watch");

  const head = page.locator(`[data-row="project:${PROJECT}"]`);
  await head.hover();
  await head.getByTestId("project-more").click();
  await head.getByTestId("close-project").click();
  const strip = page.getByTestId("close-owner");
  await expect(strip).toContainText("Close demo with 2 busy shells running?");
  await expect(strip).toContainText(
    "“npm run dev” is running in shell 1, and “make watch” in shell 1 of session 1. Closing the project stops them.",
  );
  await page.keyboard.press("Escape");
  await expect(strip).toHaveCount(0);
  await expect(page.locator(SESSION)).toHaveCount(1);
  await expect(page.locator(SLOT)).toHaveCount(2);
});

test("lists in the processes fold what runs under the session on screen and its shells", async ({ page }) => {
  await twoSessions(page);
  const ptys = await page.evaluate(() =>
    ((window as unknown as { __spawns?: { ptyId: string }[] }).__spawns ?? []).map((spawn) => spawn.ptyId),
  );
  expect(ptys).toHaveLength(2);
  await running(page, ptys[0], "node one.js");
  await running(page, ptys[1], "node two.js");
  await page.keyboard.press(`${MOD}+j`);
  await running(page, await typeInto(page, "a"), "npm run dev");

  await page.getByTestId("processes-fold").click();
  const rows = page.getByTestId("process-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("node two.js");
  await expect(rows.nth(0)).toContainText("session 2");
  await expect(rows.nth(1)).toContainText("npm run dev");
  await expect(rows.nth(1)).toContainText("shell 1");
  await expect(page.getByTestId("processes-fold")).toContainText("Processes (2)");

  await named(page, "session 1").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("node one.js");
  await expect(page.getByTestId("processes-fold")).toContainText("Processes (1)");
});

test("says whose processes an empty fold means", async ({ page }) => {
  await page.getByTestId("processes-fold").click();
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.getByTestId("processes-empty")).toHaveText("Nothing running in the project's shells.");
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("processes-empty")).toHaveText(
    "Nothing running under this session, its shells or those of demo.",
  );
});
