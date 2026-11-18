import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// Going back to an earlier message, and Up on a waiting one, in an
// integrated session on the fake core. The handle of the first session the
// fake starts is int-1; Claude Code's started again is int-2 and on.

const H = "int-1";

/** Runs a script against the scripted session, as the agent would act. */
function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

/** The calls the window made on the scripted session. */
function calls(page: Page): Promise<{ method: string; [field: string]: unknown }[]> {
  return page.evaluate(
    () => (window as unknown as { __integrated: { calls: { method: string }[] } }).__integrated.calls,
  );
}

async function open(page: Page, agentId: "claude-code" | "codex" = "claude-code") {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: { integrated: [agentId] },
    ...(agentId === "codex" ? { agents: ["codex"], integrable: ["codex"] } : {}),
  });
  await page.goto("/");
  await page.locator(`[data-row="project:${PROJECT}"]`).getByTestId("project-new-session").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

/** Three messages of the user's, each answered, written in the composer as
    the user writes them. */
async function talk(page: Page, handle = H, kept = true) {
  const field = page.getByTestId("composer-input");
  for (const [said, answer] of [
    ["The upload client gives up on the first 503. Find where it retries.", "It never retries."],
    ["Add a retry with backoff for 503 and 429.", "Done. Tests pass."],
    ["Make the backoff jittered and cap it at 8 seconds.", "The wait is jittered now."],
  ]) {
    await field.fill(said);
    await field.press("Enter");
    await expect(page.getByTestId("user-message").filter({ hasText: said })).toBeVisible();
    await agent(page, `f.turn("${handle}", ${JSON.stringify(answer)});`);
  }
  await expect(page.getByTestId("agent-run")).toHaveCount(3);
  if (!kept) return;
  // Claude Code kept the files as they were before each message.
  const sent = (await calls(page)).filter((call) => call.method === "send").map((call) => call.message as string);
  await page.evaluate(
    (ids) => {
      const fake = (window as unknown as { __integrated: { files: Map<string, unknown> } }).__integrated;
      ids.forEach((id, at) =>
        fake.files.set(id, {
          files: ["/home/ada/dev/demo/src/net/upload.ts", ...(at === 0 ? ["/home/ada/dev/demo/src/net/upload.retry.test.ts"] : [])],
          insertions: 9 - at,
          deletions: 46 - at * 10,
        }),
      );
    },
    sent,
  );
}

/** The id the window gave the message that says `text`. */
async function idOf(page: Page, text: string): Promise<string> {
  const sent = (await calls(page)).filter((call) => call.method === "send" && call.text === text);
  return sent[0].message as string;
}

