import { expect, test, type Page } from "@playwright/test";
import { installFakeCore } from "./fake";

/**
 * A tree of a few thousand changed files stays cheap to lay out. The tree
 * is a flex column, and WebKit walks one in its children once for every
 * distinct order they hold, in each layout and each paint: an order of its
 * own on every row made each walk millions of steps and froze the window
 * for seconds on any layout. What the walks number is counted here, with
 * the name field open among the rows and without it.
 */

const TREE = "[data-testid='file-tree']";
const MOD = "ControlOrMeta";

const FILES: string[] = [];
for (let area = 0; area < 20; area++)
  for (let part = 0; part < 10; part++)
    for (let file = 0; file < 10; file++) FILES.push(`src/area${area}/part${part}/file${area}${part}${file}.ts`);

/** How many times a layout or a paint of the tree walks its rows: once
    for each distinct order among them. */
function walks(page: Page) {
  return page
    .locator(TREE)
    .evaluate((tree) => new Set([...tree.children].map((row) => getComputedStyle(row).order)).size);
}

const row = (page: Page, name: string) => page.locator(TREE).getByText(name, { exact: true });

test.beforeEach(async ({ page }) => {
  await installFakeCore(page, {
    fixture: {
      files: FILES,
      status: FILES.map((path) => ({ path, status: "M", add: 3, del: 1, binary: false })),
    },
  });
  await page.goto("/");
  await expect.poll(() => page.locator(`${TREE} [role='treeitem']`).count()).toBeGreaterThan(FILES.length);
});

test("walks the rows of a large tree once", async ({ page }) => {
  expect(await walks(page)).toBe(1);
});

test("walks them at most three times with the name field among them, which stays in place and whole", async ({
  page,
}) => {
  await page.keyboard.press(`${MOD}+Shift+E`);
  await expect(page.getByTestId("mode-readout")).toHaveText("editing");
  await row(page, "file734.ts").click();
  await page.getByTestId("tree-new-file").click();
  const field = page.getByTestId("name-field");
  await expect(field).toBeFocused();
  expect(await walks(page)).toBeLessThanOrEqual(3);

  // Just under the folder's last file and above the row after it.
  const around = await page.locator(TREE).evaluate((tree) => {
    const rows = [...tree.querySelectorAll("[role='treeitem']")];
    const at = rows.findIndex((one) => one.textContent?.includes("file739.ts"));
    return { last: rows[at].getBoundingClientRect().y, next: rows[at + 1].getBoundingClientRect().y };
  });
  const placed = (await page.getByTestId("name-row").boundingBox())!;
  expect(placed.y).toBeGreaterThan(around.last);
  expect(placed.y).toBeLessThan(around.next);

  // The agent adds a file while the field is open: the field is the one
  // being typed in, never made again.
  await page.keyboard.type("new");
  await field.evaluate((input) => ((input as HTMLInputElement & { kept?: boolean }).kept = true));
  await page.evaluate(() =>
    (window as unknown as { __disk: { write: (file: string, text: string) => void } }).__disk.write(
      "src/area0/part0/added.ts",
      "",
    ),
  );
  await expect(row(page, "added.ts")).toBeVisible();
  expect(await field.evaluate((input) => (input as HTMLInputElement & { kept?: boolean }).kept)).toBe(true);
  await expect(field).toHaveValue("new");
  expect(await walks(page)).toBeLessThanOrEqual(3);

  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  expect(await walks(page)).toBe(1);
});
