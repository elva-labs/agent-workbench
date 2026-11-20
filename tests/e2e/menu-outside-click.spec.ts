import { expect, test } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * A menu in a pane goes away on a press anywhere in the window, in any
 * pane, and the press does what it would have done without the menu.
 */

const AGENT = "section[data-pane='agent']";
const ROW = "[data-testid='session-row']";

test("a session row's menu closes on a click in the conversation's composer, which takes the keyboard", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("conversation")).toBeVisible();

  await page.locator(ROW).first().click({ button: "right" });
  const menu = page.getByTestId("session-menu");
  await expect(menu).toBeVisible();

  await page.getByTestId("composer-input").click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.type("hello");
  await expect(page.getByTestId("composer-input")).toHaveValue("hello");
});

test("a session row's menu closes on a click on a terminal in the agent pane", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await page.getByTestId("new-session").click();
  await expect(page.locator(`${AGENT} .xterm`)).toBeVisible();

  await page.locator(ROW).first().click({ button: "right" });
  const menu = page.getByTestId("session-menu");
  await expect(menu).toBeVisible();

  await page.locator(`${AGENT} .xterm`).click();
  await expect(menu).toHaveCount(0);
});

test("a session row's menu closes when the window loses focus and a click inside it still runs its item", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await page.getByTestId("new-session").click();
  await expect(page.locator(ROW)).toHaveCount(1);

  await page.locator(ROW).first().click({ button: "right" });
  const menu = page.getByTestId("session-menu");
  await expect(menu).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(menu).toHaveCount(0);

  await page.locator(ROW).first().click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.getByTestId("session-menu-unread").click();
  await expect(menu).toHaveCount(0);
});

test("the changes pane's menu closes on a press in another pane", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await page.getByTestId("new-session").click();
  await expect(page.locator(`${AGENT} .xterm`)).toBeVisible();

  await page.getByTestId("changes-menu").click();
  const menu = page.getByTestId("changes-menu-items");
  await expect(menu).toBeVisible();
  await page.locator(`${AGENT} .xterm`).click();
  await expect(menu).toHaveCount(0);
});
