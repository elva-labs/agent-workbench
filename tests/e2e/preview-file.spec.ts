import { expect, test, type Page } from "@playwright/test";
import { installFakeCore, PROJECT, type GitFixture } from "./fake";

/**
 * A file the app renders can be previewed from the palette: "Preview file"
 * shows it as the agent's presented documents are shown, "Show source" goes
 * back, and another file opens on its source.
 */

const MOD = "ControlOrMeta";
const AGENT = "section[data-pane='agent']";

const change = (path: string) => ({ path, status: "M", add: 1, del: 1, binary: false });
const FIXTURE: GitFixture = {
  status: ["notes.md", "page.html", "main.rs", "other.rs"].map(change),
  files: ["notes.md", "page.html", "main.rs", "other.rs"],
};

async function open(page: Page, file: string) {
  await installFakeCore(page, { open: [PROJECT], fixture: FIXTURE });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await page.evaluate((text) => {
    (window as unknown as { __markdown?: string }).__markdown = text;
  }, "# The plan\n\nAn opening paragraph.\n");
  await page.getByTestId("file-tree").getByText(file).first().click();
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "reviewing");
}

async function run(page: Page, words: string, chord = "p") {
  await page.keyboard.press(`${MOD}+${chord}`);
  await page.keyboard.type(words);
  await page.keyboard.press("Enter");
}

test("previews a Markdown file from go to, then shows its source", async ({ page }) => {
  await open(page, "notes.md");
  const viewer = page.getByTestId("viewer");
  await expect(viewer.locator("table.lines")).toBeVisible();

  await run(page, "preview");
  await expect(page.getByTestId("media-document").getByRole("heading", { name: "The plan" })).toBeVisible();
  await expect(viewer.locator("table.lines")).toHaveCount(0);

  await run(page, "source");
  await expect(viewer.locator("table.lines")).toBeVisible();
  await expect(page.getByTestId("media-document")).toHaveCount(0);
});

test("offers the command in the command palette, and not for a file it cannot render", async ({ page }) => {
  await open(page, "notes.md");
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.keyboard.type("preview");
  await expect(page.getByTestId("palette-row")).toHaveText([/Preview file/]);
  await page.keyboard.press("Escape");

  await page.getByTestId("file-tree").getByText("main.rs").first().click();
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.keyboard.type("preview");
  await expect(page.getByTestId("palette-row")).toHaveCount(0);
});

test("opens another file on its source", async ({ page }) => {
  await open(page, "notes.md");
  await run(page, "preview");
  await expect(page.getByTestId("media-document")).toBeVisible();
  await page.getByTestId("file-tree").getByText("other.rs").first().click();
  await expect(page.getByTestId("viewer").locator("table.lines")).toBeVisible();
});
