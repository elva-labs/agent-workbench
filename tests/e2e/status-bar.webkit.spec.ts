import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// The status bar by keyboard alone, in WebKit as well as Chromium: WebKit,
// the app's webview on macOS, passes over a control on Tab unless it is
// made a stop. The model, the effort and the allowance are stops after the
// rest of the window; each opens with Enter or Space, and what opens hands
// the keyboard back where it was when it goes.

const H = "int-1";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

async function open(page: Page) {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: {
      integrated: ["claude-code"],
      accounts: { list: { Work: { claude: "~/.claude-work", codex: null } }, everywhere: "Work", overrides: {} },
    },
  });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await agent(
    page,
    `f.configure("${H}", { effort: "high" });
     const now = Math.floor(Date.now() / 1000);
     f.limits("${H}", [{ kind: "session", percent: 11, resetsAt: now + 7800 }, { kind: "weekly", percent: 34, resetsAt: now + 259200 }], { plan: "team" });`,
  );
  await expect(page.getByTestId("limit-figure")).toHaveCount(2);
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const owner = document.activeElement as HTMLElement | null;
    return owner?.getAttribute("data-testid") ?? owner?.tagName.toLowerCase() ?? null;
  });

const visiblyFocused = (page: Page) => page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false);

/** Tabs on from the composer until the keyboard reaches a control of the
    bar, which comes after the rest of the window. */