test.describe("going back to an earlier message", () => {
  test("Esc Esc opens the list over the composer, and the thread follows the mark", async ({ page }) => {
    await open(page);
    await talk(page);
    const field = page.getByTestId("composer-input");
    await field.focus();
    await field.press("Escape");
    await expect(page.getByTestId("composer-esc")).toHaveText("esc again to go back to an earlier message.");
    await field.press("Escape");
    const list = page.getByTestId("back-menu");
    await expect(list).toBeVisible();
    await expect(list.getByTestId("back-menu-row")).toHaveCount(3);
    // The newest is marked, next to the composer.
    await expect(list.getByTestId("back-menu-row").nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("back-said")).toHaveText(
      "This message and what Claude did for it leave the conversation.",
    );
    await field.press("ArrowUp");
    await expect(list.getByTestId("back-menu-row").nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("back-said")).toHaveText(
      "This message and the 1 after it leave the conversation, with what Claude did for them.",
    );
    // The thread draws the marked message under a line, and fades what
    // would leave.
    await expect(page.getByTestId("back-here")).toBeVisible();
    const marked = page.locator(".row.back [data-testid='user-message']");
    await expect(marked).toContainText("Add a retry with backoff");
    await expect(page.locator(".row.leaves")).not.toHaveCount(0);
    // The keyboard stays in the composer.
    await expect(field).toBeFocused();
    await field.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(page.getByTestId("back-here")).toHaveCount(0);
  });

  test("Enter turns the list into the choices, and the conversation goes back with the words to edit", async ({ page }) => {
    await open(page);
    await talk(page);
    const field = page.getByTestId("composer-input");
    const second = await idOf(page, "Add a retry with backoff for 503 and 429.");
    await field.press("Escape");
    await field.press("Escape");
    await field.press("ArrowUp");
    await field.press("Enter");
    const choices = page.getByTestId("back-choices");
    await expect(choices).toBeVisible();
    await expect(choices.getByTestId("back-choices-head")).toContainText("Go back to before");
    await expect(choices.getByTestId("back-choices-head")).toContainText("Add a retry with backoff for 503 and 429.");
    const rows = choices.getByTestId("back-choices-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("The conversation");
    await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(rows.nth(1)).toContainText("The conversation and the files");
    await expect(rows.nth(1)).toContainText("Also puts upload.ts back as it was, +8 −36.");
    await expect(rows.nth(2)).toContainText("Only the files");
    await expect(page.getByTestId("back-cost")).toHaveText("Claude Code starts again for this.");
    // Esc goes back to the list, and Enter forward again.
    await field.press("Escape");
    await expect(page.getByTestId("back-menu")).toBeVisible();
    await field.press("Enter");
    await field.press("Enter");
    await expect(choices).toHaveCount(0);
    // The message and what came after it left the thread; a line marks the
    // place; the words are back in the composer, the caret at their end.
    await expect(page.getByTestId("user-message")).toHaveCount(1);
    await expect(page.getByTestId("rewound")).toContainText("Rewound here,");
    await expect(field).toHaveValue("Add a retry with backoff for 503 and 429.");
    await expect(field).toBeFocused();
    expect(await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(
      "Add a retry with backoff for 503 and 429.".length,
    );
    const asked = (await calls(page)).filter((call) => call.method === "rewind");
    expect(asked).toEqual([{ method: "rewind", id: H, message: second, conversation: true, files: null }]);
    // Claude Code started again under a new id, on the same conversation.
    expect((await calls(page)).filter((call) => call.method === "start")).toHaveLength(1);
    // Undo stands on the line until something is sent; it brings it back.
    await page.getByTestId("rewound-undo").click();
    await expect(page.getByTestId("user-message")).toHaveCount(3);
    await expect(page.getByTestId("rewound")).toHaveCount(0);
    await expect(field).toHaveValue("");
    expect((await calls(page)).filter((call) => call.method === "rewindUndo")).toHaveLength(1);
  });

  test("the conversation and the files puts back the files the preview named, and says so", async ({ page }) => {
    await open(page);
    await talk(page);
    const field = page.getByTestId("composer-input");
    const first = await idOf(page, "The upload client gives up on the first 503. Find where it retries.");
    await field.press("Escape");
    await field.press("Escape");
    await field.press("Home");
    await expect(page.getByTestId("back-menu-row").nth(0)).toContainText("2 files");
    await field.press("Enter");
    await expect(page.getByTestId("back-choices-row").nth(1)).toContainText(
      "Also puts upload.ts and upload.retry.test.ts back as they were, +9 −46.",
    );
    await field.press("2");
    await expect(page.getByTestId("composer-back")).toContainText(
      "upload.ts and upload.retry.test.ts are as they were at",
    );
    await expect(page.getByTestId("composer-back")).toContainText("What commands changed stays.");
    const asked = (await calls(page)).filter((call) => call.method === "rewind");
    expect(asked).toEqual([
      {
        method: "rewind",
        id: H,
        message: first,
        conversation: true,
        files: ["/home/ada/dev/demo/src/net/upload.ts", "/home/ada/dev/demo/src/net/upload.retry.test.ts"],
      },
    ]);
    // Going back with the files put back is not undone.
    await expect(page.getByTestId("rewound")).toBeVisible();
    await expect(page.getByTestId("rewound-undo")).toHaveCount(0);
  });

  test("a single Esc during a turn stops the turn and opens nothing", async ({ page }) => {
    await open(page);
    await talk(page);
    const field = page.getByTestId("composer-input");
    await field.fill("Now write a test.");
    await field.press("Enter");
    await agent(page, `f.startTurn("${H}");`);
    await field.press("Escape");
    await field.press("Escape");
    await expect(page.getByTestId("back-menu")).toHaveCount(0);
    expect((await calls(page)).filter((call) => call.method === "interrupt").length).toBeGreaterThan(0);
  });

  test("typing over the list closes it and types", async ({ page }) => {
    await open(page);
    await talk(page);
    const field = page.getByTestId("composer-input");
    await field.press("Escape");
    await field.press("Escape");
    await expect(page.getByTestId("back-menu")).toBeVisible();
    await field.pressSequentially("ok");
    await expect(page.getByTestId("back-menu")).toHaveCount(0);
    await expect(field).toHaveValue("ok");
  });

  test("Go back to here on a message, and the palette, open the list at it", async ({ page }) => {
    await open(page);
    await talk(page);
    const message = page.getByTestId("user-message").filter({ hasText: "Add a retry" });
    await message.hover();
    await message.getByTestId("go-back-here").click();
    const choices = page.getByTestId("back-choices");
    await expect(choices).toBeVisible();
    await expect(choices.getByTestId("back-choices-head")).toContainText("Add a retry with backoff");
    await expect(page.locator(".row.back [data-testid='user-message']")).toContainText("Add a retry");
    await page.getByTestId("composer-input").press("Escape");
    await page.getByTestId("composer-input").press("Escape");
    await expect(page.getByTestId("back-menu")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.keyboard.type("go back");
    await page.getByRole("option", { name: /Go back to an earlier message/ }).click();
    await expect(page.getByTestId("back-menu")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeFocused();
  });

  test("Codex goes back in the same session, with the conversation alone, and says files stay", async ({ page }) => {
    await open(page, "codex");
    await talk(page, H, false);
    const field = page.getByTestId("composer-input");
    await field.press("Escape");
    await field.press("Escape");
    await expect(page.getByTestId("back-menu-row")).toHaveCount(3);
    await expect(page.getByTestId("back-files").first()).toHaveText("");
    await field.press("ArrowUp");
    await field.press("Enter");
    const rows = page.getByTestId("back-choices-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("The conversation");
    await expect(page.getByTestId("back-cost")).toHaveText(
      "Codex cannot put files back: they stay as they are now. Going back cannot be undone.",
    );
    await field.press("1");
    await expect(page.getByTestId("user-message")).toHaveCount(1);
    await expect(field).toHaveValue("Add a retry with backoff for 503 and 429.");
    await expect(page.getByTestId("rewound-undo")).toHaveCount(0);
    // The same session goes on: nothing started again.
    expect((await calls(page)).filter((call) => call.method === "start")).toHaveLength(1);
  });
});

test.describe("Up on a waiting message", () => {
  test("takes the newest back, again the one before, and sends them as one", async ({ page }) => {
    await open(page);
    await talk(page, H, false);
    const field = page.getByTestId("composer-input");
    await field.fill("Log each retry.");
    await field.press("Enter");
    await agent(page, `f.startTurn("${H}");`);
    await field.fill("Use console.debug, not console.log.");
    await field.press("Enter");
    await field.fill("And put the attempt number first.");
    await field.press("Enter");
    await expect(page.getByTestId("message-waiting")).toHaveCount(2);
    await expect(page.getByTestId("composer-now")).toContainText("↑ takes the newest back.");
    await field.press("ArrowUp");
    await expect(field).toHaveValue("And put the attempt number first.");
    expect(await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(0);
    await expect(page.getByTestId("composer-now")).toHaveText(
      "↑ again takes back the one before. ↵ sends this to wait again.",
    );
    await field.press("ArrowUp");
    await expect(field).toHaveValue("Use console.debug, not console.log.\nAnd put the attempt number first.");
    await expect(page.getByTestId("message-waiting")).toHaveCount(0);
    await expect(page.getByTestId("composer-now")).toHaveText("↵ sends this to wait again.");
    // Moving the caret gives Up back to the field.
    await field.press("ArrowDown");
    await field.press("Enter");
    await expect(page.getByTestId("message-waiting")).toHaveCount(1);
    await expect(page.getByTestId("message-waiting")).toHaveCount(1);
    const sent = (await calls(page)).filter((call) => call.method === "send").at(-1);
    expect(sent?.text).toBe("Use console.debug, not console.log.\nAnd put the attempt number first.");
  });
});
