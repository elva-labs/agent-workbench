import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * What a plugin shows for one session: a section in the changes pane only
 * while that session is shown, rows that open to their facts, and a mark on
 * the session's row. In both looks.
 */

const ROW = "[data-testid='session-row']";
const CHANGES = "section[data-pane='changes']";

/** Set to a folder, the test leaves its screenshots there. */
const SHOTS = process.env.PLUGIN_SESSION_SHOTS;

const row = (page: Page, name: string) => page.locator(ROW).filter({ hasText: name });

/** Two terminal sessions, the second on screen, and their tokens. */
async function two(page: Page, look: "modern" | "terminal") {
  await installFakeCore(page, { open: [PROJECT], settings: { look } });
  await page.goto("/");
  await page.getByTestId("new-session").click();
  await expect(row(page, "session 1")).toContainText("running");
  await page.getByTestId("new-session").click();
  await expect(page.locator(ROW)).toHaveCount(2);
  return page.evaluate(() =>
    ((window as unknown as { __spawns: { token: string }[] }).__spawns).map((spawn) => spawn.token),
  );
}

const FACTS = [
  { label: "lint", text: "passed", state: "ok" },
  { label: "test", text: "running for 2m", state: "busy" },
  { label: "review", text: "changes requested", state: "failed" },
];

/** A section a plugin sends for one session, or the project when null. */
async function pushSection(page: Page, session: string | null, title: string) {
  await page.evaluate(
    ({ project, session, title }) =>
      (window as unknown as { __pluginSection: (event: unknown) => void }).__pluginSection({
        source: "src-1",
        plugin: "github",
        section: "Pull request",
        title,
        project,
        session,
        rows: [
          {
            id: "pr-12",
            label: "#12 Add session marks",
            detail: "2 checks, 1 review",
            state: "failed",
            actions: [{ id: "open", label: "Open", input: null }],
            default: "open",
            facts: [
              { label: "lint", text: "passed", state: "ok" },
              { label: "test", text: "running for 2m", state: "busy" },
              { label: "review", text: "changes requested", state: "failed" },
            ],
          },
          {
            id: "pr-14",
            label: "#14 Tidy the docs",
            detail: "draft",
            state: "waiting",
            actions: [],
            facts: [{ label: "draft", text: null, state: "waiting" }],
          },
        ],
        actions: [],
      }),
    { project: PROJECT, session, title },
  );
}

async function pushMark(page: Page, session: string, mark: Record<string, unknown>) {
  await page.evaluate(
    ({ project, session, mark }) =>
      (window as unknown as { __pluginMark: (event: unknown) => void }).__pluginMark({
        source: "src-1",
        plugin: "github",
        project,
        session,
        ...mark,
      }),
    { project: PROJECT, session, mark },
  );
}

