import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * Folders handed to the app from outside the window: named when it started,
 * or from a terminal while it runs.
 */

const ASKED = "/home/ada/dev/tools";

const row = (page: Page, path: string) =>
  page.locator(`[data-row="project:${path}"]`);

const ask = (page: Page, path: string) =>
  page.evaluate(
    (path) =>
      (
        window as unknown as { __openRequested?: (paths: string[]) => void }
      ).__openRequested?.([path]),
    path,
  );

test("a folder the app started with opens beside the stored ones, in front", async ({
  page,
}) => {
  await installFakeCore(page, { opened: [ASKED] });
  await page.goto("/");
  await expect(row(page, ASKED)).toBeVisible();
  await expect(row(page, ASKED)).toHaveClass(/\bon\b/);
  await expect(row(page, PROJECT)).toBeVisible();
  await expect(row(page, PROJECT)).not.toHaveClass(/\bon\b/);
});

test("a folder asked for while the app runs comes to the front, once", async ({
  page,
}) => {
  await installFakeCore(page);
  await page.goto("/");
  await expect(row(page, PROJECT)).toHaveClass(/\bon\b/);

  await ask(page, ASKED);
  await expect(row(page, ASKED)).toBeVisible();
  await expect(row(page, ASKED)).toHaveClass(/\bon\b/);

  await ask(page, PROJECT);
  await expect(row(page, PROJECT)).toHaveClass(/\bon\b/);
  await expect(page.locator('[data-row^="project:"]')).toHaveCount(2);
});
