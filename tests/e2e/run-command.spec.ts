import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// A line that begins with `!` runs in the shell of the session's folder,
// and so does a command the agent wrote for the user to run, by its mark.
// SHOTS names a folder to keep a picture of each look in.

const H = "int-1";

/** Calls the scripted agent's `method` with `args`. */
function agent(page: Page, method: string, ...args: unknown[]) {
  return page.evaluate(
    ([method, args]) => {
      const fake = (window as unknown as { __integrated: Record<string, (...args: unknown[]) => unknown> }).__integrated;
      fake[method](...args);
    },
    [method, args] as const,
  );
}

function calls(page: Page): Promise<{ method: string; [field: string]: unknown }[]> {
  return page.evaluate(() => (window as unknown as { __integrated: { calls: { method: string }[] } }).__integrated.calls);
}

/** The id the window gave the command it ran last, once the core has it. */
async function ran(page: Page): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      id = ((await calls(page)).filter((call) => call.method === "run").at(-1)?.command as string | undefined) ?? "";
      return id;
    })
    .not.toBe("");
  return id;
}

async function open(page: Page, options: { codex?: boolean; look?: "modern" | "terminal"; appearance?: "light" | "dark" } = {}) {
  await installFakeCore(page, {
    open: [PROJECT],
    ...(options.codex ? { agents: ["codex"], integrable: ["codex"] } : {}),
    settings: {
      integrated: [options.codex ? "codex" : "claude-code"],
      ...(options.look ? { look: options.look } : {}),
      ...(options.appearance ? { appearance: options.appearance } : {}),
    },
  });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("conversation")).toBeVisible();
}

const input = (page: Page) => page.getByTestId("composer-input");

async function say(page: Page, text: string) {
  await input(page).fill(text);
  await page.keyboard.press("Enter");
}

const LINES = Array.from({ length: 30 }, (_, at) => `ok ${at + 1} - counts to ${at + 1}`).join("\n") + "\n";

test("runs a line typed after a ! in the session's folder, streams what it prints, and stops it", async ({ page }) => {
  await open(page);
  await input(page).fill("!npm test");
  await expect(page.getByTestId("composer")).toHaveClass(/\bsh\b/);
  await expect(page.getByTestId("composer-bang")).toHaveText("!");
  await expect(page.getByTestId("composer-where")).toBeVisible();
  await expect(page.getByTestId("send")).toHaveAttribute("aria-label", "Run");
  await page.keyboard.press("Enter");
  await expect(input(page)).toHaveValue("");
  const command = page.getByTestId("command");
  await expect(command).toHaveAttribute("data-state", "running");
  await expect(command.getByTestId("command-line")).toHaveText("!npm test");
  const id = await ran(page);
  expect((await calls(page)).find((call) => call.method === "run")).toEqual({ method: "run", id: H, command: id, text: "npm test" });
  // The session stays at rest while it runs: the composer still sends.
  await input(page).fill("hello");
  await expect(page.getByTestId("send")).toHaveAttribute("aria-label", "Send");
  await input(page).fill("");
  await agent(page, "commandOutput", H, id, "ok 1 - adds\n");
  await agent(page, "commandOutput", H, id, "ok 2 - takes away\n");
  await expect(command.getByTestId("command-output")).toHaveText("ok 1 - adds\nok 2 - takes away\n");
  await command.getByTestId("stop-command").click();
  await expect(command).toHaveAttribute("data-state", "stopped");
  await expect(command.getByTestId("command-end")).toHaveText("Stopped");
  await expect(command.getByTestId("command-output")).toHaveText("ok 1 - adds\nok 2 - takes away\n");
  expect((await calls(page)).filter((call) => call.method === "stopCommand")).toEqual([{ method: "stopCommand", id: H, command: id }]);
});

