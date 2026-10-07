import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

const MOD = "ControlOrMeta";
const AGENT = "section[data-pane='agent']";

const file = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    SETTINGS_FILE,
  );

const spawns = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __spawns?: Record<string, unknown>[] }).__spawns ??
      [],
  );

const WORK = {
  list: { Work: { claude: "~/.claude-work", codex: null } },
  everywhere: null,
  overrides: { [PROJECT]: "Work" },
};

test.describe("the accounts tab", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeCore(page, { open: [PROJECT] });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await page.keyboard.press(`${MOD}+,`);
    await page.getByTestId("settings-tab-accounts").click();
  });

  test("names an account, suggests its directories from the name, and keeps it", async ({
    page,
  }) => {
    // The agents' own directories are the one account every setup has.
    await expect(page.getByTestId("account-row")).toHaveCount(1);
    await expect(page.getByTestId("account-row")).toContainText("Default");

    await page.getByTestId("account-add-open").click();
    await page.getByTestId("account-name").fill("Elva Labs");
    await expect(page.getByTestId("account-claude")).toHaveText("~/.claude-elva-labs");
    await expect(page.getByTestId("account-codex")).toHaveText("~/.codex-elva-labs");

    // The pencil opens one directory for editing; the other keeps
    // following the name.
    await page.getByTestId("account-codex-edit").click();
    await page.getByTestId("account-codex-dir").fill("~/.codex-elva");
    await page.getByTestId("account-name").fill("Elva");
    await expect(page.getByTestId("account-claude")).toHaveText("~/.claude-elva");
    await expect(page.getByTestId("account-codex-dir")).toHaveValue("~/.codex-elva");

    await page.getByTestId("account-add").click();
    await expect(page.getByTestId("account-form")).toHaveCount(0);
    const row = page.locator('[data-testid="account-row"][data-account="Elva"]');
    await expect(row).toContainText("~/.claude-elva");
    await expect(row).toContainText("~/.codex-elva");
    await expect
      .poll(async () => (await file(page)).accounts)
      .toEqual({
        list: { Elva: { claude: "~/.claude-elva", codex: "~/.codex-elva" } },
        everywhere: null,
        overrides: {},
      });

    // The account for every project, and the project's row says so.
    await page
      .locator('[data-testid="account-everywhere-option"][data-account="Elva"]')
      .click();
    await expect.poll(async () => (await file(page)).accounts.everywhere).toBe("Elva");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-account")).toHaveText("Elva");

    // Removing it sends every project back to the agents' own.
    await page.keyboard.press(`${MOD}+,`);
    await page.getByTestId("account-remove").click();
    await expect(page.getByTestId("account-row")).toHaveCount(1);
    await expect.poll(async () => (await file(page)).accounts.everywhere).toBeNull();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-account")).toHaveCount(0);
  });

  test("refuses a name that will not do, and says why", async ({ page }) => {
    await page.getByTestId("account-add-open").click();
    await expect(page.getByTestId("account-add")).toBeDisabled();
    await page.getByTestId("account-name").fill("default");
    await page.getByTestId("account-add").click();
    await expect(page.getByTestId("account-problem")).toContainText("already");
    await expect(page.getByTestId("account-form")).toBeVisible();
    await page.getByTestId("account-cancel").click();
    await expect(page.getByTestId("account-form")).toHaveCount(0);
    expect((await file(page))?.accounts?.list ?? {}).toEqual({});
  });

  test("gives a project an account of its own", async ({ page }) => {
    await page.getByTestId("account-add-open").click();
    await page.getByTestId("account-name").fill("Work");
    await page.getByTestId("account-add").click();
    await page.getByTestId("account-overrides").click();
    const row = page.locator(
      `[data-testid="account-project-row"][data-project="${PROJECT}"]`,
    );
    await row
      .locator('[data-testid="account-project-option"][data-account="Work"]')
      .click();
    await expect
      .poll(async () => (await file(page)).accounts.overrides)
      .toEqual({ [PROJECT]: "Work" });
    await expect(page.getByTestId("account-overrides")).toContainText("(1)");
    await row.getByTestId("account-project-default").click();
    await expect.poll(async () => (await file(page)).accounts.overrides).toEqual({});
  });
});

test.describe("starting a session under an account", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeCore(page, {
      open: [PROJECT],
      settings: { accounts: WORK },
    });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
  });

  test("marks the project, starts under its account, and lets one session go another way", async ({
    page,
  }) => {
    await expect(page.getByTestId("project-account")).toHaveText("Work");

    // With one agent on the machine the row still opens into the choice,
    // since there is an account to choose. It starts on the project's
    // account, and the agent's directory reaches the spawn.
    await page.getByTestId("new-session").click();
    const choice = page.getByTestId("account-choice");
    await expect(choice).toBeVisible();
    await expect(page.getByTestId("agent-option")).toHaveCount(1);
    await expect(
      choice.locator('[data-testid="account-option"][data-account="Work"]'),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("agent-option").click();
    await expect.poll(() => spawns(page)).toHaveLength(1);
    expect((await spawns(page))[0].agent).toBe("claude-code");
    expect((await spawns(page))[0].configDir).toBe("~/.claude-work");

    // Switched in the footer, for this one session only.
    await page.getByTestId("new-session").click();
    await page
      .locator('[data-testid="account-option"][data-account=""]')
      .click();
    await page.getByTestId("agent-option").click();
    await expect.poll(() => spawns(page)).toHaveLength(2);
    expect((await spawns(page))[1].configDir).toBeUndefined();
    await page.getByTestId("new-session").click();
    await expect(
      page.locator('[data-testid="account-option"][data-account="Work"]'),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("walks the accounts with the arrows", async ({ page }) => {
    await page.getByTestId("new-session").click();
    await page.getByTestId("sessions-nav").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(
      page.locator('[data-testid="account-option"][data-account=""]'),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowRight");
    await expect(
      page.locator('[data-testid="account-option"][data-account="Work"]'),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Enter");
    await expect.poll(() => spawns(page)).toHaveLength(1);
    expect((await spawns(page))[0].configDir).toBe("~/.claude-work");
  });
});
