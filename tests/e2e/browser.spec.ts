import { expect, test, type Page } from "@playwright/test";
import { installFakeCore } from "./fake";

/**
 * The embedded browser, as a fourth kind the changes pane's viewer can
 * show: a tab strip and an address bar around a placeholder the native
 * view is laid over. Opening it, a file, media or a plugin's page each put
 * the others away, and the fake core stands in for the native layer,
 * recording where it was last told to sit on `window.__browser`.
 */

const CHANGES = "section[data-pane='changes']";
const TREE = "[data-testid='file-tree']";

function row(page: Page, name: string) {
  return page.locator(TREE).getByText(name, { exact: true });
}

/** Waits for the panes' columns to arrive: two frames apart, the grid reads
    the same. Entering review eases the sessions column folded and the
    changes column to its review width, and the placeholder moves with it. */
async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const shell = document.querySelector("[data-testid='shell']")!;
            const read = () => getComputedStyle(shell).gridTemplateColumns;
            const first = read();
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(read() === first)));
          }),
      ),
    )
    .toBe(true);
}

async function openBrowser(page: Page) {
  await page.getByTestId("changes-menu").click();
  await page.getByTestId("menu-browser").click();
  await settled(page);
}

interface BrowserWindowState {
  rect: { x: number; y: number; width: number; height: number } | null;
  showing: boolean;
}

function browserWindowState(page: Page): Promise<BrowserWindowState | null> {
  return page.evaluate(
    () => (window as unknown as { __browser?: BrowserWindowState }).__browser ?? null,
  );
}

/** Whether the native view's last rectangle matches the placeholder's own,
    within the rounding `place` and a real browser's layout can disagree by. */
async function placedOverBody(page: Page): Promise<boolean> {
  const box = await page.getByTestId("browser-body").boundingBox();
  const state = await browserWindowState(page);
  if (box === null || state === null || state.rect === null) return false;
  return (
    Math.abs(state.rect.x - box.x) < 1.5 &&
    Math.abs(state.rect.y - box.y) < 1.5 &&
    Math.abs(state.rect.width - box.width) < 1.5 &&
    Math.abs(state.rect.height - box.height) < 1.5
  );
}

test.beforeEach(async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator(CHANGES)).toBeVisible();
});

test("opens from the menu with the new-tab page and the address field focused", async ({ page }) => {
  await openBrowser(page);

  await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
  await expect(page.getByTestId("browser-body").getByText("New tab")).toBeVisible();
  await expect(page.getByTestId("browser-address")).toBeFocused();
});

test("navigating gives a tab titled by its host and places the native view over the placeholder", async ({
  page,
}) => {
  await openBrowser(page);
  const address = page.getByTestId("browser-address");
  await address.fill("example.com");
  await address.press("Enter");

  await expect(page.getByTestId("browser-tab-select")).toContainText("example.com");
  await expect.poll(() => placedOverBody(page)).toBe(true);
  await expect.poll(() => browserWindowState(page).then((s) => s?.showing)).toBe(true);
});

test("resizing the viewport moves the rectangle with it", async ({ page }) => {
  await openBrowser(page);
  const address = page.getByTestId("browser-address");
  await address.fill("example.com");
  await address.press("Enter");
  await expect.poll(() => placedOverBody(page)).toBe(true);
  const before = (await browserWindowState(page))!.rect!;

  await page.setViewportSize({ width: 1100, height: 820 });
  await settled(page);

  await expect.poll(() => placedOverBody(page)).toBe(true);
  const after = (await browserWindowState(page))!.rect!;
  expect(after).not.toEqual(before);
});

test("a bad address shows the error line and changes nothing", async ({ page }) => {
  await openBrowser(page);
  const address = page.getByTestId("browser-address");
  await address.fill("foo bar");
  await address.press("Enter");

  await expect(page.getByTestId("browser-error")).toContainText("not an address");
  await expect(page.getByTestId("browser-tab")).toHaveCount(1);
  await expect(page.getByTestId("browser-body").getByText("New tab")).toBeVisible();
});

test("a second tab, switching between them, and closing one", async ({ page }) => {
  await openBrowser(page);
  const address = page.getByTestId("browser-address");
  await address.fill("example.com");
  await address.press("Enter");
  await expect(page.getByTestId("browser-tab")).toHaveCount(1);

  await page.getByTestId("browser-new-tab").click();
  await expect(page.getByTestId("browser-tab")).toHaveCount(2);
  await expect(address).toHaveValue("");

  const tabs = page.getByTestId("browser-tab");
  await tabs.nth(0).getByTestId("browser-tab-select").click();
  await expect(address).toHaveValue(/example\.com/);
  await expect(tabs.nth(0)).toHaveClass(/active/);

  await tabs.nth(1).getByTestId("browser-tab-close").click();
  await expect(page.getByTestId("browser-tab")).toHaveCount(1);
});

test("back and forward follow the tab's history", async ({ page }) => {
  await openBrowser(page);
  const address = page.getByTestId("browser-address");
  const back = page.getByTestId("browser-back");
  const forward = page.getByTestId("browser-forward");

  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();

  await address.fill("example.com");
  await address.press("Enter");
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();

  await address.fill("example.org");
  await address.press("Enter");
  await expect(back).toBeEnabled();
  await expect(forward).toBeDisabled();

  await back.click();
  await expect(page.getByTestId("browser-tab-select")).toContainText("example.com");
  await expect(forward).toBeEnabled();

  await forward.click();
  await expect(page.getByTestId("browser-tab-select")).toContainText("example.org");
});

test("opening a file from the tree puts the browser away and shows the file", async ({ page }) => {
  await openBrowser(page);
  const address = page.getByTestId("browser-address");
  await address.fill("example.com");
  await address.press("Enter");
  await expect.poll(() => browserWindowState(page).then((s) => s?.showing)).toBe(true);

  await row(page, "mod.rs").click();

  await expect.poll(() => browserWindowState(page).then((s) => s?.showing)).toBe(false);
  await expect(page.getByTestId("viewer")).toHaveAttribute("data-view", "diff");
});

test("opening the menu hides the native view and closing it brings it back at the same rectangle", async ({
  page,
}) => {
  await openBrowser(page);
  const address = page.getByTestId("browser-address");
  await address.fill("example.com");
  await address.press("Enter");
  await expect.poll(() => placedOverBody(page)).toBe(true);
  const before = (await browserWindowState(page))!.rect;

  await page.getByTestId("changes-menu").click();
  await expect(page.getByTestId("changes-menu-items")).toBeVisible();
  await expect.poll(() => browserWindowState(page).then((s) => s?.showing)).toBe(false);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("changes-menu-items")).toHaveCount(0);
  await expect.poll(() => browserWindowState(page).then((s) => s?.showing)).toBe(true);
  const after = (await browserWindowState(page))!.rect;
  expect(after).toEqual(before);
});
