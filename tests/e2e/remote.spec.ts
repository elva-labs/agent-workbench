import { expect, test, type Page } from "@playwright/test";
import { installFakeCore } from "./fake";

/**
 * A project on another machine. The fake core plays two machines: `box`,
 * which the user's own ssh setup already reaches, and `lab`, which does not
 * know the app yet and wants a password once.
 */

const SESSIONS = "section[data-pane='sessions']";

async function open(page: Page) {
  await installFakeCore(page, { open: [] });
  await page.goto("/");
  await page.getByTestId("open-remote").click();
  await expect(page.getByTestId("remote")).toBeVisible();
}

test.describe("a remote project", () => {
  test("connects to a machine the ssh setup knows and opens a folder there", async ({
    page,
  }) => {
    await open(page);
    const host = page.getByTestId("remote-host");
    await expect(host).toBeFocused();
    await host.fill("box");
    await page.getByTestId("remote-connect").click();

    // Its home, then down into a folder, and up again.
    await expect(page.getByTestId("remote-path")).toHaveText("/home/ada");
    await expect(page.getByTestId("remote-dir")).toHaveText(["dev", "notes"]);
    await page.getByTestId("remote-dir").filter({ hasText: "dev" }).click();
    await expect(page.getByTestId("remote-path")).toHaveText("/home/ada/dev");
    await expect(page.getByTestId("remote-dir")).toHaveText(["demo", "tools"]);
    await page.getByTestId("remote-up").click();
    await expect(page.getByTestId("remote-path")).toHaveText("/home/ada");
    await page.getByTestId("remote-dir").filter({ hasText: "dev" }).click();
    await page.getByTestId("remote-dir").filter({ hasText: "demo" }).click();
    await expect(page.getByTestId("remote-dir")).toHaveCount(0);
    await page.getByTestId("remote-open").click();

    // Open like any project, and marked with where it is.
    await expect(page.getByTestId("remote")).toHaveCount(0);
    await expect(page.locator(SESSIONS)).toContainText("demo");
    await expect(page.getByTestId("project-host")).toHaveText("box");
    const stored = await page.evaluate(() =>
      localStorage.getItem("workbench.workspace"),
    );
    expect(stored).toContain("ssh://box/home/ada/dev/demo");
  });

  test("sets a machine up with a password once, showing what it identifies as", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("remote-host").fill("lab");
    await page.getByTestId("remote-user").fill("ada");
    await page.getByTestId("remote-connect").click();

    await expect(page.getByTestId("remote-fingerprint")).toContainText(
      "SHA256:Ab12Cd34Ef56 lab",
    );
    const password = page.getByTestId("remote-password");
    await expect(password).toBeFocused();
    await password.fill("wrong");
    await page.getByTestId("remote-setup").click();
    await expect(page.getByTestId("remote-error")).toHaveText(
      "Error: the password was not accepted",
    );

    await password.fill("hunter2");
    await password.press("Enter");
    await expect(page.getByTestId("remote-path")).toHaveText("/home/ada");
    await expect(page.getByTestId("remote").locator("h2")).toHaveText(
      "On ada@lab",
    );
    await page.getByTestId("remote-open").click();
    await expect(page.getByTestId("project-host")).toHaveText("ada@lab");
  });

  test("asks for the user before a password can do anything", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("remote-host").fill("lab");
    await page.getByTestId("remote-connect").click();
    await expect(page.getByTestId("remote-password")).toBeVisible();
    await page.getByTestId("remote-password").fill("hunter2");
    await page.getByTestId("remote-setup").click();
    await expect(page.getByTestId("remote-error")).toContainText("which user");
    await page.getByTestId("remote-user").fill("ada");
    await page.getByTestId("remote-setup").click();
    await expect(page.getByTestId("remote-path")).toHaveText("/home/ada");
  });

  test("says so without a machine, and closes on Escape and the scrim", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("remote-connect").click();
    await expect(page.getByTestId("remote-error")).toHaveText(
      "Say which machine.",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("remote")).toHaveCount(0);
    await page.getByTestId("open-remote").click();
    await page.getByTestId("remote-scrim").click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("remote")).toHaveCount(0);
  });

  test("a connection going away ends the sessions on it and says why", async ({
    page,
  }) => {
    await installFakeCore(page, { open: ["ssh://box/home/ada/dev/demo"] });
    await page.goto("/");
    await page.getByTestId("new-session").click();
    await expect(page.locator(SESSIONS)).toContainText("running");
    await page.evaluate(() =>
      (
        window as unknown as { __remoteClosed: (c: unknown) => void }
      ).__remoteClosed({
        host: "box",
        reason: "the connection closed: Connection reset by peer",
      }),
    );
    await expect(page.getByTestId("project-error")).toContainText(
      "box: the connection closed",
    );
  });
});
