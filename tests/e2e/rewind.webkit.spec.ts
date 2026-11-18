import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// Going back to an earlier message and Up on a waiting one, by the keys,
// in WebKit, the app's own webview on macOS; and a conversation held where
// it went back, reopened in a terminal.

const H = "int-1";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

function calls(page: Page): Promise<{ method: string; [field: string]: unknown }[]> {
  return page.evaluate(
    () => (window as unknown as { __integrated: { calls: { method: string }[] } }).__integrated.calls,
  );
}

function spawns(page: Page): Promise<{ session?: string; bringBack?: boolean }[]> {
  return page.evaluate(() => (window as unknown as { __spawns?: never[] }).__spawns ?? []);
}

async function open(page: Page) {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.locator(`[data-row="project:${PROJECT}"]`).getByTestId("project-new-session").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

async function talk(page: Page, lines: string[]) {
  const field = page.getByTestId("composer-input");
  for (const said of lines) {
    await field.fill(said);
    await field.press("Enter");
    await agent(page, `f.turn("${H}", "Done.");`);
  }
  await expect(page.getByTestId("agent-run")).toHaveCount(lines.length);
}

test("Esc Esc, the arrows, Enter and a digit go back, all from the composer", async ({ page }) => {
  await open(page);
  await talk(page, ["First.", "Second.", "Third."]);
  const field = page.getByTestId("composer-input");
  await field.focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("back-menu-row")).toHaveCount(3);
  await page.keyboard.press("Home");
  await expect(page.getByTestId("back-menu-row").nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("back-choices")).toBeVisible();
  await expect(field).toBeFocused();
  await page.keyboard.press("1");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await expect(field).toHaveValue("Second.");
  await expect(field).toBeFocused();
  // Esc Esc is a pair only within a moment: two far apart open nothing.
  await field.fill("");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer-esc")).toBeVisible();
  await expect(page.getByTestId("composer-esc")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("back-menu")).toHaveCount(0);
});

test("Up takes the newest waiting message back, and Up again the one before", async ({ page }) => {
  await open(page);
  await talk(page, ["First."]);
  const field = page.getByTestId("composer-input");
  await field.fill("Go on.");
  await page.keyboard.press("Enter");
  await agent(page, `f.startTurn("${H}");`);
  await field.fill("One more thing.");
  await page.keyboard.press("Enter");
  await field.fill("And another.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("message-waiting")).toHaveCount(2);
  await page.keyboard.press("ArrowUp");
  await expect(field).toHaveValue("And another.");
  await page.keyboard.press("ArrowUp");
  await expect(field).toHaveValue("One more thing.\nAnd another.");
  // With an ask open, Up goes to the dock as before.
  await field.fill("");
  await agent(page, `f.ask("${H}", "Bash", { command: "npm test" });`);
  await page.keyboard.press("ArrowUp");
  await expect(field).not.toBeFocused();
});

test("a conversation held where it went back offers a message first before a terminal brings it back", async ({ page }) => {
  await open(page);
  await talk(page, ["First.", "Second."]);
  const field = page.getByTestId("composer-input");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("rewound")).toBeVisible();
  const row = page.getByTestId("session-row").first();
  await row.click({ button: "right" });
  await page.getByTestId("session-menu-reopen").click();
  const strip = page.getByTestId("reopen-session");
  await expect(strip).toContainText("in a terminal?");
  await expect(strip).toContainText("brings back what was gone back on");
  await strip.getByRole("button", { name: "Write a message first" }).click();
  await expect(strip).toHaveCount(0);
  await expect(field).toBeFocused();
  expect(await spawns(page)).toEqual([]);
  await row.click({ button: "right" });
  await page.getByTestId("session-menu-reopen").click();
  await strip.getByRole("button", { name: "Stop and reopen" }).click();
  await expect.poll(async () => (await spawns(page)).map((spawned) => spawned.bringBack)).toEqual([true]);
  expect((await calls(page)).filter((call) => call.method === "held").length).toBeGreaterThan(0);
});