for (const look of ["modern", "terminal"] as const) {
  test.describe(`in the ${look} look`, () => {
    test("shows a session's section only while that session is shown", async ({ page }) => {
      const [first, second] = await two(page, look);
      await pushSection(page, null, "Project's");
      await pushSection(page, first, "Session 1's");
      const fold = page.getByTestId("plugin-fold");

      // The second session is shown: the project's section stands.
      await expect(fold).toHaveCount(1);
      await expect(fold).toContainText("Project's");

      // The first is shown: its own section stands in for the project's.
      await row(page, "session 1").click();
      await expect(fold).toHaveCount(1);
      await expect(fold).toContainText("Session 1's");

      // A section for the second session never shows beside the first's.
      await pushSection(page, second, "Session 2's");
      await expect(fold).toContainText("Session 1's");
      await row(page, "session 2").click();
      await expect(fold).toContainText("Session 2's");
    });

    test("opens rows to their facts, several at once, by pointer and keys", async ({ page }) => {
      const [, second] = await two(page, look);
      await pushSection(page, second, "Pull request");
      await page.getByTestId("plugin-fold").click();
      const rows = page.getByTestId("plugin-row");
      await expect(rows).toHaveCount(2);
      await expect(page.getByTestId("plugin-facts")).toHaveCount(0);

      // A click opens a row with facts instead of running its default.
      await rows.first().locator(".media-row").click();
      const facts = rows.first().getByTestId("plugin-fact");
      await expect(facts).toHaveCount(FACTS.length);
      for (const [at, fact] of FACTS.entries()) {
        await expect(facts.nth(at)).toContainText(fact.label);
        await expect(facts.nth(at)).toContainText(fact.text);
        await expect(facts.nth(at)).toHaveAttribute("data-state", fact.state);
      }
      expect(
        await page.evaluate(() => (window as unknown as { __pluginActions?: unknown[] }).__pluginActions ?? []),
      ).toEqual([]);

      // The facts sit under their row, inside the pane, indented past its dot.
      const line = (await rows.first().locator(".media-row").boundingBox())!;
      const list = (await rows.first().getByTestId("plugin-facts").boundingBox())!;
      const pane = (await page.locator(CHANGES).boundingBox())!;
      expect(list.y).toBeGreaterThanOrEqual(line.y + line.height - 1);
      const rowDot = (await rows.first().locator(".media-row .dot").boundingBox())!;
      const factDot = (await facts.first().locator(".dot").boundingBox())!;
      expect(factDot.x).toBeGreaterThan(rowDot.x);
      expect(list.x + list.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
      await expect(facts.first()).toBeVisible();

      // A second row opens beside the first, which stays open.
      await rows.nth(1).locator(".media-row").click();
      await expect(page.getByTestId("plugin-facts")).toHaveCount(2);
      if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/facts-${look}.png` });

      // With the cursor on the last row: Left closes it, Right opens it.
      await page.getByTestId("file-tree").focus();
      await page.keyboard.press("End");
      await expect(rows.last()).toHaveClass(/cursor/);
      await page.keyboard.press("ArrowLeft");
      await expect(rows.last().getByTestId("plugin-facts")).toHaveCount(0);
      await expect(rows.first().getByTestId("plugin-facts")).toHaveCount(1);
      await expect(rows.last()).toHaveClass(/cursor/);
      await page.keyboard.press("ArrowRight");
      await expect(rows.last().getByTestId("plugin-facts")).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(rows.last().getByTestId("plugin-facts")).toHaveCount(0);
    });

    test("marks a session's row quietly, on its second line", async ({ page }) => {
      const [first, second] = await two(page, look);
      await pushMark(page, first, { icon: "pull-request", count: 2, state: "failed", label: "2 pull requests, 1 failing" });
      await pushMark(page, second, { icon: "pull-request", count: 1, state: "ok" });

      const failing = row(page, "session 1").getByTestId("plugin-mark");
      const fine = row(page, "session 2").getByTestId("plugin-mark");
      await expect(failing).toBeVisible();
      await expect(failing).toHaveText("2");
      await expect(failing).toHaveAttribute("data-state", "failed");
      await expect(failing).toHaveAttribute("title", "2 pull requests, 1 failing");
      await expect(fine).toHaveAttribute("title", "github: 1");

      // The mark sits on the second line, inside the row, below its name,
      // and takes little of its width.
      const box = (await row(page, "session 1").boundingBox())!;
      const label = (await row(page, "session 1").locator(".label").boundingBox())!;
      const mark = (await failing.boundingBox())!;
      expect(mark.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
      expect(mark.x).toBeGreaterThanOrEqual(box.x);
      expect(mark.x + mark.width).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(mark.y + mark.height).toBeLessThanOrEqual(box.y + box.height + 1);
      expect(mark.width).toBeLessThan(box.width / 3);

      // Failing is tinted; ok stays the quiet colour of the line.
      const colour = (mark: typeof failing) => mark.evaluate((el) => getComputedStyle(el).color);
      const note = await row(page, "session 2")
        .locator(".second")
        .evaluate((el) => getComputedStyle(el).color);
      expect(await colour(fine)).toBe(note);
      expect(await colour(failing)).not.toBe(note);
      if (SHOTS !== undefined) await page.locator("section[data-pane='sessions']").screenshot({ path: `${SHOTS}/marks-${look}.png` });

      // No icon takes the mark away, and its line with it.
      await pushMark(page, first, { icon: null });
      await expect(failing).toHaveCount(0);
      await expect(fine).toHaveCount(1);

      // A row draws two marks at most, the one waiting on the user among them.
      await pushMark(page, second, { plugin: "linear", icon: "issue", count: 3, state: "waiting" });
      await pushMark(page, second, { plugin: "sentry", icon: "dot", count: null, state: "ok" });
      await expect(fine).toHaveCount(2);
      expect(await fine.evaluateAll((marks) => marks.map((mark) => mark.getAttribute("data-plugin")))).toEqual([
        "src-1/github",
        "src-1/linear",
      ]);
    });
  });
}

test("opens a plugin's web address in the user's browser", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await page.waitForFunction(() => "__pluginOpenUrl" in window);
  await page.evaluate((project) => {
    (window as unknown as { __pluginOpenUrl: (event: unknown) => void }).__pluginOpenUrl({
      source: "src-1",
      plugin: "github",
      project,
      url: "https://example.com/pull/12",
    });
  }, PROJECT);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __openedUrls?: string[] }).__openedUrls ?? []))
    .toEqual(["https://example.com/pull/12"]);
});
