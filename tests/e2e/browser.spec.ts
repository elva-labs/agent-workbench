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
const MOD = "ControlOrMeta";

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

/** Opens a tab from the tree's Browser fold rather than the "⋯" menu: the
    fold, then its header's own action. */
async function openFoldNewTab(page: Page) {
  await page.getByTestId("browser-fold").click();
  await page.getByTestId("browser-fold-new-tab").click();
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

/**
 * The Browser fold under the tree, beside Processes: how the browser is
 * opened from there, one row per tab, and the fold's place in the column.
 */

test("the fold stands under the tree with no tabs open, and says so", async ({ page }) => {
  const fold = page.getByTestId("browser-fold");
  await expect(fold).toContainText("Browser (0)");

  await fold.click();
  await expect(page.getByTestId("browser-fold-empty")).toBeVisible();
  await expect(page.getByTestId("browser-fold-row")).toHaveCount(0);
});

test("the header's own action opens a new tab and shows it, counted in the fold", async ({ page }) => {
  await openFoldNewTab(page);

  await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
  await expect(page.getByTestId("browser-body").getByText("New tab")).toBeVisible();
  await expect(page.getByTestId("browser-fold")).toContainText("Browser (1)");
  await expect(page.getByTestId("browser-fold-row")).toHaveCount(1);
});

test("a row shows the tab's host as its label and its url, without the scheme, as its detail", async ({ page }) => {
  await openFoldNewTab(page);
  const address = page.getByTestId("browser-address");
  await address.fill("example.com");
  await address.press("Enter");

  const row = page.getByTestId("browser-fold-row");
  await expect(row).toContainText("example.com");
  await expect(row).not.toContainText("https://");
});

test("a second tab gives two rows, the active one marked current", async ({ page }) => {
  await openFoldNewTab(page);
  const address = page.getByTestId("browser-address");
  await address.fill("example.com");
  await address.press("Enter");

  await page.getByTestId("browser-new-tab").click();
  const rows = page.getByTestId("browser-fold-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator(".media-row")).not.toHaveClass(/\bon\b/);
  await expect(rows.nth(1).locator(".media-row")).toHaveClass(/\bon\b/);
});

test("clicking a row activates that tab and shows it", async ({ page }) => {
  await openFoldNewTab(page);
  const address = page.getByTestId("browser-address");
  await address.fill("example.com");
  await address.press("Enter");

  await page.getByTestId("browser-new-tab").click();
  await address.fill("example.org");
  await address.press("Enter");

  const rows = page.getByTestId("browser-fold-row");
  await rows.first().locator(".media-row").click();

  await expect(address).toHaveValue(/example\.com/);
  await expect(rows.first().locator(".media-row")).toHaveClass(/\bon\b/);
});

test("a row's close action removes it and the tab from the strip", async ({ page }) => {
  await openFoldNewTab(page);
  const address = page.getByTestId("browser-address");
  await address.fill("example.com");
  await address.press("Enter");

  const row = page.getByTestId("browser-fold-row");
  await expect(row).toHaveCount(1);
  await expect(page.getByTestId("browser-tab")).toHaveCount(1);

  await row.hover();
  await row.getByTestId("browser-fold-close").click();

  await expect(row).toHaveCount(0);
  await expect(page.getByTestId("browser-tab")).toHaveCount(0);
});

test("opening a file from the tree leaves the fold's rows in place, none marked current", async ({ page }) => {
  await openFoldNewTab(page);
  const address = page.getByTestId("browser-address");
  await address.fill("example.com");
  await address.press("Enter");

  await row(page, "mod.rs").click();

  const rows = page.getByTestId("browser-fold-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(".media-row")).not.toHaveClass(/\bon\b/);
  await expect(page.getByTestId("viewer")).toHaveAttribute("data-view", "diff");
});

test("the fold folds and unfolds as Processes does", async ({ page }) => {
  const fold = page.getByTestId("browser-fold");
  await expect(fold).toHaveText(/^\s*▸\s*Browser \(0\)\s*$/);

  await fold.click();
  await expect(fold).toHaveText(/^\s*▾\s*Browser \(0\)\s*$/);
  await expect(page.getByTestId("browser-fold-empty")).toBeVisible();

  await fold.click();
  await expect(fold).toHaveText(/^\s*▸\s*Browser \(0\)\s*$/);
  await expect(page.getByTestId("browser-fold-empty")).toHaveCount(0);
});

test("the fold sits inside the tree's column and does not overlap Processes", async ({ page }) => {
  const column = (await page.getByTestId("tree-column").boundingBox())!;
  const browserFold = (await page.getByTestId("browser-fold").boundingBox())!;
  const processesFold = (await page.getByTestId("processes-fold").boundingBox())!;

  expect(browserFold.x).toBeGreaterThanOrEqual(column.x);
  expect(browserFold.y).toBeGreaterThanOrEqual(column.y);
  expect(browserFold.x + browserFold.width).toBeLessThanOrEqual(column.x + column.width + 1);
  expect(browserFold.y + browserFold.height).toBeLessThanOrEqual(column.y + column.height + 1);

  // The two folds' own rows never occupy the same vertical space.
  expect(browserFold.y).toBeGreaterThanOrEqual(processesFold.y + processesFold.height - 1);
});

/**
 * A page inside a browser tab is a native webview, not the app's own DOM,
 * so taking the keyboard and the pointer back from it happens through the
 * core rather than a DOM event: a native key monitor forwards the app's own
 * chords, and a click is reported once it lands. The fake core stands in
 * for both, recording the chords on `window.__browserKeys` and exposing the
 * click as `window.__browserFocused`.
 */
test.describe("keeping the keyboard from a browser tab", () => {
  function browserKeys(page: Page) {
    return page.evaluate(
      () => (window as unknown as { __browserKeys?: { key: string }[] }).__browserKeys ?? null,
    );
  }

  test("hands the chords over on load and again after a binding changes", async ({ page }) => {
    await expect.poll(() => browserKeys(page)).not.toBeNull();
    const initial = (await browserKeys(page))!;
    expect(initial.some((chord) => chord.key === "3")).toBe(true);

    await page.keyboard.press(`${MOD}+,`);
    await page.getByTestId("settings-tab-keys").click();
    await page.getByTestId("preset-vim").click();
    await page.keyboard.press("Escape");

    await expect
      .poll(async () => (await browserKeys(page))!.some((chord) => chord.key === "l"))
      .toBe(true);
  });

  test("a click landing in a tab marks the changes pane focused", async ({ page }) => {
    await page.keyboard.press(`${MOD}+2`);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");

    await page.evaluate(() =>
      (window as unknown as { __browserFocused?: () => void }).__browserFocused?.(),
    );

    await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
  });
});
