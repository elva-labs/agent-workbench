import { expect, test } from "@playwright/test";
import { installFakeCore } from "./fake";

const MOD = "ControlOrMeta";
const AGENT = "section[data-pane='agent']";

test.beforeEach(async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
});

test("opens on the chord and from the menu, and closes on Escape", async ({
  page,
}) => {
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("settings")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toBeHidden();

  // What the native menu's Settings item does.
  await page.evaluate(() =>
    (window as unknown as { __openSettings?: () => void }).__openSettings?.(),
  );
  await expect(page.getByTestId("settings")).toBeVisible();
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("settings")).toBeHidden();
});

test("changes the theme and keeps it", async ({ page }) => {
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("changes the colour palette, which repaints the panes, and keeps it", async ({
  page,
}) => {
  const accentOf = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim(),
    );
  const before = await accentOf();

  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("palette-indigo").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
  expect(await accentOf()).not.toBe(before);
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
});

// The vim preset moves between panes on h, j, k and l. The status bar and the
// keys themselves follow at once, and the choice survives a reload.
test("switches to the vim preset and the keys follow", async ({ page }) => {
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("preset-vim").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toBeHidden();

  await page.keyboard.press(`${MOD}+l`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
  await page.keyboard.press(`${MOD}+h`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  // The default chord for the same thing no longer does it.
  await page.keyboard.press(`${MOD}+3`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");

  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await page.keyboard.press(`${MOD}+l`);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: changes");
});

test("records a chord of one's own", async ({ page }) => {
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("chord-review").click();
  await expect(page.getByTestId("chord-review")).toHaveText(/Press keys/);
  await page.keyboard.press(`${MOD}+g`);
  await expect(page.getByTestId("chord-review")).not.toHaveText(/Press keys/);
  await expect(page.getByTestId("preset-custom")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press(`${MOD}+g`);
  await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${MOD}+d`);
  await expect(page.getByTestId("mode-readout")).toHaveText("working");
});

// A setup from before hooks were a choice is told once that they are worth
// turning on; the word links to the section and goes for good on dismissal.
test.describe("the hooks notice", () => {
  test.beforeEach(async ({ page }) => {
    // A setup from before the choice: the fake's workspace on record, hooks
    // off, and the word not yet taken.
    await page.addInitScript(() => {
      // Once for the tab: a reload after that keeps what the app wrote.
      if (sessionStorage.getItem("notice-test") !== null) return;
      sessionStorage.setItem("notice-test", "1");
      localStorage.setItem(
        "workbench.hooks",
        JSON.stringify({ everywhere: false, overrides: {} }),
      );
      localStorage.removeItem("workbench.notices");
    });
    await page.reload();
    await expect(page.locator(AGENT)).toBeVisible();
  });

  test("opens the settings at the live updates section, lit", async ({
    page,
  }) => {
    const notice = page.getByTestId("hooks-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Let the agent talk to the workbench");
    await page.getByTestId("hooks-notice-settings").click();
    await expect(page.getByTestId("settings")).toBeVisible();
    await expect(page.getByTestId("settings-live")).toHaveClass(/lit/);
    await expect(page.getByTestId("settings-live")).toBeInViewport();
    await page.keyboard.press("Escape");
    // Still there: only a dismissal or hooks turned on takes it away.
    await expect(notice).toBeVisible();
  });

  test("goes for good when dismissed", async ({ page }) => {
    await page.getByTestId("hooks-notice-dismiss").click();
    await expect(page.getByTestId("hooks-notice")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(AGENT)).toBeVisible();
    await expect(page.getByTestId("hooks-notice")).toHaveCount(0);
  });

  test("goes when hooks are turned on, and stays gone", async ({ page }) => {
    await page.getByTestId("hooks-notice-settings").click();
    await page.getByTestId("hooks-everywhere-on").click();
    await expect(page.getByTestId("hooks-notice")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.locator(AGENT)).toBeVisible();
    await expect(page.getByTestId("hooks-notice")).toHaveCount(0);
  });

  test("does not show on a fresh install, which has hooks on", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.removeItem("workbench.workspace");
      localStorage.removeItem("workbench.hooks");
      localStorage.removeItem("workbench.notices");
    });
    await page.reload();
    await expect(page.locator(AGENT)).toBeVisible();
    await expect(page.getByTestId("hooks-notice")).toHaveCount(0);
  });
});

// Plugin sources: added by URL, listed with their plugins off, turned on
// after the question, and removed.
test.describe("plugins", () => {
  test("adds a source, turns a plugin on after the question, and removes it", async ({
    page,
  }) => {
    await page.keyboard.press(`${MOD}+,`);
    await expect(page.getByTestId("settings")).toBeVisible();
    await page
      .getByTestId("plugin-location")
      .fill("https://example.com/bad.git");
    await page.getByTestId("plugin-add").click();
    await expect(page.getByTestId("plugin-error")).toContainText(
      "could not clone",
    );
    await expect(page.getByTestId("plugin-source")).toHaveCount(0);

    await page
      .getByTestId("plugin-location")
      .fill("https://example.com/good-plugins.git");
    await page.getByTestId("plugin-add").click();
    const source = page.getByTestId("plugin-source");
    await expect(source).toHaveCount(1);
    await expect(source).toContainText("good-plugins.git");
    await expect(source).toContainText("0123456");
    const row = page.getByTestId("plugin-row");
    await expect(row).toContainText("github");
    await expect(page.getByTestId("plugin-state")).toContainText(
      "2 tools, 1 section, a wide view, runs node · off",
    );

    // On asks once, and says what it means.
    await row.getByTestId("plugin-on").click();
    await expect(page.getByTestId("plugin-ask")).toContainText(
      "runs node with your privileges",
    );
    await page.getByTestId("plugin-cancel").click();
    await expect(page.getByTestId("plugin-ask")).toHaveCount(0);
    await expect(row.getByTestId("plugin-on")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await row.getByTestId("plugin-on").click();
    await page.getByTestId("plugin-agree").click();
    await expect(row.getByTestId("plugin-on")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("plugin-state")).toContainText("starting");
    // The core's word arrives: running, with the greeting's version.
    await page.evaluate(() =>
      (
        window as unknown as { __pluginState: (event: unknown) => void }
      ).__pluginState({
        source: "src-1",
        name: "github",
        state: "running",
        detail: null,
        hello: {
          name: "github",
          version: "0.2.0",
          tools: [{ name: "pr" }],
          sections: [],
          view: null,
        },
      }),
    );
    await expect(page.getByTestId("plugin-state")).toContainText(
      "running 0.2.0",
    );

    // Off, then on again: no question the second time.
    await row.getByTestId("plugin-off").click();
    await expect(page.getByTestId("plugin-state")).toContainText("off");
    await row.getByTestId("plugin-on").click();
    await expect(page.getByTestId("plugin-ask")).toHaveCount(0);
    await expect(row.getByTestId("plugin-on")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // A check finds a newer commit; the update takes it.
    await page.getByTestId("plugin-check").click();
    await expect(page.getByTestId("plugin-update")).toContainText("fedcba9");
    await page.getByTestId("plugin-update").click();
    await expect(page.getByTestId("plugin-update")).toHaveCount(0);
    await expect(source).toContainText("fedcba9");

    await page.getByTestId("plugin-remove").click();
    await expect(page.getByTestId("plugin-source")).toHaveCount(0);
  });
});
