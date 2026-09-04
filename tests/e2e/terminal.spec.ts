import { expect, test, type Page } from "@playwright/test";
import { installFakeCore } from "./fake";

const AGENT = "section[data-pane='agent']";
const TERMINAL = "section[data-pane='terminal']";
const ROW = "[data-testid='terminal-row']";
const GROUP = "[data-testid='terminal-group']";
const SLOT = "[data-testid='terminal-slot'].on";

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
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.locator(ROW)).toHaveText(/shell 1/);

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
  await expect(page.locator(ROW)).toHaveCount(1);
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

test("lists shells on the right and switches between them", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  await page.getByTestId("new-terminal").click();
  await expect(page.locator(ROW)).toHaveCount(2);
  await expect(page.locator(GROUP)).toHaveCount(2);
  await expect(page.locator(ROW).nth(1)).toHaveText(/shell 2/);
  await expect(page.locator(ROW).nth(1)).toHaveAttribute("aria-current", "true");

  // The list sits to the right of the shell it names.
  const shell = await boxOf(page, SLOT);
  const row = await boxOf(page, `${ROW} >> nth=0`);
  expect(row.x).toBeGreaterThan(shell.x + shell.width);

  // One group on screen at a time.
  await expect(page.locator(SLOT)).toHaveCount(1);
  await page.locator(ROW).first().click();
  await expect(page.locator(ROW).first()).toHaveAttribute("aria-current", "true");
  await expect(page.locator(`${SLOT} [data-session='t1']`)).toBeVisible();

  await page.getByTestId("close-terminal").nth(1).click();
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.locator(TERMINAL)).toBeVisible();

  // The last shell takes the panel with it.
  await page.getByTestId("close-terminal").click();
  await expect(page.locator(TERMINAL)).toBeHidden();
});

test("splits a shell side by side and lists the pair as one group", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  const whole = await boxOf(page, SLOT);

  await page.getByTestId("split-terminal").click();
  await expect(page.locator(SLOT)).toHaveCount(2);
  await expect(page.locator(GROUP)).toHaveCount(1);
  await expect(page.locator(ROW)).toHaveCount(2);
  await expect(page.locator(ROW).nth(1)).toHaveAttribute("aria-current", "true");

  // Beside each other, sharing the width the one shell had.
  const left = await boxOf(page, `${SLOT} >> nth=0`);
  const right = await boxOf(page, `${SLOT} >> nth=1`);
  expect(Math.round(left.y)).toBe(Math.round(right.y));
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
  expect(left.width).toBeLessThan(whole.width);
  expect(Math.abs(left.width - right.width)).toBeLessThan(2);

  // Closing one half leaves the other, at the full width again.
  await page.getByTestId("close-terminal").nth(1).click();
  await expect(page.locator(SLOT)).toHaveCount(1);
  await expect(page.locator(ROW).first()).toHaveAttribute("aria-current", "true");
  const alone = await boxOf(page, SLOT);
  expect(Math.abs(alone.width - whole.width)).toBeLessThan(2);
});

test("resizes a split from the bar between the halves", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  await page.getByTestId("split-terminal").click();
  await expect(page.locator(SLOT)).toHaveCount(2);
  const before = await boxOf(page, `${SLOT} >> nth=0`);

  const bar = page.locator(TERMINAL).getByRole("separator", { name: "Resize shell 2" });
  await bar.focus();
  await page.keyboard.press("Shift+ArrowRight");
  const after = await boxOf(page, `${SLOT} >> nth=0`);
  expect(after.width).toBeGreaterThan(before.width);

  await page.keyboard.press("Home");
  const even = await boxOf(page, `${SLOT} >> nth=0`);
  expect(Math.abs(even.width - before.width)).toBeLessThan(2);
});

test("resizes the list and remembers the width", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  const before = (await boxOf(page, ROW)).width;

  const bar = page.locator(TERMINAL).getByRole("separator", { name: "Resize the terminal list" });
  await bar.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  const after = (await boxOf(page, ROW)).width;
  expect(after).toBeGreaterThan(before);

  await page.reload();
  await expect(page.locator(TERMINAL)).toBeVisible();
  expect(Math.abs((await boxOf(page, ROW)).width - after)).toBeLessThan(2);
});

test("remembers being open across a reload", async ({ page }) => {
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(TERMINAL)).toBeVisible();

  await page.reload();
  await expect(page.locator(TERMINAL)).toBeVisible();
});
