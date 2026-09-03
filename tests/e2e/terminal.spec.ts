import { expect, test, type Page } from "@playwright/test";
import { installFakeCore } from "./fake";

const AGENT = "section[data-pane='agent']";
const TERMINAL = "section[data-pane='terminal']";
const TAB = "[data-testid='terminal-tab']";

/** Cmd on macOS, Ctrl elsewhere. */
const MOD = "ControlOrMeta";

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  return box;
}

test.beforeEach(async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
});

test("is closed until asked for", async ({ page }) => {
  await expect(page.locator(TERMINAL)).toBeHidden();
});

test("slides up from the bottom with a shell in it and takes focus", async ({ page }) => {
  const before = await boxOf(page, AGENT);

  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(TERMINAL)).toBeVisible();
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: terminal");
  await expect(page.locator(TAB)).toHaveCount(1);
  await expect(page.locator(TAB)).toHaveText(/shell 1/);

  // Under the panes, across the whole width, and the agent gave up the room.
  const agent = await boxOf(page, AGENT);
  const terminal = await boxOf(page, TERMINAL);
  expect(terminal.y).toBeGreaterThanOrEqual(agent.y + agent.height);
  expect(terminal.width).toBeGreaterThan(agent.width);
  expect(agent.height).toBeLessThan(before.height);
});

test("closes again on the same key and hands focus back to the agent", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(TERMINAL)).toBeVisible();

  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(TERMINAL)).toBeHidden();
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");

  // Reopening finds the same shell: hiding did not end anything.
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(TAB)).toHaveCount(1);
});

test("can be focused by number and hidden from its own bar", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  await page.keyboard.press(`${MOD}+2`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");

  await page.keyboard.press(`${MOD}+4`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: terminal");

  await page.getByTestId("hide-terminal").click();
  await expect(page.locator(TERMINAL)).toBeHidden();
});

test("opens more shells as tabs and closes them one by one", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  await page.getByTestId("new-terminal").click();
  await expect(page.locator(TAB)).toHaveCount(2);
  await expect(page.locator(TAB).nth(1)).toHaveText(/shell 2/);
  await expect(page.locator(TAB).nth(1)).toHaveAttribute("aria-selected", "true");

  await page.locator(TAB).first().click();
  await expect(page.locator(TAB).first()).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("close-terminal").nth(1).click();
  await expect(page.locator(TAB)).toHaveCount(1);
  await expect(page.locator(TERMINAL)).toBeVisible();

  // The last tab takes the panel with it.
  await page.getByTestId("close-terminal").click();
  await expect(page.locator(TERMINAL)).toBeHidden();
});

test("remembers being open across a reload", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(TERMINAL)).toBeVisible();

  await page.reload();
  await expect(page.locator(TERMINAL)).toBeVisible();
});
