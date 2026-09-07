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
    await page.getByTestId("open-remote").click();
    await page.getByTestId("remote-scrim").click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("remote")).toHaveCount(0);
  });

  test("is reached from the keyboard, on the sessions pane's cursor", async ({
    page,
  }) => {
    await installFakeCore(page, { open: [] });
    await page.goto("/");
    await expect(page.getByTestId("open-project")).toBeVisible();
    await page.keyboard.press("Control+1");
    await page.keyboard.press("Home");
    await expect(page.getByTestId("open-project")).toHaveClass(/cursor/);
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("open-remote")).toHaveClass(/cursor/);
    await page.keyboard.press("Enter");
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
  });
});
