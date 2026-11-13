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
    await expect(page.getByTestId("account-readout")).toHaveText("account: Work");

    // Switched in the account control, for this one session only.
    await page.getByTestId("new-session").click();
    await page
      .locator('[data-testid="account-option"][data-account=""]')
      .click();
    await page.getByTestId("agent-option").click();
    await expect.poll(() => spawns(page)).toHaveLength(2);
    expect((await spawns(page))[1].configDir).toBeUndefined();
    await expect(page.getByTestId("account-readout")).toHaveText("account: Default");
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

test.describe("a past session under another account", () => {
  test("is listed under its project, and resumes under that account", async ({
    page,
  }) => {
    // The project runs on the agents' own directory; the session ran
    // under Work, so Work's directory is where its transcript is.
    await installFakeCore(page, {
      open: [PROJECT],
      settings: { accounts: { ...WORK, overrides: {} } },
      transcripts: [
        {
          id: "work-1",
          modified: Math.floor(Date.now() / 1000) - 60,
          size: 100,
          title: "under work",
          configDir: "~/.claude-work",
        },
      ],
    });
    await page.addInitScript(
      ({ project }) => {
        localStorage.setItem("workbench.mine", JSON.stringify({ [project]: ["work-1"] }));
      },
      { project: PROJECT },
    );
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();

    const past = page.getByTestId("past-session");
    await expect(past).toHaveCount(1);
    await expect(past).toContainText("under work");
    await expect(past.getByTestId("past-account")).toHaveText("Work");

    await past.click();
    await expect.poll(() => spawns(page)).toHaveLength(1);
    expect((await spawns(page))[0].session).toBe("work-1");
    expect((await spawns(page))[0].configDir).toBe("~/.claude-work");
    await expect(page.getByTestId("account-readout")).toHaveText("account: Work");
  });
});

test.describe("a new session from the palette with accounts", () => {
  const COMMANDS = `${MOD}+Shift+P`;
  const chosen = (page: Page) =>
    page.locator("[data-testid='palette-row'][aria-selected='true']");

  test.beforeEach(async ({ page }) => {
    await installFakeCore(page, { open: [PROJECT], settings: { accounts: WORK } });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await page.keyboard.press(COMMANDS);
    await page.keyboard.type("new session in");
    await page.keyboard.press("Enter");
  });

  test("asks for the account after the project, with the project's own under the cursor", async ({
    page,
  }) => {
    await expect(page.getByTestId("palette-chip")).toHaveText(["New session", "demo"]);
    await expect(page.getByTestId("palette-field")).toHaveAttribute(
      "placeholder",
      "Under which account",
    );
    await expect(page.getByTestId("palette-group").first()).toHaveText("Under which account");
    await expect(page.getByTestId("palette-row")).toHaveText([/Default/, /Work/]);
    await expect(chosen(page)).toContainText("Work");
    await expect(chosen(page)).toContainText("this project's");

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette")).toHaveCount(0);
    await expect.poll(() => spawns(page)).toHaveLength(1);
    expect((await spawns(page))[0].configDir).toBe("~/.claude-work");
    await expect(page.getByTestId("account-readout")).toHaveText("account: Work");
  });

  test("starts under another account when the cursor is moved, and steps back to the project", async ({
    page,
  }) => {
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("palette-chip")).toHaveText(["New session"]);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-chip")).toHaveText(["New session", "demo"]);

    await page.keyboard.press("ArrowUp");
    await expect(chosen(page)).toContainText("Default");
    await page.keyboard.press("Enter");
    await expect.poll(() => spawns(page)).toHaveLength(1);
    expect((await spawns(page))[0].configDir).toBeUndefined();
    await expect(page.getByTestId("account-readout")).toHaveText("account: Default");
  });
});
