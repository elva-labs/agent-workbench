import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// A new session starts on the model, the effort and the mode the user last
// chose for its agent, through a restart too.

const MOD = "ControlOrMeta";

type Call = { method: string; options?: { model?: string; mode?: string; effort?: string } };

function starts(page: Page): Promise<Call[]> {
  return page.evaluate(() =>
    (window as unknown as { __integrated: { calls: Call[] } }).__integrated.calls.filter(
      (call) => call.method === "start",
    ),
  );
}

/** The chip of the conversation on screen; one put away stays drawn,
    hidden. */
function chip(page: Page, which: "model" | "mode") {
  return page.locator(`[data-testid='${which}-chip']:visible`);
}

async function pick(page: Page, which: "model" | "mode", name: string) {
  await chip(page, which).click();
  await page.getByTestId(`${which}-option`).filter({ hasText: name }).first().click();
  await expect(page.getByTestId(`${which}-menu`)).toHaveCount(0);
}

test("a new conversation starts on the model and mode last chosen, after a restart too", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(chip(page, "model")).toHaveText("Default · Sonnet");
  await expect(chip(page, "mode")).toHaveText("Default");
  await pick(page, "model", "Haiku");
  await pick(page, "mode", "Accept edits");
  await expect(chip(page, "model")).toHaveText("Haiku");

  // The next shows them before its agent has said anything, and is
  // started on them.
  await page.evaluate(() => {
    (window as unknown as { __integrated: { holdReady: boolean } }).__integrated.holdReady = true;
  });
  await page.getByTestId("project-new-session").click();
  await expect(chip(page, "model")).toHaveText("Haiku");
  await expect(chip(page, "mode")).toHaveText("Accept edits");
  expect((await starts(page)).at(-1)!.options).toMatchObject({ model: "haiku", mode: "acceptEdits" });

  // After a restart the third does too.
  await page.reload();
  await page.getByTestId("project-new-session").click();
  await expect(chip(page, "model")).toHaveText("Haiku");
  await expect(chip(page, "mode")).toHaveText("Accept edits");
  expect((await starts(page)).at(-1)!.options).toMatchObject({ model: "haiku", mode: "acceptEdits" });

  // Plan is not carried over; the agent's default model is.
  await pick(page, "mode", "Plan");
  await pick(page, "model", "Default");
  await expect(chip(page, "mode")).toHaveText("Plan");
  await page.getByTestId("project-new-session").click();
  await expect(chip(page, "model")).toHaveText("Default · Sonnet");
  await expect(chip(page, "mode")).toHaveText("Accept edits");
  const last = (await starts(page)).at(-1)!.options!;
  expect(last.model).toBeUndefined();
  expect(last.mode).toBe("acceptEdits");
});

test("a model the account does not offer falls back to the default, and the chip says what is in force", async ({ page }) => {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: { integrated: ["claude-code"], lastChosen: { "claude-code": { model: "opus", mode: "acceptEdits" } } },
  });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  expect((await starts(page)).at(-1)!.options).toMatchObject({ model: "opus", mode: "acceptEdits" });
  await expect(chip(page, "model")).toHaveText("Default");
  await expect(page.getByTestId("thread")).toContainText("Opus is not offered here, so the session runs on Default.");
  await expect(chip(page, "mode")).toHaveText("Accept edits");
});

test("a terminal session is launched on the model and mode last chosen", async ({ page }) => {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: { lastChosen: { "claude-code": { model: "sonnet", effort: "high", mode: "acceptEdits" } } },
  });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __spawns?: Record<string, unknown>[] }).__spawns?.at(-1) ?? null),
    )
    .toMatchObject({ agent: "claude-code", model: "sonnet", mode: "acceptEdits" });
});

test("the settings say what new sessions start on, and go back to the agent's own", async ({ page }) => {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: { lastChosen: { "claude-code": { model: "opus", effort: "high", mode: "acceptEdits" } } },
  });
  await page.goto("/");
  await expect(page.getByTestId("start-agent")).toBeVisible();
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-sessions").click();
  const row = page.locator("[data-testid='chosen'][data-agent='claude-code']");
  await expect(row.getByTestId("chosen-line")).toHaveText("Opus · High in conversations · Accept edits");
  await row.getByTestId("chosen-forget").click();
  await expect(row.getByTestId("chosen-line")).toHaveText("Its own defaults");
  await expect(row.getByTestId("chosen-forget")).toHaveCount(0);
  const stored = await page.evaluate(() => {
    const writes = (window as unknown as { __settingsWrites?: { lastChosen?: unknown }[] }).__settingsWrites ?? [];
    return writes.at(-1)?.lastChosen;
  });
  expect(stored).toEqual({});
});
