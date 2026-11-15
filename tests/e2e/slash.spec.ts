import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// The slash menu of an integrated session's composer, against the fake
// core's scripted session, whose agent lists Claude Code's kind of commands
// and skills. The handle of the first session the fake starts is int-1.

const H = "int-1";
const PANE = "section[data-pane='agent']";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

function calls(page: Page): Promise<{ method: string; [field: string]: unknown }[]> {
  return page.evaluate(
    () => (window as unknown as { __integrated: { calls: { method: string }[] } }).__integrated.calls,
  );
}

async function openIntegrated(page: Page, options: { holdReady?: boolean; agent?: "codex" } = {}) {
  const codex = options.agent === "codex";
  await installFakeCore(page, {
    open: [PROJECT],
    ...(codex ? { agents: ["codex"], integrable: ["codex"] } : {}),
    settings: { integrated: [codex ? "codex" : "claude-code"] },
  });
  if (options.holdReady)
    await page.addInitScript(
      () => ((window as unknown as { __integrated: { holdReady: boolean } }).__integrated.holdReady = true),
    );
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

const menu = (page: Page) => page.getByTestId("slash-menu");
const rows = (page: Page) => page.getByTestId("slash-menu-row");
const input = (page: Page) => page.getByTestId("composer-input");

/** The names in the menu, without their hints, each after the group it
    is under. */
async function listed(page: Page): Promise<string[]> {
  return menu(page)
    .locator("[role='group']")
    .evaluateAll((groups) =>
      groups.flatMap((group) => {
        const head = group.querySelector("p")?.textContent?.trim() ?? "";
        return [...group.querySelectorAll("[data-testid='slash-name']")].map((name) => {
          const bare = name.cloneNode(true) as HTMLElement;
          for (const part of bare.querySelectorAll(".cmd-hint, .sep")) part.remove();
          return `${head} ${bare.textContent?.trim()}`;
        });
      }),
    );
}

test.describe("the slash menu", () => {
  test("opens the agent's commands, then its skills, over the thread and as wide as the composer", async ({
    page,
  }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/");
    await expect(menu(page)).toBeVisible();
    expect(await listed(page)).toEqual([
      "Commands /compact",
      "Commands /context",
      "Commands /init",
      "Commands /review",
      "Commands /security-review",
      "Commands /release",
      "Skills /code-review",
      "Skills /run",
    ]);
    const first = rows(page).first();
    await expect(first).toContainText("/compact");
    await expect(first).toContainText("[instructions]");
    await expect(first).toContainText("Compact the conversation, keeping a summary");
    await expect(first).toContainText("built in");
    await expect(rows(page).filter({ hasText: "/release" })).toContainText("project");
    await expect(rows(page).filter({ hasText: "/code-review" })).toContainText("user");
    // The first row is the marked one, and the field names it.
    await expect(first).toHaveAttribute("aria-selected", "true");
    const listbox = menu(page).getByRole("listbox");
    await expect(input(page)).toHaveAttribute("aria-controls", (await listbox.getAttribute("id"))!);
    await expect(input(page)).toHaveAttribute("aria-activedescendant", (await first.getAttribute("id"))!);
    // Above the composer, over the thread, no wider than the composer.
    const box = (await menu(page).boundingBox())!;
    const composer = (await page.getByTestId("composer").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
    expect(box.x).toBeGreaterThanOrEqual(composer.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(composer.x + composer.width + 1);
  });

  test("narrows as letters are typed and marks the letters that match", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/re");
    await expect(rows(page)).toHaveCount(4);
    const names = rows(page).getByTestId("slash-name");
    await expect(names.nth(0)).toHaveText(/^\/review/);
    await expect(names.nth(1)).toHaveText(/^\/release/);
    await expect(names.nth(2)).toHaveText(/^\/security-review/);
    await expect(names.nth(3)).toHaveText(/^\/code-review/);
    await expect(names.nth(0).locator("b")).toHaveText("re");
    await expect(names.nth(2).locator("b")).toHaveText("re");
    await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
  });

  test("moves the mark with the arrows and completes with Tab, the hint waiting in grey", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/re");
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(input(page)).toHaveAttribute("aria-activedescendant", (await rows(page).nth(1).getAttribute("id"))!);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(rows(page).last()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    await expect(menu(page)).toHaveCount(0);
    await expect(input(page)).toHaveValue("/release ");
    await expect(input(page)).toBeFocused();
    await expect(page.getByTestId("slash-hint")).toHaveText("/release <version>");
    // The hint sits after what is written, on its line.
    const hint = (await page.getByTestId("slash-hint").boundingBox())!;
    const field = (await input(page).boundingBox())!;
    expect(Math.abs(hint.y - field.y)).toBeLessThan(2);
    await page.keyboard.type("1.2.0");
    await expect(page.getByTestId("slash-hint")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(input(page)).toHaveValue("");
    const sent = (await calls(page)).filter((call) => call.method === "send");
    expect(sent.map((call) => call.text)).toEqual(["/release 1.2.0"]);
  });

  test("takes Enter to complete a command typed in full, and a second to send it", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/context");
    await page.keyboard.press("Enter");
    await expect(input(page)).toHaveValue("/context ");
    expect((await calls(page)).filter((call) => call.method === "send")).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(input(page)).toHaveValue("");
    expect((await calls(page)).filter((call) => call.method === "send").map((call) => call.text)).toEqual([
      "/context ",
    ]);
  });

  test("completes a row that is clicked, keeping the keyboard in the field", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/");
    await rows(page).filter({ hasText: "/run" }).click();
    await expect(input(page)).toHaveValue("/run ");
    await expect(input(page)).toBeFocused();
    await expect(menu(page)).toHaveCount(0);
  });

  test("compacts through the agent's own compaction, with the words after it", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/compact");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("slash-hint")).toHaveText("/compact [instructions]");
    await page.keyboard.type("keep the API notes");
    await page.keyboard.press("Enter");
    await expect(input(page)).toHaveValue("");
    await expect.poll(async () => (await calls(page)).filter((call) => call.method === "compact")).toEqual([
      { method: "compact", id: H, instructions: "keep the API notes" },
    ]);
    expect((await calls(page)).filter((call) => call.method === "send")).toEqual([]);
    await expect(page.getByTestId("thread").getByTestId("compaction")).toContainText("Conversation compacted");
  });

  test("goes back to Send when the agent fails to compact", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/compact ");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await calls(page)).filter((call) => call.method === "compact").length).toBe(1);
    // As Claude Code answers a compaction of too little.
    await agent(
      page,
      `f.startTurn("${H}", []);
       f.emit("${H}", { type: "compacting" });
       f.emit("${H}", { type: "compactFailed", error: "Not enough messages to compact." });
       f.emit("${H}", { type: "text", block: "s", parent: null, text: "Error: Not enough messages to compact.", done: true });
       f.endTurn("${H}");`,
    );
    const divider = page.getByTestId("thread").getByTestId("compaction").last();
    await expect(divider).toHaveText("Not compacted: Not enough messages to compact.");
    await expect(page.getByTestId("stop")).toHaveCount(0);
    await expect(page.getByTestId("send")).toBeVisible();
    // A compaction its turn ends without a word on is over too.
    await agent(page, `f.startTurn("${H}", []); f.emit("${H}", { type: "compacting" }); f.endTurn("${H}");`);
    await expect(page.getByTestId("thread").getByTestId("compaction").last()).toHaveText("Not compacted");
    await expect(page.getByTestId("stop")).toHaveCount(0);
  });

  test("puts the words back when a compaction cannot be asked for", async ({ page }) => {
    await openIntegrated(page);
    await agent(page, `f.compactRefusal = "no such session";`);
    await input(page).click();
    await page.keyboard.type("/compact keep the API notes");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("compact-error")).toHaveText("Not compacted: no such session");
    await expect(input(page)).toHaveValue("/compact keep the API notes");
  });

  test("says a compaction waits while a turn runs", async ({ page }) => {
    await openIntegrated(page);
    await agent(page, `f.send("${H}", crypto.randomUUID(), "go"); f.startTurn("${H}");`);
    await input(page).click();
    await page.keyboard.type("/compact ");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("composer-compact")).toHaveText("Compacts once Claude is done with this turn.");
    await agent(page, `f.endTurn("${H}");`);
    await expect(page.getByTestId("composer-compact")).toHaveCount(0);
    await expect(page.getByTestId("thread").getByTestId("compaction")).toContainText("Conversation compacted");
  });

  test("closes on Escape without stopping the agent, and opens again as the word changes", async ({ page }) => {
    await openIntegrated(page);
    await agent(page, `f.send("${H}", crypto.randomUUID(), "go"); f.startTurn("${H}");`);
    await expect(page.getByTestId("stop")).toBeVisible();
    await input(page).click();
    await page.keyboard.type("/re");
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(input(page)).toHaveValue("/re");
    await expect(input(page)).toBeFocused();
    expect((await calls(page)).filter((call) => call.method === "interrupt")).toEqual([]);
    await expect(page.getByTestId("stop")).toBeVisible();
    await page.keyboard.type("v");
    await expect(menu(page)).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    // With the menu away, Escape is the composer's again: it stops the turn.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await calls(page)).filter((call) => call.method === "interrupt").length).toBe(1);
  });

  test("puts the menu away until the word changes, not until the same words come again", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/re");
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await expect(menu(page)).toBeVisible();
    await page.keyboard.type("e");
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.type(" now");
    await page.keyboard.press("Enter");
    await expect(input(page)).toHaveValue("");
    await page.keyboard.type("/re");
    await expect(menu(page)).toBeVisible();
  });

  test("tells a screen reader what each row is and how many there are", async ({ page }) => {
    await openIntegrated(page, { holdReady: true });
    await input(page).click();
    const said = page.getByTestId("slash-announce");
    await expect(said).toHaveAttribute("role", "status");
    await expect(said).toHaveText("");
    await page.keyboard.type("/");
    await expect(said).toHaveText("Claude is still starting. Its commands show here once it is ready.");
    await agent(page, `f.ready("${H}");`);
    await expect(said).toHaveText("8 commands and skills");
    await page.keyboard.type("rev");
    await expect(said).toHaveText("3 matches");
    await expect(rows(page).first()).toHaveAccessibleName("/review, [pr], Review a pull request, built in");
    await page.keyboard.type("x");
    await expect(said).toHaveText("No command or skill is called /revx. Enter sends it as a message.");
    await page.keyboard.press("Escape");
    await expect(said).toHaveText("");
  });

  test("opens only for a slash first in the message, and goes with focus", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("see /re");
    await expect(menu(page)).toHaveCount(0);
    await input(page).fill("");
    await page.keyboard.type("/re");
    await expect(menu(page)).toBeVisible();
    await page.getByTestId("thread").click();
    await expect(menu(page)).toHaveCount(0);
    await input(page).click();
    await expect(menu(page)).toBeVisible();
  });

  test("says when nothing matches, sends it as a message, and closes at the first space", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/deploy");
    await expect(page.getByTestId("slash-menu-empty")).toHaveText(
      "No command or skill is called /deploy. ↵ sends it as a message.",
    );
    await expect(rows(page)).toHaveCount(0);
    await page.keyboard.type(" now");
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.press("Enter");
    expect((await calls(page)).filter((call) => call.method === "send").map((call) => call.text)).toEqual([
      "/deploy now",
    ]);
  });

  test("says the agent is not ready yet, and fills in place once it is", async ({ page }) => {
    await openIntegrated(page, { holdReady: true });
    await input(page).click();
    await page.keyboard.type("/");
    await expect(page.getByTestId("slash-menu-empty")).toHaveText(
      "Claude is still starting. Its commands show here once it is ready.",
    );
    await page.keyboard.press("Enter");
    await expect(input(page)).toHaveValue("/");
    // Send waits too, though a press on it takes the keyboard from the field.
    await expect(page.getByTestId("send")).toBeDisabled();
    await page.getByTestId("send").click({ force: true });
    expect((await calls(page)).filter((call) => call.method === "send")).toEqual([]);
    await expect(input(page)).toHaveValue("/");
    await agent(page, `f.ready("${H}");`);
    await expect(page.getByTestId("send")).toBeEnabled();
    await input(page).click();
    await expect(rows(page)).toHaveCount(8);
    await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
  });

  test("follows the list the agent sends when it changes", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/de");
    await expect(page.getByTestId("slash-menu-empty")).toBeVisible();
    await agent(
      page,
      `f.commands("${H}", [{ name: "deploy", description: "Ship it", hint: null, skill: true, builtin: false, source: "project" }]);`,
    );
    await expect(rows(page)).toHaveCount(1);
    await expect(menu(page).locator("[role='group'] p")).toHaveText("Skills");
  });

  test("leaves a composition alone", async ({ page }) => {
    await openIntegrated(page);
    await input(page).click();
    await page.keyboard.type("/re");
    await input(page).evaluate((field) => {
      for (const key of ["ArrowDown", "Enter"])
        field.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, cancelable: true }));
    });
    await expect(input(page)).toHaveValue("/re");
    await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
  });

  test("is never taller than the room above the composer, and keeps the mark in view", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 520 });
    await openIntegrated(page);
    const many = Array.from({ length: 40 }, (_, at) => ({
      name: `task-${String(at).padStart(2, "0")}`,
      description: `Does task ${at}`,
      hint: null,
      skill: at % 2 === 0,
      builtin: false,
      source: "project",
    }));
    await agent(page, `f.commands("${H}", ${JSON.stringify(many)});`);
    await input(page).click();
    await page.keyboard.type("/");
    await expect(rows(page)).toHaveCount(40);
    const pane = (await page.locator(PANE).boundingBox())!;
    const box = (await menu(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(pane.y);
    await page.keyboard.press("ArrowUp");
    const last = rows(page).last();
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect(last).toBeInViewport();
    const marked = (await last.boundingBox())!;
    expect(marked.y + marked.height).toBeLessThanOrEqual(box.y + box.height);
    expect(marked.y).toBeGreaterThanOrEqual(box.y);
  });

  test("keeps the name and what it does in a narrow pane", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openIntegrated(page);
    await page.locator(PANE).evaluate((pane) => {
      (pane as HTMLElement).style.width = "360px";
      (pane as HTMLElement).style.flex = "none";
    });
    await input(page).click();
    await page.keyboard.type("/");
    const row = rows(page).first();
    await expect(row).toBeVisible();
    const box = (await menu(page).boundingBox())!;
    const pane = (await page.locator(PANE).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
    await expect(row.locator(".cmd-source")).toBeHidden();
    const name = (await row.getByTestId("slash-name").boundingBox())!;
    expect(name.x + name.width).toBeLessThanOrEqual(box.x + box.width);
  });

  test("stays away for an agent that lists no commands, where a slash is text", async ({ page }) => {
    await openIntegrated(page, { agent: "codex" });
    await input(page).click();
    await page.keyboard.type("/compact");
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.press("Enter");
    const made = await calls(page);
    expect(made.filter((call) => call.method === "send").map((call) => call.text)).toEqual(["/compact"]);
    expect(made.filter((call) => call.method === "compact")).toEqual([]);
  });
});
