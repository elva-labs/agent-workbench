import { expect, test } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

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

// Four tabs down the left, one section's worth of settings beside them.
test.describe("the tabs", () => {
  test("show one section at a time", async ({ page }) => {
    await page.keyboard.press(`${MOD}+,`);
    await expect(page.getByTestId("settings-tab-appearance")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("theme-system")).toBeVisible();
    await expect(page.getByTestId("settings-live")).toHaveCount(0);
    await expect(page.getByTestId("plugin-location")).toHaveCount(0);
    await expect(page.getByTestId("preset-vim")).toHaveCount(0);

    await page.getByTestId("settings-tab-keys").click();
    await expect(page.getByTestId("preset-vim")).toBeVisible();
    await expect(page.getByTestId("theme-system")).toHaveCount(0);
    await expect(page.getByTestId("settings-tab-keys")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByTestId("settings-tab-appearance"),
    ).not.toHaveAttribute("aria-current", "page");
  });

  test("keep the tab from one opening to the next", async ({ page }) => {
    await page.keyboard.press(`${MOD}+,`);
    await page.getByTestId("settings-tab-plugins").click();
    await expect(page.getByTestId("plugin-location")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings")).toBeHidden();

    await page.keyboard.press(`${MOD}+,`);
    await expect(page.getByTestId("settings-tab-plugins")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("plugin-location")).toBeVisible();

    // A window of its own starts on the first tab again.
    await page.reload();
    await expect(page.locator(AGENT)).toBeVisible();
    await page.keyboard.press(`${MOD}+,`);
    await expect(page.getByTestId("settings-tab-appearance")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("move on the arrows, either way", async ({ page }) => {
    const current = (name: string) =>
      expect(page.getByTestId(`settings-tab-${name}`)).toHaveAttribute(
        "aria-current",
        "page",
      );

    await page.keyboard.press(`${MOD}+,`);
    await page.getByTestId("settings-tab-appearance").click();
    await page.keyboard.press("ArrowDown");
    await current("live");
    await expect(page.getByTestId("settings-live")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await current("plugins");
    await page.keyboard.press("ArrowUp");
    await current("live");
    await page.keyboard.press("ArrowLeft");
    await current("appearance");
    // The tab it reaches has the keyboard, so the next arrow moves from there.
    await expect(page.getByTestId("settings-tab-appearance")).toBeFocused();
  });
});

test("changes the theme and keeps it", async ({ page }) => {
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-appearance").click();
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
  await page.getByTestId("settings-tab-appearance").click();
  await page.getByTestId("palette-indigo").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
  expect(await accentOf()).not.toBe(before);
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "indigo");
});

test("changes the theme's look and keeps it", async ({ page }) => {
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-appearance").click();
  await page.getByTestId("look-modern").click();
  await expect(page.locator("html")).toHaveAttribute("data-look", "modern");
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-look", "modern");

  // Back to terminal, which is the look the tokens are written in and
  // carries no stamp at all.
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-appearance").click();
  await page.getByTestId("look-terminal").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-look", /.*/);
});

// The face the terminal draws in follows the choice without a restart: the
// open terminals are told the new family as the stamp lands.
test("changes the terminal font, which the open terminals take at once, and keeps it", async ({
  page,
}) => {
  const fontOf = () =>
    page.evaluate(() => {
      const registry =
        (
          window as unknown as {
            __WORKBENCH_TERMINALS__?: Record<
              string,
              { options: { fontFamily?: string } }
            >;
          }
        ).__WORKBENCH_TERMINALS__ ?? {};
      return Object.values(registry)[0]?.options.fontFamily ?? null;
    });
  // A session, so there is a terminal to change under us.
  const terminal = async () => {
    if ((await fontOf()) === null)
      await page.getByTestId("new-session").click();
    await expect.poll(fontOf).not.toBeNull();
  };

  await terminal();
  expect(await fontOf()).toMatch(/^ui-monospace/);

  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-appearance").click();
  await page.getByTestId("mono-jetbrains").click();
  await expect(page.locator("html")).toHaveAttribute("data-mono", "jetbrains");
  await expect.poll(fontOf).toContain("JetBrains Mono");
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-mono", "jetbrains");
  await terminal();
  expect(await fontOf()).toContain("JetBrains Mono");
});

test("changes the interface font, which repaints the chrome, and keeps it", async ({
  page,
}) => {
  const sansOf = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--sans")
        .trim(),
    );
  expect(await sansOf()).toMatch(/^-apple-system/);

  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-appearance").click();
  await page.getByTestId("sans-plex").click();
  await expect(page.locator("html")).toHaveAttribute("data-sans", "plex");
  expect(await sansOf()).toContain("IBM Plex Sans");
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-sans", "plex");
  expect(await sansOf()).toContain("IBM Plex Sans");
});

// The vim preset moves between panes on h, j, k and l. The status bar and the
// keys themselves follow at once, and the choice survives a reload.
test("switches to the vim preset and the keys follow", async ({ page }) => {
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-keys").click();
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
  await page.getByTestId("settings-tab-keys").click();
  await page.getByTestId("chord-review").click();
  await expect(page.getByTestId("chord-review")).toHaveText(/Press keys/);
  await page.keyboard.press(`${MOD}+g`);
  await expect(page.getByTestId("chord-review")).not.toHaveText(/Press keys/);
  await expect(page.getByTestId("preset-custom")).toBeVisible();
  await page.keyboard.press("Escape");

  // A chord on the arrows is recorded, not read as a walk down the tabs.
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("chord-view").click();
  await page.keyboard.press(`${MOD}+Shift+ArrowRight`);
  await expect(page.getByTestId("chord-view")).toHaveText("Ctrl+Shift+Right");
  await expect(page.getByTestId("settings-tab-keys")).toHaveAttribute(
    "aria-current",
    "page",
  );
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
    await expect(page.getByTestId("settings-tab-live")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("theme-system")).toHaveCount(0);
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
    // The word lands on the tab the section is in, so the choice is there.
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
    await page.getByTestId("settings-tab-plugins").click();
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
    // A plugin with a build is built before its process starts, and the row
    // says so while it goes.
    await page.evaluate(() =>
      (
        window as unknown as { __pluginState: (event: unknown) => void }
      ).__pluginState({
        source: "src-1",
        name: "github",
        state: "building",
        detail: null,
        hello: null,
      }),
    );
    await expect(page.getByTestId("plugin-state")).toContainText("building");
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

  // The projects open reach the core, so the plugins on the machine know
  // which ones they serve.
  test("tells the core which projects are open", async ({ page }) => {
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as { __pluginProjects?: string[][] }
            ).__pluginProjects?.at(-1) ?? null,
        ),
      )
      .toEqual([PROJECT]);
  });
});
