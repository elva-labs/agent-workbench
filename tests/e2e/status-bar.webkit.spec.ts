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
  await page.keyboard.press("Space");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
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
