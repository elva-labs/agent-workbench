import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * Cards that let the background through: with a background of the user's
 * own and a share of it on the cards, nothing inside a card paints one of
 * the palette's solid surfaces, so a card reads as one piece rather than a
 * picture with solid patches on it. A walk over every rendered element in
 * every card, in each scene the user meets, lists what does.
 */

const AGENT = "section[data-pane='agent']";
const TERMINAL = "section[data-pane='terminal']";
const TREE = "[data-testid='file-tree']";
const MOD = "ControlOrMeta";
const H = "int-1";

const LAGOON = {
  dots: [
    { hue: 192, chroma: 0.9 },
    { hue: 252, chroma: 0.8 },
  ],
  harmony: "free",
  strength: 0.6,
  grain: 0.25,
};

const LOOKS = ["modern", "terminal"] as const;
const APPEARANCES = ["light", "dark"] as const;

/** Every element inside a card, and every card, that paints one of the
    palette's solid surfaces, as a list to work through: a short path to
    each and the colour it paints. The surfaces are read from the root,
    outside any card. The browser pane's page and media are left solid. */
function offenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parse = (text: string): number[] => {
      const nums = text.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) ?? [0, 0, 0, 0];
      const [r, g, b, a = 1] = nums;
      return text.startsWith("color(") ? [r * 255, g * 255, b * 255, a] : [r, g, b, a];
    };
    const probe = document.createElement("div");
    document.body.append(probe);
    const solids: { name: string; colour: number[] }[] = [];
    for (const name of ["--surface", "--surface-2", "--well", "--bg", "--deep", "--accent-soft", "--field-bg"]) {
      probe.style.backgroundColor = `var(${name})`;
      solids.push({ name, colour: parse(getComputedStyle(probe).backgroundColor) });
    }
    probe.remove();
    const solid = (text: string): string | null => {
      const colour = parse(text);
      if (colour[3] < 0.999) return null;
      const names = solids
        .filter((one) => [0, 1, 2].every((i) => Math.abs(one.colour[i] - colour[i]) <= 1))
        .map((one) => one.name);
      return names.length === 0 ? null : names.join("/");
    };
    const describe = (element: Element) => {
      const classes = [...element.classList].filter((name) => !/^(svelte|s)-/.test(name) && !/^ͼ/.test(name));
      const testid = element.getAttribute("data-testid");
      return (
        element.tagName.toLowerCase() +
        classes.map((name) => `.${name}`).join("") +
        (testid === null ? "" : `[${testid}]`)
      );
    };
    const where = (element: Element) => {
      const parts = [describe(element)];
      for (let node = element.parentElement; node !== null && parts.length < 3; node = node.parentElement)
        if (node.hasAttribute("data-testid") || node.hasAttribute("data-pane") || node.classList.length > 1)
          parts.push(describe(node));
      return parts.join(" < ");
    };
    const shown = (element: Element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility !== "visible") return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    // What stays solid: the browser pane's page, media, and the picker's
    // pad, which is a picture of the background itself.
    const kept = [
      "[data-testid='browser-body']",
      "img, video, embed, iframe, object, picture",
      "[data-testid='media-page']",
      "[data-testid='background-pad']",
      // The terminal's input, which is never drawn.
      ".xterm-helper-textarea",
    ].join(", ");
    const modern = document.documentElement.dataset.look === "modern";
    const cards = new Set([
      ...document.querySelectorAll(
        modern ? "section[data-pane]:not([data-pane='sessions']) > .body" : "section[data-pane]",
      ),
      ...document.querySelectorAll("[data-card]"),
    ]);
    const out = new Set<string>();
    for (const card of cards) {
      if (!shown(card)) continue;
      const style = getComputedStyle(card);
      if (style.backgroundImage === "none") out.add(`the card ${where(card)} is not painted`);
      const own = solid(style.backgroundColor);
      if (own !== null) out.add(`the card ${where(card)} ${own}`);
      for (const element of card.querySelectorAll("*")) {
        if (element.closest(kept) !== null || !shown(element)) continue;
        const found = solid(getComputedStyle(element).backgroundColor);
        if (found !== null) out.add(`${where(element)} ${found}`);
        for (const pseudo of ["::before", "::after"]) {
          const part = getComputedStyle(element, pseudo);
          if (part.content === "none" || part.display === "none" || part.visibility !== "visible") continue;
          const painted = solid(part.backgroundColor);
          if (painted !== null) out.add(`${where(element)}${pseudo} ${painted}`);
        }
      }
    }
    return [...out].sort();
  });
}

