import { expect, test, type Page } from "@playwright/test";
import { NO_WORKFLOW, PROJECT, installFakeCore } from "./fake";

/**
 * Asking for a new session in a project starts nothing but the session
 * picked. Here each project has a session left open at the last quit,
 * which starts only once it is on screen: the one in front starts as the
 * window opens, and the other project's waits. Asking for a new session
 * in that other project opens the choice under its name and leaves the
 * session on screen where it is, so the one waiting there never starts.
 */

const OTHER = "/home/ada/dev/other";
const MOD = "ControlOrMeta";

const head = (page: Page, name: string) =>
  page.getByTestId("project-head").filter({ has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
const section = (page: Page, name: string) => page.getByTestId("project-section").filter({ has: head(page, name) });
/** The row of the session left open in the other project at the last quit. */
const leftOpen = (page: Page) => section(page, "other").getByTestId("session-row");
const order = (page: Page) => page.locator("[data-testid='project-head'] .name");

/** The row left open in the other project still waits, yellow. A row
    leaves that state the moment it is on screen, before its agent is
    spawned, so while another session holds the screen this rules out a
    spawn for it, then or later. */
async function stillWaiting(page: Page) {
  await expect(page.locator(".session.on")).toHaveCount(1);
  await expect(section(page, "other").locator(".session.on")).toHaveCount(0);
  await expect(section(page, "other").locator(".dot.dormant")).toHaveCount(1);
}

function spawned(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    ((window as unknown as { __spawns?: { session?: string }[] }).__spawns ?? []).map(
      (spawn) => spawn.session ?? null,
    ),
  );
}

async function open(page: Page, used?: Record<string, number>) {
  await installFakeCore(page, {
    open: [PROJECT, OTHER],
    agents: ["claude-code", "codex"],
    settings: NO_WORKFLOW,
    ...(used === undefined ? {} : { used }),
  });
  await page.addInitScript(
    ({ here, other }) => {
      if (localStorage.getItem("workbench.open") !== null) return;
      localStorage.setItem(
        "workbench.open",
        JSON.stringify({
          open: [
            { project: here, id: "on-screen", agent: "claude-code", startIn: null, model: null },
            { project: other, id: "left-open", agent: "claude-code", startIn: null, model: null },
          ],
          active: "on-screen",
        }),
      );
    },
    { here: PROJECT, other: OTHER },
  );
  await page.goto("/");
  await expect(page.getByTestId("state-readout")).toHaveText("running");
  expect(await spawned(page)).toEqual(["on-screen"]);
}

/** The choice is open under the other project, and nothing else moved:
    the session on screen and its project are the ones from before, and
    the other project's session is still waiting. */
async function choosingInOther(page: Page) {
  await expect(section(page, "other").getByTestId("agent-choice")).toBeVisible();
  await expect(page.getByTestId("agent-choice")).toHaveCount(1);
  await expect(head(page, "demo")).toHaveClass(/\bon\b/);
  await expect(head(page, "other")).not.toHaveClass(/\bon\b/);
  await expect(section(page, "demo").locator(".session.on")).toHaveCount(1);
  await stillWaiting(page);
}

/** Picking an agent starts the new session alone, and it takes the screen. */
async function pickClaude(page: Page) {
  await section(page, "other").locator("[data-testid='agent-option'][data-agent='claude-code']").click();
  await expect(page.getByTestId("agent-choice")).toHaveCount(0);
  await expect.poll(() => spawned(page)).toHaveLength(2);
  expect(await spawned(page)).toEqual(["on-screen", null]);
  await expect(head(page, "other")).toHaveClass(/\bon\b/);
  await expect(section(page, "other").locator(".session.on .dot")).not.toHaveClass(/dormant/);
  await expect(leftOpen(page).locator(".dot.dormant")).toHaveCount(1);
}

test("a project's + opens the choice and starts none of the project's sessions", async ({ page }) => {
  await open(page);
  await expect(leftOpen(page).locator(".dot")).toHaveClass(/dormant/);

  await head(page, "other").getByTestId("project-new-session").click();
  await choosingInOther(page);
  await pickClaude(page);
});

// Asking is not using the project: the list keeps its order once the
// pointer has left the pane, and backing out leaves it as it was.
test("backing out of the choice leaves everything as it was", async ({ page }) => {
  await open(page, { [PROJECT]: 0, [OTHER]: 3600 * 1000 });
  await expect(order(page)).toHaveText(["demo", "other"]);
  await head(page, "other").getByTestId("project-new-session").click();
  await choosingInOther(page);
  await page.mouse.move(900, 450);
  await expect(order(page)).toHaveText(["demo", "other"]);

  await page.getByTestId("choice-cancel").click();
  await expect(page.getByTestId("agent-choice")).toHaveCount(0);
  await expect(order(page)).toHaveText(["demo", "other"]);
  await expect(head(page, "demo")).toHaveClass(/\bon\b/);
  await stillWaiting(page);
  expect(await spawned(page)).toEqual(["on-screen"]);
});

test("New session in a project's menu does what its + does", async ({ page }) => {
  await open(page);
  await head(page, "other").click({ button: "right" });
  await page.getByTestId("project-menu-new").click();
  await choosingInOther(page);
  await pickClaude(page);
});

test("New session in an inactive project's menu opens the choice among the active ones and starts nothing else", async ({
  page,
}) => {
  await open(page, { [PROJECT]: 0, [OTHER]: 30 * 24 * 3600 * 1000 });
  await expect(head(page, "other")).toHaveCount(0);
  await page.getByTestId("inactive-fold").click();
  await page.getByTestId("inactive-project").filter({ hasText: "other" }).click({ button: "right" });
  await page.getByTestId("project-menu-new").click();

  await expect(page.getByTestId("inactive-fold")).toHaveCount(0);
  await choosingInOther(page);
  await expect(section(page, "other").getByTestId("agent-choice")).toBeInViewport();

  // Nothing used it, so backing out puts it back under Inactive.
  await page.getByTestId("choice-cancel").click();
  await expect(head(page, "other")).toHaveCount(0);
  await expect(page.getByTestId("inactive-project").filter({ hasText: "other" })).toBeVisible();
  await expect(section(page, "demo").locator(".session.on")).toHaveCount(1);

  await page.getByTestId("inactive-project").filter({ hasText: "other" }).click({ button: "right" });
  await page.getByTestId("project-menu-new").click();
  await choosingInOther(page);
  await pickClaude(page);
});

test("New session in the palette leaves the session on screen until the new one starts", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.keyboard.type("new session");
  await page.keyboard.press("Enter");
  await page.keyboard.type("other");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette-chip")).toHaveCount(2);

  // Asking which agent, nothing has moved yet.
  await expect(head(page, "demo")).toHaveClass(/\bon\b/);
  await stillWaiting(page);

  await page.locator("[data-testid='palette-row']", { hasText: "Claude Code" }).click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect.poll(() => spawned(page)).toHaveLength(2);
  expect(await spawned(page)).toEqual(["on-screen", null]);
  await expect(head(page, "other")).toHaveClass(/\bon\b/);
  await expect(leftOpen(page).locator(".dot.dormant")).toHaveCount(1);
});
