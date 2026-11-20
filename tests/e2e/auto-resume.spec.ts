import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// A conversation the usage limit cut short goes on by itself when the
// limit resets: the chip that chooses it, what the row says while it
// waits, and the line in the conversation once it has gone on.

const H = "int-1";
const GO_ON = "The usage limit that stopped you has reset. Go on from where you stopped.";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; const now = Math.floor(Date.now() / 1000); ${script} })()`);
}

type Call = { method: string; id?: string; text?: string; options?: { session?: string } };

function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window as unknown as { __integrated: { calls: Call[] } }).__integrated.calls);
}

async function open(page: Page) {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

/** The chip of the conversation on screen; one put away stays drawn,
    hidden. */
const chip = (page: Page, which = "resume") => page.locator(`[data-testid='${which}-chip']:visible`);
const option = (page: Page, name: string) =>
  page.getByTestId("resume-option").filter({ has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });

/** The account's figures hold a session window, used as far as given. */
const windowed = (page: Page, handle = H, percent = 40) =>
  agent(page, `f.limits("${handle}", [{ kind: "session", percent: ${percent}, resetsAt: now + 3600 }, { kind: "weekly", percent: 12 }]);`);

/** A message of the user's whose turn the agent ends as refused by the
    session window's limit, which resets `resets` seconds from now. */
async function refused(page: Page, resets: number, handle = H) {
  await page.getByTestId("composer-input").fill("Build the thing");
  await page.keyboard.press("Enter");
  await agent(
    page,
    `f.startTurn("${handle}");
     f.emit("${handle}", { type: "limitReached", window: "session", resetsAt: now + (${resets}) });
     f.endTurn("${handle}", "failed", "You've hit your limit");`,
  );
}

test("is offered only where the account has a session window, off until chosen, and kept for the next session", async ({
  page,
}) => {
  await open(page);
  // No figures yet, and then a week alone: nothing to choose.
  await expect(chip(page)).toHaveCount(0);
  await agent(page, `f.limits("${H}", [{ kind: "weekly", percent: 12 }]);`);
  await expect(chip(page, "mode")).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
  await windowed(page);
  const resume = chip(page);
  await expect(resume).toHaveText("Auto-resume off");
  // Beside the mode, on its line.
  const [mode, own] = await Promise.all([chip(page, "mode").boundingBox(), resume.boundingBox()]);
  expect(mode!.x + mode!.width).toBeLessThanOrEqual(own!.x);
  expect(Math.abs(own!.y - mode!.y)).toBeLessThan(2);
  expect(Math.abs(own!.height - mode!.height)).toBeLessThan(1);

  await resume.click();
  await expect(page.getByTestId("resume-option").locator(".name")).toHaveText(["Off", "On"]);
  await expect(option(page, "Off")).toHaveAttribute("aria-checked", "true");
  await option(page, "On").click();
  await expect(page.getByTestId("resume-menu")).toHaveCount(0);
  await expect(resume).toHaveText("Auto-resume on");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  // Escape puts the menu away and the keyboard back on the chip.
  await resume.click();
  await expect(option(page, "On")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("resume-menu")).toHaveCount(0);
  await expect(resume).toBeFocused();

  // The next new session starts with it on.
  await page.getByTestId("project-new-session").click();
  await expect(page.locator("[data-testid='composer-input']:visible")).toBeFocused();
  await expect(chip(page)).toHaveText("Auto-resume on");
});

test("the row and the chip say when it resumes, until a turn begins or it is turned off", async ({ page }) => {
  await open(page);
  await windowed(page, H, 100);
  await chip(page).click();
  await option(page, "On").click();
  await refused(page, 3600);
  const when = page.getByTestId("session-resumes");
  await expect(when).toHaveText(/^resumes \d{1,2}[:.]\d{2}/);
  // Under the row's name, where its line is.
  const [name, line] = await Promise.all([
    page.getByTestId("session-row").locator(".label").first().boundingBox(),
    when.boundingBox(),
  ]);
  expect(line!.y).toBeGreaterThanOrEqual(name!.y + name!.height - 1);
  const words = (await when.textContent())!;
  await expect(chip(page)).toHaveText(`Resumes ${words.slice("resumes ".length)}`);
  await expect(page.getByTestId("session-row").locator(".state")).toContainText(words);
  // Nothing is asked of the usage, and nothing sent, before the reset.
  expect((await calls(page)).filter((call) => call.method === "send")).toHaveLength(1);
  // The user goes on themselves: the wait is over.
  await page.getByTestId("composer-input").fill("Try again");
  await page.keyboard.press("Enter");
  await agent(page, `f.startTurn("${H}");`);
  await expect(when).toHaveCount(0);
  await expect(chip(page)).toHaveText("Auto-resume on");
  // Refused again, it waits again; turned off, the wait is gone for good.
  await agent(
    page,
    `f.emit("${H}", { type: "limitReached", window: "session", resetsAt: now + 3600 });
     f.endTurn("${H}", "failed", "You've hit your limit");`,
  );
  await expect(when).toHaveText(words);
  await chip(page).click();
  await option(page, "Off").click();
  await expect(when).toHaveCount(0);
  await expect(chip(page)).toHaveText("Auto-resume off");
  await chip(page).click();
  await option(page, "On").click();
  await expect(chip(page)).toHaveText("Auto-resume on");
  await expect(when).toHaveCount(0);
});

test("goes on by itself from its notes once the usage reads open after the reset, and says so in the conversation", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const briefing =
    "From the workbench, not the user: this conversation goes on from an earlier one of yours, which was not read again, since reading all of it with its cache lapsed would cost far more. What you need to go on is below.\n\nBrief:\n> Build the thing.\nEnd of the workbench's briefing.";
  await open(page);
  await windowed(page, H, 100);
  await chip(page).click();
  await option(page, "On").click();
  // The core briefs the conversation when asked to, and reads the window
  // as open in figures taken now.
  await page.evaluate((briefing) => {
    const w = window as unknown as { __goingOn: unknown; __accountLimits: Record<string, unknown> };
    const now = Math.floor(Date.now() / 1000);
    w.__goingOn = { context: 30_000, idle: 120, goesOn: true, briefing };
    w.__accountLimits = {
      "claude-code ": {
        type: "limits",
        agent: "claude-code",
        plan: "max",
        readAt: now,
        takenAt: now,
        windows: [{ kind: "session", model: null, percent: 2, resetsAt: now + 5 * 3600, severity: "normal" }],
      },
    };
  }, briefing);
  // The limit reset two minutes ago, past the margin.
  await refused(page, -120);
  await expect
    .poll(async () => (await calls(page)).filter((call) => call.method === "start").length, { timeout: 40_000 })
    .toBe(2);
  const all = await calls(page);
  // A fresh conversation, never the old one read again.
  expect(all.filter((call) => call.method === "start").at(-1)!.options!.session).toBeUndefined();
  await expect
    .poll(async () => (await calls(page)).filter((call) => call.method === "send").at(-1)?.text)
    .toBe(`${briefing}\n\n${GO_ON}`);
  const asked = await page.evaluate(
    () => (window as unknown as { __limitsAsked: { read: boolean; since?: number }[] }).__limitsAsked,
  );
  expect(asked.some((one) => one.read && typeof one.since === "number")).toBe(true);
  // The quiet line where the run began, and nothing waiting on the row.
  await expect(page.locator("[data-testid='run-began']:visible")).toContainText(
    /^Went on by itself here after the usage limit reset,/,
  );
  await expect(page.getByTestId("session-resumes")).toHaveCount(0);
  await expect(chip(page)).toHaveText("Auto-resume on");
  // The briefing is not drawn in the thread; the line sent is.
  await expect(page.locator("[data-testid='thread']:visible")).toContainText(GO_ON);
  await expect(page.locator("[data-testid='thread']:visible")).not.toContainText("End of the workbench's briefing.");
});