/** Fails with every offender listed, one to a line. */
async function walk(page: Page) {
  expect(await offenders(page), "solid surfaces inside a card").toEqual([]);
}

/** Whether what a test reaches for stands in a card or is one. */
function inCard(page: Page, testid: string) {
  return page.getByTestId(testid).evaluate((element) => {
    const modern = document.documentElement.dataset.look === "modern";
    return (
      element.closest(
        modern ? "section[data-pane]:not([data-pane='sessions']) > .body, [data-card]" : "section[data-pane], [data-card]",
      ) !== null
    );
  });
}

async function open(
  page: Page,
  look: string,
  appearance: string,
  extra: Record<string, unknown> = {},
) {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: { appearance, look, backgrounds: { teal: LAGOON }, cards: { teal: 0.25 }, ...extra },
  });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator(":root")).toHaveAttribute("data-cards", /.*/);
}

/** Runs a script against the scripted integrated session. */
function script(page: Page, body: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${body} })()`);
}

/** The agent at work in a terminal, a file's diff open in the changes
    pane, and the terminal panel with two shells side by side. */
async function working(page: Page) {
  await page.getByTestId("start-agent").click();
  await expect(page.locator(AGENT)).toContainText("running");
  await expect(page.locator(`${AGENT} .xterm-screen`)).toBeVisible();
  await page.locator(TREE).getByText("mod.rs", { exact: true }).click();
  await expect(page.getByTestId("viewer")).toHaveAttribute("data-view", "diff");
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(TERMINAL)).toBeVisible();
  await page.getByTestId("split-terminal").click();
  await expect(page.locator(`${TERMINAL} .xterm-screen`)).toHaveCount(2);
  await expect(page.locator(`${TERMINAL} .slot.on.focused`)).toHaveCount(1);
  await expect(page.locator(`${TERMINAL} .slot.on.beside`)).toHaveCount(1);
}

/** An integrated session with a message, an answer with inline code and a
    block of it, a command with its output open, and the find bar. */
async function conversation(page: Page) {
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await script(
    page,
    `f.send("${H}", crypto.randomUUID(), "Keep the cache between runs.");
     f.startTurn("${H}");
     f.emit("${H}", { type: "text", block: "a", parent: null, text: "The cache lives in \`memory\`. Read it back:\\n\\n\`\`\`rust\\nlet cached = Cache::read(&dir)?;\\n\`\`\`", done: true });
     f.tool("${H}", "Bash", { command: "cargo test -p core cache" }, "running 6 tests\\ntest result: ok", { kind: "command" });
     f.emit("${H}", { type: "text", block: "b", parent: null, text: "Done.", done: true });
     f.endTurn("${H}");`,
  );
  await page.getByTestId("work-line").click();
  await page.getByTestId("step-row").click();
  await expect(page.getByTestId("step-output")).toBeVisible();
  await page.getByTestId("composer-input").focus();
  await page.keyboard.press(`${MOD}+f`);
  await page.getByTestId("conversation-find-input").fill("cache");
  await expect(page.getByTestId("conversation-find-bar")).toBeVisible();
}

/** Editor mode with a file open, a selection and the search panel. */
async function editor(page: Page) {
  await page.keyboard.press(`${MOD}+Shift+E`);
  await expect(page.getByTestId("mode-readout")).toHaveText("editing");
  await page.locator(TREE).getByText("README.md", { exact: true }).click();
  await expect.poll(() => page.locator(".cm-content").innerText()).toContain("// README.md");
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${MOD}+Home`);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press(`${MOD}+f`);
  await expect(page.getByTestId("find-field")).toBeFocused();
  await expect(page.locator(".cm-selectionBackground").first()).toBeVisible();
}

