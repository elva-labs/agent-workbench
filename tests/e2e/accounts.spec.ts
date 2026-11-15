import { expect, test, type Page } from "@playwright/test";
import { NO_WORKFLOW, PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

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

    // With one agent on the machine the project's + still opens the choice,
    // since there is an account to choose. It starts on the project's
    // account, and the agent's directory reaches the spawn.
    await page.getByTestId("project-new-session").click();
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
    // The foot says the same, beside the settings.
    await expect(page.getByTestId("pane-account")).toHaveText("Work");

    // Switched in the account control, for this one session only.
    await page.getByTestId("project-new-session").click();
    await page
      .locator('[data-testid="account-option"][data-account=""]')
      .click();
    await page.getByTestId("agent-option").click();
    await expect.poll(() => spawns(page)).toHaveLength(2);
    expect((await spawns(page))[1].configDir).toBeUndefined();
    await expect(page.getByTestId("account-readout")).toHaveText("account: Default");
    await expect(page.getByTestId("pane-account")).toHaveText("Default");
    await page.getByTestId("project-new-session").click();
    await expect(
      page.locator('[data-testid="account-option"][data-account="Work"]'),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("walks the accounts with the arrows", async ({ page }) => {
    await page.getByTestId("project-new-session").click();
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
    // No workflows, so the account is the last question.
    await installFakeCore(page, { open: [PROJECT], settings: { accounts: WORK, ...NO_WORKFLOW } });
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
    await expect(page.getByTestId("palette-group")).toHaveCount(0);
    await expect(page.getByTestId("palette-row")).toHaveText([/Default/, /Work/]);
    await expect(chosen(page)).toContainText("Work");
    await expect(chosen(page)).toContainText("this project's");

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette")).toHaveCount(0);
    await expect.poll(() => spawns(page)).toHaveLength(1);
    expect((await spawns(page))[0].configDir).toBe("~/.claude-work");
    await expect(page.getByTestId("account-readout")).toHaveText("account: Work");
  });

  test("steps back to the commands, as the one project is not asked", async ({ page }) => {
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "commands");
  });

  test("starts under another account when the cursor is moved", async ({ page }) => {
    await page.keyboard.press("ArrowUp");
    await expect(chosen(page)).toContainText("Default");
    await page.keyboard.press("Enter");
    await expect.poll(() => spawns(page)).toHaveLength(1);
    expect((await spawns(page))[0].configDir).toBeUndefined();
    await expect(page.getByTestId("account-readout")).toHaveText("account: Default");
  });
});

/** A call on the start tool, as the core delivers one. */
async function startCall(
  page: Page,
  id: string,
  args: Record<string, unknown>,
  session: string | null,
) {
  await page.evaluate(
    ({ id, args, session, project }) =>
      (
        window as unknown as { __conductRequest: (call: unknown) => void }
      ).__conductRequest({
        id,
        tool: "start",
        arguments: args,
        cwd: project,
        session,
      }),
    { id, args, session, project: PROJECT },
  );
}

/** What a call was answered with, once it has been. */
const answerTo = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      (
        window as unknown as {
          __conductAnswers?: { id: string; content: string | null; error: string | null }[];
        }
      ).__conductAnswers?.find((answer) => answer.id === id) ?? null,
    id,
  );

