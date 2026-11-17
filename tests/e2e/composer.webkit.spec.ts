import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// The composer's field in both looks, in WebKit: the app's webview on
// macOS, which draws the caret over the line it is on.

const H = "int-1";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

async function open(page: Page, look: "modern" | "terminal") {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"], look } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(input(page)).toBeEnabled();
}

const input = (page: Page) => page.getByTestId("composer-input");

async function say(page: Page, text: string) {
  await input(page).fill(text);
  await page.keyboard.press("Enter");
}

/** The field's height, the height of its lines without its padding, and
    the height of a line of text in its own face. */
const field = (page: Page) =>
  input(page).evaluate((node) => {
    const style = getComputedStyle(node);
    // Words in a block of their own, whose box is as tall as the face's
    // ascent and descent whatever the line around them.
    const block = document.createElement("div");
    const text = document.createElement("span");
    text.textContent = "Hxgy";
    for (const name of ["fontFamily", "fontSize", "fontWeight", "fontStyle"] as const) text.style[name] = style[name];
    block.append(text);
    document.body.append(block);
    const line = text.getBoundingClientRect().height;
    block.remove();
    return {
      height: node.getBoundingClientRect().height,
      lines: node.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      line,
    };
  });

for (const look of ["modern", "terminal"] as const) {
  test.describe(`in the ${look} look`, () => {
    test("keeps each line of the field as tall as its text, one line filling the field", async ({ page }) => {
      await open(page, look);
      await say(page, "go");
      await agent(page, `f.startTurn("${H}"); f.ask("${H}", "Bash", { command: "cargo test" });`);
      await expect(input(page)).toHaveAttribute("placeholder", "↑ to answer, or write a message");
      const empty = await field(page);
      expect(empty.height).toBeCloseTo(22, 0);
      expect(Math.abs(empty.lines - empty.line)).toBeLessThanOrEqual(1);
      await input(page).fill("Fix the flaky cache test");
      const one = await field(page);
      expect(one.height).toBeCloseTo(22, 0);
      expect(Math.abs(one.lines - one.line)).toBeLessThanOrEqual(1);
      await input(page).fill("First, read the failing test.\nThen find what races.\nThen fix it");
      await expect.poll(async () => (await field(page)).height).toBeGreaterThan(22);
      const three = await field(page);
      expect(Math.abs(three.lines / 3 - three.line)).toBeLessThanOrEqual(1);
    });
  });
}