const SCENES: Record<string, { extra?: Record<string, unknown>; reach: (page: Page) => Promise<void> }> = {
  "working": { reach: working },
  "the conversation": { extra: { integrated: ["claude-code"] }, reach: conversation },
  "the editor": { reach: editor },
  "the settings on the appearance tab": {
    reach: async (page) => {
      await page.keyboard.press(`${MOD}+,`);
      await page.getByTestId("settings-tab-appearance").click();
      await expect(page.getByTestId("settings")).toBeVisible();
    },
  },
};

for (const look of LOOKS)
  for (const appearance of APPEARANCES) {
    test.describe(`${look}, ${appearance}`, () => {
      for (const [name, scene] of Object.entries(SCENES))
        test(`nothing solid in a card: ${name}`, async ({ page }) => {
          await open(page, look, appearance, scene.extra);
          await scene.reach(page);
          await walk(page);
        });

      test("nothing solid in a card: the menus over the files and the palette", async ({ page }) => {
        await open(page, look, appearance);
        await page.keyboard.press(`${MOD}+Shift+E`);
        await expect(page.getByTestId("mode-readout")).toHaveText("editing");
        await page.locator(TREE).getByText("Cargo.toml", { exact: true }).click({ button: "right" });
        await expect(page.getByTestId("row-menu")).toBeVisible();
        expect(await inCard(page, "row-menu")).toBe(true);
        await walk(page);
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("row-menu")).toBeHidden();
        await page.keyboard.press(`${MOD}+Shift+P`);
        await expect(page.getByTestId("palette")).toBeVisible();
        expect(await inCard(page, "palette")).toBe(true);
        await walk(page);
      });

      test("nothing solid in a card: the menus over the conversation", async ({ page }) => {
        await open(page, look, appearance, { integrated: ["claude-code"] });
        await page.getByTestId("start-agent").click();
        await expect(page.getByTestId("composer-input")).toBeVisible();
        await page.getByTestId("composer-input").click();
        await page.keyboard.type("/");
        await expect(page.getByTestId("slash-menu")).toBeVisible();
        expect(await inCard(page, "slash-menu")).toBe(true);
        await walk(page);
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("slash-menu")).toBeHidden();
        await page.getByTestId("model-chip").click();
        await expect(page.getByTestId("model-menu")).toBeVisible();
        expect(await inCard(page, "model-menu")).toBe(true);
        await walk(page);
      });
    });
  }

test("with no share on the cards stamps nothing and leaves the agent's card solid", async ({ page }) => {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: { appearance: "light", look: "modern", backgrounds: { teal: LAGOON } },
  });
  await page.goto("/");
  await expect(page.locator(":root")).toHaveAttribute("data-background", /.*/);
  await expect(page.locator(":root")).not.toHaveAttribute("data-cards", /.*/);
  await page.getByTestId("start-agent").click();
  await expect(page.locator(AGENT)).toContainText("running");
  const card = await page.locator(`${AGENT} > .body`).evaluate((body) => {
    const style = getComputedStyle(body);
    const wrap = getComputedStyle(body.querySelector(".wrap")!);
    return { image: style.backgroundImage, colour: style.backgroundColor, wrap: wrap.backgroundColor };
  });
  expect(card.image).toBe("none");
  expect(card.colour).toBe("rgb(255, 255, 255)");
  expect(card.wrap).toBe("rgb(255, 255, 255)");
});