async function tabTo(page: Page, testid: string) {
  for (let presses = 0; presses < 60; presses += 1) {
    if ((await focused(page)) === testid) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${testid}; the keyboard is on ${await focused(page)}`);
}

test("reaches the model, the effort and the allowance by Tab, in that order, with the focus drawn", async ({ page }) => {
  await open(page);
  await tabTo(page, "model-readout");
  expect(await visiblyFocused(page)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("effort-readout");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("account-group");
  await page.keyboard.press("Shift+Tab");
  expect(await focused(page)).toBe("effort-readout");
});

test("opens the model's menu on Enter, walks it with the arrows, and picks", async ({ page }) => {
  await open(page);
  await tabTo(page, "model-readout");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-model-menu")).toBeVisible();
  // On the model in use.
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Sonnet");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Haiku");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-model-menu")).toHaveCount(0);
  await expect(page.getByTestId("model-readout")).toHaveText("Haiku");
  // Back where it was: on the model.
  expect(await focused(page)).toBe("model-readout");
});

test("opens the effort's menu on Space, and Tab goes on from it to the allowance", async ({ page }) => {
  await open(page);
  await tabTo(page, "effort-readout");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("status-effort-menu")).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("High");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("status-effort-menu")).toHaveCount(0);
  expect(await focused(page)).toBe("account-group");
});

test("opens the allowance on Enter, and Escape gives the keyboard back", async ({ page }) => {
  await open(page);
  await tabTo(page, "account-group");
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("allowance-popover");
  await expect(popover).toBeVisible();
  expect(await focused(page)).toBe("allowance-popover");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  expect(await focused(page)).toBe("account-group");
  // Enter and Space put it away again, as on the control.
  await page.keyboard.press("Space");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(popover).toHaveCount(0);
  expect(await focused(page)).toBe("account-group");
  await page.keyboard.press("Enter");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Space");
  await expect(popover).toHaveCount(0);
  expect(await focused(page)).toBe("account-group");
});

test("stops on the allowance on Tab from its popover", async ({ page }) => {
  await open(page);
  await page.getByTestId("composer-input").fill("a draft");
  await page.getByTestId("account-group").click();
  const popover = page.getByTestId("allowance-popover");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(popover).toHaveCount(0);
  expect(await focused(page)).toBe("account-group");
  await page.keyboard.press("Shift+Tab");
  expect(await focused(page)).toBe("effort-readout");
});

test("hands the keyboard back to the composer when a menu opened by a press is put away", async ({ page }) => {
  await open(page);
  const input = page.getByTestId("composer-input");
  await input.fill("a draft");
  await page.getByTestId("effort-readout").click();
  await expect(page.getByTestId("status-effort-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status-effort-menu")).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("a draft");
  // The bar's controls are window chrome: a press on one leaves the pane
  // the keyboard was in named as focused.
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
});

const current = (page: Page) => page.evaluate(() => document.activeElement?.querySelector(".name")?.textContent?.trim() ?? null);
const marked = (page: Page, testid: string) =>
  page.evaluate(
    (testid) =>
      [...document.querySelectorAll<HTMLElement>(`[data-testid='${testid}']`)]
        .filter((item) => getComputedStyle(item).backgroundColor !== "rgba(0, 0, 0, 0)")
        .map((item) => item.querySelector(".name")?.textContent?.trim()),
    testid,
  );

for (const [control, option] of [
  ["model-readout", "status-model-option"],
  ["model-chip", "model-option"],
])
  test(`moves one mark with the pointer and the arrows in a menu opened by a press: ${control}`, async ({ page }) => {
    await open(page);
    await page.getByTestId(control).click();
    const options = page.getByTestId(option);
    await expect(options).toHaveCount(3);
    // Opened by a press, the menu marks nothing, though the keyboard is on
    // the model in use; the first arrow marks that one rather than moving
    // past it.
    expect(await current(page)).toBe("Sonnet");
    expect(await marked(page, option)).toEqual([]);
    await page.keyboard.press("ArrowDown");
    expect(await current(page)).toBe("Sonnet");
    expect(await marked(page, option)).toEqual(["Sonnet"]);
    // The choice under the pointer takes the keyboard, and the arrows go on
    // from there.
    await options.first().hover();
    expect(await current(page)).toBe("Default (recommended)");
    expect(await marked(page, option)).toEqual(["Default (recommended)"]);
    await page.keyboard.press("ArrowDown");
    expect(await current(page)).toBe("Haiku");
    expect(await marked(page, option)).toEqual(["Haiku"]);
    await page.keyboard.press("Escape");
  });

// With the terminal panel open the bar is still reached: it comes before
// the panel in the walk, since the panel ends in a shell that keeps Tab,
// and its chord puts the keyboard on its first control from anywhere, a
// shell and the editor included. Escape there gives the keyboard back.

const MOD = "ControlOrMeta";
const TREE = "[data-testid='file-tree']";

/** Opens the terminal panel, with the keyboard in its shell. */
async function openPanel(page: Page) {
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.getByTestId("terminal-row")).toHaveCount(1);
  await expect.poll(() => focused(page)).toBe("textarea");
}

const label = (page: Page) =>
  page.evaluate(() => {
    const owner = document.activeElement as HTMLElement | null;
    return owner?.getAttribute("data-testid") ?? owner?.getAttribute("aria-label") ?? null;
  });

test("reaches the bar by Tab before the terminal panel, with the panel open", async ({ page }) => {
  await open(page);
  await openPanel(page);
  await page.locator(TREE).focus();
  const walked: (string | null)[] = [];
  for (let presses = 0; presses < 40 && (await focused(page)) !== "model-readout"; presses += 1) {
    await page.keyboard.press("Tab");
    walked.push(await label(page));
  }
  expect(await focused(page)).toBe("model-readout");
  expect(walked).not.toContain("new-terminal");
  expect(walked).not.toContain("Terminal input");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("effort-readout");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("account-group");
  // Then the panel, its own controls before its shell.
  await page.keyboard.press("Tab");
  expect(await label(page)).toBe("Resize the terminal");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("new-terminal");
});

test("goes to the bar on its chord from a shell, and Escape gives the keyboard back to the shell", async ({ page }) => {
  await open(page);
  await openPanel(page);
  await page.keyboard.press(`${MOD}+5`);
  expect(await focused(page)).toBe("model-readout");
  expect(await visiblyFocused(page)).toBe(true);
  // Window chrome: the pane keeps the focus.
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: terminal");
  await page.keyboard.press("Escape");
  await expect.poll(() => label(page)).toBe("Terminal input");
  await expect(page.getByTestId("status-model-menu")).toHaveCount(0);
});

test("goes to the bar on its chord from the editor in editor mode, and back to it on Escape", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${MOD}+Shift+e`);
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "editing");
  await page.locator(TREE).getByText("README.md", { exact: true }).dblclick();
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+5`);
  expect(await focused(page)).toBe("model-readout");
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".cm-editor") != null)).toBe(true);
});

test("says so when the bar has nothing to reach", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
  await page.keyboard.press(`${MOD}+5`);
  await expect(page.getByTestId("flash-readout")).toHaveText("Nothing to change in the status bar");
});
