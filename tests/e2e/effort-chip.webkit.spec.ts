import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// The composer's effort chip, beside the model and the mode, and what a
// slash command changes reaching the window: the row's name, the chips and
// the status bar.

const H = "int-1";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

type Call = { method: string; settings?: Record<string, string>; options?: Record<string, string> };

function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window as unknown as { __integrated: { calls: Call[] } }).__integrated.calls);
}

async function open(page: Page, codex = false) {
  await installFakeCore(page, {
    open: [PROJECT],
    ...(codex ? { agents: ["codex"], integrable: ["codex"] } : {}),
    settings: { integrated: [codex ? "codex" : "claude-code"] },
  });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

/** The chip of the conversation on screen; one put away stays drawn,
    hidden. */
const chip = (page: Page, which: "model" | "effort" | "mode") => page.locator(`[data-testid='${which}-chip']:visible`);
const option = (page: Page, name: string) =>
  page.getByTestId("effort-option").filter({ has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });

for (const codex of [false, true])
  test(`sits between the model and the mode, lists the model's efforts and switches the session${codex ? ": Codex" : ""}`, async ({
    page,
  }) => {
    await open(page, codex);
    await agent(page, `f.configure("${H}", { effort: "high" });`);
    const effort = chip(page, "effort");
    await expect(effort).toHaveText("High effort");
    await expect(effort).toHaveAccessibleName("Effort: High");
    const [model, own, mode] = await Promise.all(["model", "effort", "mode"].map((which) => chip(page, which as "model").boundingBox()));
    expect(model!.x + model!.width).toBeLessThanOrEqual(own!.x);
    expect(own!.x + own!.width).toBeLessThanOrEqual(mode!.x);
    expect(Math.abs(own!.y - model!.y)).toBeLessThan(2);

    await effort.click();
    await expect(page.getByTestId("effort-option").locator(".name")).toHaveText(["Low", "Medium", "High"]);
    await expect(option(page, "High")).toHaveAttribute("aria-checked", "true");
    await option(page, "Low").click();
    await expect(page.getByTestId("effort-menu")).toHaveCount(0);
    await expect(effort).toHaveText("Low effort");
    await expect(page.getByTestId("effort-readout")).toHaveText("low");
    await expect(page.getByTestId("composer-input")).toBeFocused();
    expect((await calls(page)).filter((call) => call.method === "configure").at(-1)).toMatchObject({
      settings: { effort: "low" },
    });

    // Picked from the status bar, the chip follows.
    await page.getByTestId("effort-readout").click();
    await page.getByTestId("status-effort-option").filter({ hasText: "Medium" }).click();
    await expect(effort).toHaveText("Medium effort");
  });

test("goes for a model that takes no effort, and comes back with one that does", async ({ page }) => {
  await open(page);
  await agent(page, `f.configure("${H}", { effort: "high" });`);
  await expect(chip(page, "effort")).toHaveText("High effort");
  await agent(page, `f.configure("${H}", { model: "haiku" });`);
  await expect(chip(page, "model")).toHaveText("Haiku");
  await expect(chip(page, "effort")).toHaveCount(0);
  await expect(page.getByTestId("effort-readout")).toHaveCount(0);
  await agent(page, `f.configure("${H}", { model: "sonnet" });`);
  await expect(chip(page, "effort")).toHaveText("High effort");
});

test("an effort picked is what the next new session starts on", async ({ page }) => {
  await open(page);
  await agent(page, `f.configure("${H}", { effort: "high" });`);
  await chip(page, "effort").click();
  await option(page, "Low").click();
  await expect(chip(page, "effort")).toHaveText("Low effort");
  await agent(page, `f.holdReady = true;`);
  await page.getByTestId("project-new-session").click();
  // Shown from the first frame, before the agent has said what it takes.
  await expect(chip(page, "effort")).toHaveText("Low effort");
  expect((await calls(page)).filter((call) => call.method === "start").at(-1)!.options).toMatchObject({ effort: "low" });
});

test("leaves the row its plain name after a command, and follows what the command changed", async ({ page }) => {
  await open(page);
  const row = page.getByTestId("session-row");
  await page.keyboard.type("/effort high");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-message")).toContainText("/effort high");
  await expect(row).toContainText("session 1");
  // The agent reports the effort the command set.
  await agent(page, `f.emit("${H}", { type: "configured", model: "claude-sonnet-5-5", mode: "default", effort: "high", efforts: ["low", "medium", "high"] });`);
  await expect(chip(page, "effort")).toHaveText("High effort");
  await expect(page.getByTestId("effort-readout")).toHaveText("high");

  await page.keyboard.type("Fix the build");
  await page.keyboard.press("Enter");
  await expect(row).toContainText("Fix the build");

  // A rename the agent took names the row at once, whatever came first.
  await agent(page, `f.emit("${H}", { type: "titled", title: "Shared ARM64 metal host" });`);
  await expect(row).toContainText("Shared ARM64 metal host");
  await expect(row).not.toContainText("Fix the build");
});

test("in a narrow pane keeps the three chips whole, the effort by its level alone", async ({ page }) => {
  await open(page);
  await agent(page, `f.configure("${H}", { effort: "high" });`);
  await expect(chip(page, "effort")).toHaveText("High effort");
  await page.locator("section[data-pane='agent']").evaluate((pane) => {
    (pane as HTMLElement).style.width = "360px";
    (pane as HTMLElement).style.flex = "none";
  });
  await expect(page.locator(".conv.tight")).toHaveCount(1);
  await expect(chip(page, "effort")).toHaveText("High", { useInnerText: true });
  await expect(chip(page, "effort")).toHaveAccessibleName("Effort: High");
  const bar = (await page.locator(".composer .bar:visible").boundingBox())!;
  const boxes = await Promise.all(["model", "effort", "mode"].map((which) => chip(page, which as "model").boundingBox()));
  for (const [at, box] of boxes.entries()) {
    expect(box!.x).toBeGreaterThanOrEqual(bar.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
    const next = boxes[at + 1];
    if (next && Math.abs(next.y - box!.y) < 2) expect(box!.x + box!.width).toBeLessThanOrEqual(next.x);
  }
});