test("shows the last lines of a long output, all of it on asking, and how it exited", async ({ page }) => {
  await open(page);
  await say(page, "!npm test");
  const id = await ran(page);
  await agent(page, "finishCommand", H, id, { exitCode: 1, output: LINES });
  const command = page.getByTestId("command");
  await expect(command).toHaveAttribute("data-state", "done");
  await expect(command.getByTestId("command-end")).toHaveText("Exit code 1");
  await expect(command.getByTestId("command-state")).toContainText("30 lines");
  const output = command.getByTestId("command-output");
  // Its last line stands at the foot of the box, its first out of sight above.
  const sight = () =>
    output.evaluate((box) => {
      const outer = box.getBoundingClientRect();
      const text = box.firstElementChild!.getBoundingClientRect();
      return { above: outer.top - text.top, under: outer.bottom - text.bottom, height: outer.height };
    });
  const tail = await sight();
  expect(tail.above).toBeGreaterThan(0);
  expect(tail.under).toBeGreaterThanOrEqual(0);
  expect(tail.under).toBeLessThan(20);
  const all = command.getByTestId("command-all");
  await expect(all).toHaveText("Show all");
  await all.click();
  await expect(all).toHaveText("Show less");
  await expect(all).toHaveAttribute("aria-expanded", "true");
  const whole = await sight();
  expect(whole.height).toBeGreaterThan(tail.height);
  expect(whole.height).toBeLessThanOrEqual(282);
  expect(await output.evaluate((box) => box.scrollHeight > box.clientHeight)).toBe(true);
  await all.click();
  await expect(all).toHaveText("Show all");
});

test("runs a command the agent wrote for the user by its mark, leaving the draft as it is", async ({ page }) => {
  await open(page);
  await say(page, "How do I check it?");
  await agent(page, "turn", H, "Run `! npm test` to check, then:\n\n```sh\n! npm run lint\n```\n\nNothing marks `!important`.");
  const marks = page.getByTestId("run-command");
  await expect(marks).toHaveCount(2);
  await expect(marks.first()).toHaveAttribute("aria-label", "Run npm test");
  await expect(marks.nth(1)).toHaveAttribute("aria-label", "Run npm run lint");
  await input(page).fill("half a thought");
  await marks.nth(1).click();
  await expect(page.getByTestId("command-line")).toHaveText("!npm run lint");
  expect(await ran(page)).not.toBe("");
  expect((await calls(page)).find((call) => call.method === "run")).toMatchObject({ text: "npm run lint" });
  await expect(input(page)).toHaveValue("half a thought");
});

test("holds a command behind Codex's turn, takes it back, and runs it once the turn ends", async ({ page }) => {
  await open(page, { codex: true });
  await say(page, "go");
  await agent(page, "startTurn", H);
  await say(page, "!git status");
  const command = page.getByTestId("command");
  await expect(command).toHaveAttribute("data-state", "queued");
  await expect(command.getByTestId("command-state")).toContainText("Waiting");
  await expect(page.getByTestId("send-now")).toHaveCount(0);
  await command.getByTestId("take-back-command").click();
  await expect(command).toHaveCount(0);
  await expect(input(page)).toHaveValue("!git status");
  expect((await calls(page)).filter((call) => call.method === "withdraw")).toHaveLength(1);
  await page.keyboard.press("Enter");
  await expect(command).toHaveAttribute("data-state", "queued");
  await agent(page, "endTurn", H);
  await expect(command).toHaveAttribute("data-state", "running");
});

for (const look of ["modern", "terminal"] as const)
  for (const appearance of ["light", "dark"] as const)
    test(`draws a command as the user's own, its output under it, in the ${look} look in ${appearance}`, async ({ page }) => {
      await open(page, { look, appearance });
      await say(page, "How do I check it?");
      await agent(page, "turn", H, "Run `! npm test` to check it.");
      await page.getByTestId("run-command").click();
      const first = await ran(page);
      await agent(page, "finishCommand", H, first, { exitCode: 1, output: LINES });
      await expect(page.getByTestId("command-end")).toHaveText("Exit code 1");
      await say(page, "!git status --short");
      await expect(page.getByTestId("command").nth(1)).toHaveAttribute("data-state", "running");
      const second = await ran(page);
      await agent(page, "commandOutput", H, second, " M src/lib/bang.ts\n?? src/lib/components/conversation/Run.svelte\n");
      await expect(page.getByTestId("command-output").nth(1)).toContainText("Run.svelte");
      await input(page).fill("!npm run lint");
      // A command stands where the user's messages stand, on the same edge.
      const edge = (testid: string) =>
        page
          .getByTestId(testid)
          .first()
          .locator(".bubble")
          .evaluate((bubble) => [bubble.getBoundingClientRect().left, bubble.getBoundingClientRect().right]);
      const [said, run] = [await edge("user-message"), await edge("command")];
      expect(Math.abs(said[1] - run[1])).toBeLessThan(1);
      if (process.env.SHOTS)
        await page.getByTestId("conversation").screenshot({ path: `${process.env.SHOTS}/${look}-${appearance}.png` });
    });
