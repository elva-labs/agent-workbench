import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// An integrated session by keyboard alone, in WebKit as well as Chromium:
// WebKit, the app's webview on macOS, passes over a control on Tab unless
// it is made a stop. The composer's controls and the cards' buttons are
// stops in reading order; the thread and the dock's choices are one stop
// each, walked with the arrows.

const H = "int-1";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

async function open(page: Page, options: { untrusted?: boolean } = {}) {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  if (options.untrusted)
    await page.addInitScript(
      (project) => (window as unknown as { __integrated: { untrusted: Set<string> } }).__integrated.untrusted.add(project),
      PROJECT,
    );
  await page.goto("/");
  await page.getByTestId("start-agent").click();
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const owner = document.activeElement as HTMLElement | null;
    return owner?.getAttribute("data-testid") ?? owner?.tagName.toLowerCase() ?? null;
  });

const visiblyFocused = (page: Page) => page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false);

test("reaches and uses every control of the composer by Tab", async ({ page }) => {
  await open(page);
  const input = page.getByTestId("composer-input");
  await expect(input).toBeFocused();
  await input.fill("Fix the scan");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("attach");
  expect(await visiblyFocused(page)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("model-chip");
  // The model's menu by keyboard: open it, walk it, pick.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("model-menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("model-menu")).toHaveCount(0);
  await page.getByTestId("model-chip").focus();
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("mode-chip");
  // Before the first message, the workflow: its menu by keyboard too.
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("workflow-chip");
  expect(await visiblyFocused(page)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workflow-menu")).toBeVisible();
  expect(await focused(page)).toBe("workflow-option");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("workflow-menu")).toHaveCount(0);
  expect(await focused(page)).toBe("workflow-chip");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("send");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  // Sent, the workflow is kept and its chip goes.
  await expect(page.getByTestId("workflow-chip")).toHaveCount(0);
});

test("walks the thread as one stop, with the arrows", async ({ page }) => {
  await open(page);
  await agent(
    page,
    `f.send("${H}", crypto.randomUUID(), "go"); f.startTurn("${H}");
     f.tool("${H}", "Read", { file_path: "${PROJECT}/src/a.ts" }, "x", { kind: "read" });
     f.tool("${H}", "Bash", { command: "npm test" }, "ok", { kind: "command" });
     f.emit("${H}", { type: "text", block: "t", parent: null, text: "Done, see [the docs](https://example.com).", done: true });
     f.endTurn("${H}");`,
  );
  await page.getByTestId("composer-input").focus();
  await page.keyboard.press("Shift+Tab");
  expect(await focused(page)).toBe("thread");
  expect(await visiblyFocused(page)).toBe(true);
  // Each message's Copy is on the walk, before what the message holds,
  // and Go back to here after a message of the user's own at rest.
  await page.keyboard.press("ArrowDown");
  expect(await focused(page)).toBe("copy-message");
  await page.keyboard.press("ArrowDown");
  expect(await focused(page)).toBe("go-back-here");
  await page.keyboard.press("ArrowDown");
  expect(await focused(page)).toBe("copy-reply");
  await page.keyboard.press("ArrowDown");
  expect(await focused(page)).toBe("work-line");
  expect(await visiblyFocused(page)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("step")).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  expect(await focused(page)).toBe("step-row");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("step-detail")).toHaveCount(1);
  // Escape from an item gives the keyboard back to the composer.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  expect(await focused(page)).toBe("a");
  // Tab leaves the thread for the composer: the thread is one stop.
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("composer-input")).toBeFocused();
});

test("reaches each Copy on the thread's walk, shows it there and copies with Enter or Space", async ({ page }) => {
  await open(page);
  await agent(
    page,
    `f.send("${H}", crypto.randomUUID(), "go"); f.startTurn("${H}");
     f.emit("${H}", { type: "text", block: "a", parent: null, text: "Run this:\\n\\n\`\`\`sh\\nnpm test\\n\`\`\`", done: true });
     f.tool("${H}", "Bash", { command: "npm test" }, "12 passed", { kind: "command" });
     f.endTurn("${H}");`,
  );
  const input = page.getByTestId("composer-input");
  await input.focus();
  await page.keyboard.press("Shift+Tab");
  expect(await focused(page)).toBe("thread");
  const walk = async (to: string) => {
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe(to);
  };
  await walk("copy-message");
  await expect(page.getByTestId("copy-message")).toHaveCSS("opacity", "1");
  await walk("go-back-here");
  await expect(page.getByTestId("go-back-here")).toHaveCSS("opacity", "1");
  await walk("copy-reply");
  await expect(page.getByTestId("copy-message")).toHaveCSS("opacity", "0");
  await walk("copy-code");
  expect(await visiblyFocused(page)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("copy-code")).toHaveAttribute("data-copied", "true");
  // The keyboard stays on the Copy, which stays in sight while it says so.
  expect(await focused(page)).toBe("copy-code");
  await walk("work-line");
  await page.keyboard.press("Enter");
  await walk("step-row");
  await page.keyboard.press("Enter");
  await walk("copy-command");
  await page.keyboard.press(" ");
  await walk("copy-output");
  await page.keyboard.press("Enter");
  const copied = await page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? []);
  expect(copied).toEqual(["npm test", "npm test", "12 passed"]);
  // Tab leaves the thread from a Copy as from any of its items.
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
});

test("reaches the dock's folds and choices by Tab, and opens the whole request", async ({ page }) => {
  await open(page);
  await agent(page, `f.startTurn("${H}"); f.ask("${H}", "DeleteRepository", { command: "ls" });`);
  await page.getByTestId("composer-input").focus();
  await page.keyboard.press("Shift+Tab");
  expect(await focused(page)).toBe("choice-allow");
  await page.keyboard.press("ArrowRight");
  expect(await focused(page)).toBe("choice-deny");
  await page.keyboard.press("Shift+Tab");
  expect(await focused(page)).toBe("permission-whole");
  expect(await visiblyFocused(page)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("permission-whole-text")).toBeVisible();
});

test("reaches the trust card's buttons by Tab, and trusts the folder", async ({ page }) => {
  await open(page, { untrusted: true });
  await expect(page.locator("[data-testid='trust-gate'] .card")).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("trust-folder");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("trust-not-now");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("trust-gate")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeVisible();
});

test("reaches the sign-in card's button by Tab, and Resume once a session ends", async ({ page }) => {
  await open(page);
  await agent(page, `f.emit("${H}", { type: "error", kind: "notLoggedIn", message: "Not logged in" }); f.end("${H}", false);`);
  await expect(page.locator("[data-testid='login-gate'] .card")).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("login-retry");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("login-gate")).toHaveCount(0);
  await agent(page, `f.end("int-2", true);`);
  await expect(page.getByTestId("resume-session")).toBeFocused();
});

test("completes a slash command with Tab, and Tab moves on once the menu is away", async ({ page }) => {
  await open(page);
  const input = page.getByTestId("composer-input");
  await expect(input).toBeFocused();
  await page.keyboard.type("/ru");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("/run ");
  await expect(input).toBeFocused();
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("attach");
});
