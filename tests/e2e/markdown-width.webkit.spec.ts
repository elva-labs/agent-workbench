import { expect, test, type Page } from "@playwright/test";
import { installFakeCore, PROJECT } from "./fake";

/**
 * A presented Markdown document uses the viewer's width: its prose, tables
 * and code blocks reach the viewer's padding at a wide viewer and at a
 * narrow one, rather than keeping to a column.
 */

const TEXT = [
  "# Options",
  "",
  "Running prose that goes on. ".repeat(40),
  "",
  "| Option | Summary |",
  "| --- | --- |",
  `| A | ${"a cell with several words ".repeat(12)} |`,
  "",
  "```ts",
  `const long = "${"x".repeat(200)}";`,
  "```",
].join("\n");

async function present(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
  await page.evaluate((text) => {
    (window as unknown as { __markdown?: string }).__markdown = text;
  }, TEXT);
  await page.evaluate(
    (project) =>
      (window as unknown as { __presentRequest: (request: unknown) => void }).__presentRequest({
        files: [`${project}/docs/wide.md`],
        caption: "The options.",
        cwd: project,
      }),
    PROJECT,
  );
  await expect(page.getByTestId("media-document")).toBeVisible();
}

for (const width of [1920, 900]) {
  test(`fills the viewer at ${width}px`, async ({ page }) => {
    await present(page, width);
    const document = page.getByTestId("media-document");
    const room = (await page.getByTestId("viewer").boundingBox())!;
    const box = (await document.boundingBox())!;
    expect(box.width).toBeGreaterThan(room.width - 80);
    const prose = (await document.locator("p").first().boundingBox())!;
    expect(prose.width).toBeGreaterThan(box.width - 2);
    const table = (await document.locator("table").boundingBox())!;
    expect(table.width).toBeGreaterThan(box.width - 2);
    const code = (await document.locator("pre").boundingBox())!;
    expect(code.width).toBeGreaterThan(box.width - 2);
  });
}