test.describe("a session started by a session under another account", () => {
  test("runs under the starting session's account, not the project's", async ({ page }) => {
    // The project runs under the agents' own, and there is an account to
    // start a session under instead.
    await installFakeCore(page, {
      open: [PROJECT],
      settings: { accounts: { ...WORK, overrides: {} } },
    });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await expect(page.getByTestId("project-account")).toHaveCount(0);

    // The user's own session, started under Work from the palette.
    await page.keyboard.press(`${MOD}+Shift+P`);
    await page.keyboard.type("new session in");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await expect(
      page.locator("[data-testid='palette-row'][aria-selected='true']"),
    ).toContainText("Work");
    await page.keyboard.press("Enter");
    await expect.poll(() => spawns(page)).toHaveLength(1);
    expect((await spawns(page))[0].configDir).toBe("~/.claude-work");
    await expect(page.getByTestId("account-readout")).toHaveText("account: Work");

    // That session starts another and names no account.
    await startCall(page, "c-1", { project: PROJECT, prompt: "Fix the flaky test" }, "session-1");
    // The question says the account, since it is not the project's own.
    const ask = page.getByTestId("conduct-ask");
    await expect(ask).toBeVisible();
    await expect(ask.getByTestId("conduct-account")).toHaveText(
      "Under the Work account, not the project's own.",
    );
    await page.getByTestId("conduct-allow").click();
    await expect(ask).toHaveCount(0);

    // The new session's agent is pointed at the same account's directory,
    // and the caller is told the account too.
    await expect.poll(() => spawns(page)).toHaveLength(2);
    expect((await spawns(page))[1].prompt).toContain("Fix the flaky test");
    expect((await spawns(page))[1].configDir).toBe("~/.claude-work");
    await expect
      .poll(async () => (await answerTo(page, "c-1"))?.content ?? null)
      .toContain(`in ${PROJECT}, under the Work account.`);

    // Its row, under the session that started it, says the account too.
    await expect(page.getByTestId("started-account")).toHaveText("as Work");
  });

  test("refuses a call that names no session, asking the user nothing", async ({
    page,
  }) => {
    await installFakeCore(page, { open: [PROJECT], settings: { accounts: WORK } });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();

    // A call that names no session is from no session the workbench runs.
    await startCall(page, "c-1", { project: PROJECT, prompt: "Fix the flaky test" }, null);
    await expect
      .poll(async () => (await answerTo(page, "c-1"))?.error ?? null)
      .toContain("This call names no session");
    await expect(page.getByTestId("conduct-ask")).toHaveCount(0);
    expect(await spawns(page)).toHaveLength(0);
  });
});

test.describe("a started session's row", () => {
  test.beforeEach(async ({ page }) => {
    // Rows that fade in are measured where they end up.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installFakeCore(page, {
      open: [PROJECT],
      settings: { accounts: { ...WORK, overrides: {} } },
    });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    // An orchestrator, under the account its project follows: session-1.
    await page.getByTestId("sessions-menu").click();
    await page.getByTestId("menu-orchestrator").click();
    await page.getByTestId("agent-option").click();
    await expect(page.locator(AGENT)).toContainText("running");
  });

  test("names its account after its name when it is not the project's", async ({ page }) => {
    const start = async (id: string, name: string, account?: string) => {
      await startCall(
        page,
        id,
        { project: PROJECT, prompt: "Go", name, agent: "claude-code", model: "sonnet", ...(account ? { account } : {}) },
        "session-1",
      );
      const allow = page.getByTestId("conduct-allow");
      await expect(allow).toBeVisible();
      await allow.click();
      await expect.poll(() => answerTo(page, id)).not.toBeNull();
    };
    await start("o-1", "Bump the client", "Work");
    await start("o-2", "Check the palette");

    const work = page.getByTestId("started-session").filter({ hasText: "Bump the client" });
    const own = page.getByTestId("started-session").filter({ hasText: "Check the palette" });
    await expect(work.getByTestId("started-account")).toHaveText("as Work");
    await expect(work.getByTestId("started-account")).toBeVisible();
    // The project's own account goes unsaid.
    await expect(own).toBeVisible();
    await expect(own.getByTestId("started-account")).toHaveCount(0);

    // On the row's one line, after the name and before the model, in the
    // quiet ink the model has.
    const name = (await work.locator(".label").boundingBox())!;
    const tag = (await work.getByTestId("started-account").boundingBox())!;
    const model = (await work.getByTestId("started-model").boundingBox())!;
    expect(tag.x).toBeGreaterThanOrEqual(name.x + name.width - 1);
    expect(model.x).toBeGreaterThanOrEqual(tag.x + tag.width - 1);
    expect(Math.abs(tag.y + tag.height / 2 - (name.y + name.height / 2))).toBeLessThan(3);
    const ink = (testid: string) =>
      work.getByTestId(testid).evaluate((el) => getComputedStyle(el).color);
    expect(await ink("started-account")).toBe(await ink("started-model"));
  });
});
