import { expect, test, type Page } from "@playwright/test";
import { installFakeCore } from "./fake";

/**
 * A project on another machine. The fake core plays two ways in: `lab`,
 * which the user's own ssh setup already reaches, and a token from a
 * machine's `agent-workbench-remote connect`.
 */

const SESSIONS = "section[data-pane='sessions']";

async function open(page: Page) {
  await installFakeCore(page, { open: [] });
  await page.goto("/");
  await page.getByTestId("sessions-menu").click();
  await page.getByTestId("open-remote").click();
  await expect(page.getByTestId("remote")).toBeVisible();
}

test.describe("a remote project", () => {
  test("pairs by a pasted token and opens a folder there", async ({ page }) => {
    await open(page);
    const token = page.getByTestId("remote-token");
    await expect(token).toBeFocused();
    await token.fill("awb1.demo");
    await page.getByTestId("remote-pair").click();

    await expect(page.getByTestId("remote").locator("h2")).toHaveText(
      "On ada@lab.example",
    );
    await expect(page.getByTestId("remote-path")).toHaveText("/home/ada");
    await expect(page.getByTestId("remote-dir")).toHaveText(["dev", "notes"]);
    await page.getByTestId("remote-dir").filter({ hasText: "dev" }).click();
    await page.getByTestId("remote-dir").filter({ hasText: "demo" }).click();
    await page.getByTestId("remote-open").click();

    await expect(page.getByTestId("remote")).toHaveCount(0);
    await expect(page.locator(SESSIONS)).toContainText("demo");
    await expect(page.getByTestId("project-host")).toHaveText(
      "ada@lab.example",
    );
    const stored = await page.evaluate(() =>
      localStorage.getItem("workbench.workspace"),
    );
    expect(stored).toContain("ssh://ada@lab.example/home/ada/dev/demo");
  });

  test("says what is wrong with a token, before and after sending it", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("remote-pair").click();
    await expect(page.getByTestId("remote-error")).toHaveText(
      "Paste what the machine printed.",
    );
    await page.getByTestId("remote-token").fill("not a token");
    await page.getByTestId("remote-pair").click();
    await expect(page.getByTestId("remote-error")).toContainText("not a token");
    await page.getByTestId("remote-token").fill("awb1.cutoff");
    await page.getByTestId("remote-pair").click();
    await expect(page.getByTestId("remote-error")).toContainText("not whole");
  });

  test("connects to a host the ssh setup knows, going up and down its folders", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("remote-host").fill("lab");
    await page.getByTestId("remote-connect").click();
    await expect(page.getByTestId("remote-path")).toHaveText("/home/ada");
    await page.getByTestId("remote-dir").filter({ hasText: "dev" }).click();
    await expect(page.getByTestId("remote-path")).toHaveText("/home/ada/dev");
    await page.getByTestId("remote-up").click();
    await expect(page.getByTestId("remote-path")).toHaveText("/home/ada");
    await page.getByTestId("remote-open").click();
    await expect(page.getByTestId("project-host")).toHaveText("lab");
  });

  test("says so for a host it cannot reach, and closes on Escape and the scrim", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("remote-connect").click();
    await expect(page.getByTestId("remote-error")).toHaveText(
      "Say which host.",
    );
    await page.getByTestId("remote-host").fill("nowhere");
    await page.getByTestId("remote-connect").click();
    await expect(page.getByTestId("remote-error")).toContainText(
      "Could not resolve hostname nowhere",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("remote")).toHaveCount(0);
    await page.getByTestId("sessions-menu").click();
    await page.getByTestId("open-remote").click();
    await page.getByTestId("remote-scrim").click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("remote")).toHaveCount(0);
  });

  test("is reached from the keyboard, on the sessions pane's cursor", async ({
    page,
  }) => {
    await installFakeCore(page, { open: [] });
    await page.goto("/");
    await expect(page.getByTestId("open-first-project")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+1");
    await page.keyboard.press("Home");
    await expect(page.getByTestId("project-sort")).toHaveClass(/cursor/);
    // The sort, then the menu beside it on the title's row.
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("sessions-menu")).toHaveClass(/cursor/);
    // Enter opens the menu, and the arrows walk its items.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sessions-menu-items")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("open-remote")).toHaveClass(/at/);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sessions-menu-items")).toHaveCount(0);
    await expect(page.getByTestId("remote")).toBeVisible();
    await expect(page.getByTestId("remote-token")).toBeFocused();
  });

  test("a connection going away ends the sessions on it and says why", async ({
    page,
  }) => {
    await installFakeCore(page, { open: ["ssh://lab/home/ada/dev/demo"] });
    await page.goto("/");
    await page.getByTestId("new-session").click();
    await expect(page.locator(SESSIONS)).toContainText("running");
    await page.evaluate(() =>
      (
        window as unknown as { __remoteClosed: (c: unknown) => void }
      ).__remoteClosed({
        host: "lab",
        reason: "the connection closed: Connection reset by peer",
      }),
    );
    await expect(page.getByTestId("project-error")).toContainText(
      "lab: the connection closed",
    );
    // The notice stays until dismissed; it is not in the way after that.
    await page.getByTestId("project-error-dismiss").click();
    await expect(page.getByTestId("project-error")).toHaveCount(0);
  });
});

// The projects are ordered by when the user last used each. The window
// putting one in front as it opens, or an agent asking to show something
// in one, is not the user using it, and moves nothing.
test.describe("when each project was last used", () => {
  const REMOTE = "ssh://lab/srv/remote";
  const A = "/home/ada/dev/alpha";
  const B = "/home/ada/dev/beta";
  const HOUR = 3600 * 1000;
  const heads = (page: Page) =>
    page.locator(SESSIONS).locator("[data-row^='project:'] .name");

  test("stays as it was while the window opens, a remote project answering late", async ({
    page,
  }) => {
    await installFakeCore(page, {
      open: [REMOTE, A, B],
      active: REMOTE,
      used: { [A]: HOUR, [REMOTE]: 2 * HOUR, [B]: 3 * HOUR },
      held: [REMOTE],
    });
    await page.goto("/");
    // Alpha is in front while the remote project waits for its machine.
    await expect(heads(page)).toHaveText(["alpha", "beta"]);
    await expect(page.locator(`[data-row="project:${A}"]`)).toHaveClass(/on/);

    await page.evaluate((path) => {
      (window as unknown as { __describe: (path: string) => void }).__describe(path);
    }, REMOTE);
    await expect(page.locator(`[data-row="project:${REMOTE}"]`)).toHaveClass(/on/);
    await expect(heads(page)).toHaveText(["alpha", "remote", "beta"]);
  });

  test("stays as it was when an agent shows something in another project", async ({
    page,
  }) => {
    await installFakeCore(page, {
      open: [A, B, REMOTE],
      used: { [A]: HOUR, [REMOTE]: 2 * HOUR, [B]: 3 * HOUR },
    });
    await page.goto("/");
    await expect(heads(page)).toHaveText(["alpha", "remote", "beta"]);
    await page.evaluate((cwd) => {
      (window as unknown as { __showRequest: (request: unknown) => void }).__showRequest({
        path: `${cwd}/src/main.rs`,
        from: 1,
        to: 1,
        note: null,
        cwd,
      });
    }, B);
    await expect(page.locator(`[data-row="project:${B}"]`)).toHaveClass(/on/);
    await expect(heads(page)).toHaveText(["alpha", "remote", "beta"]);
  });
});
