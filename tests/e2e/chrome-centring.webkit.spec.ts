import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * The words of the window's chrome stand in the middle of their row, in
 * WebKit, which is the app's own webview on macOS: the status bar's in the
 * row the eye takes for the bar, and the pane headers' titles and quiet
 * words in their header. A run of text stands in the middle when its
 * capitals, from the baseline up by the face's cap height, are as far from
 * the row's top as from its foot, give or take a pixel. In Chromium the
 * terminal look's fallback face sits a little lower in every header, so
 * there the agent header's words are held to the changes title's line,
 * and the pixel only in WebKit.
 */

const LAGOON = {
  dots: [
    { hue: 192, chroma: 0.9 },
    { hue: 252, chroma: 0.8 },
  ],
  harmony: "free",
  strength: 0.6,
  grain: 0.25,
};

async function open(page: Page, look: string, background: boolean) {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: {
      integrated: ["claude-code"],
      appearance: "dark",
      look,
      ...(background ? { backgrounds: { teal: LAGOON } } : {}),
    },
  });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByTestId("model-readout")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** How far below the middle of its row each run of text in `selector`
    stands, in pixels: the row is `row`'s box under its top border, or for
    the status bar in the modern look, where it has no edge of its own,
    the band of ground from the cards' foot to the window's. */
function offsets(page: Page, selector: string, row: string): Promise<Record<string, number>> {
  return page.evaluate(
    ({ selector, row }) => {
      const canvas = document.createElement("canvas").getContext("2d")!;
      const box = document.querySelector(row)!;
      const rect = box.getBoundingClientRect();
      const top = rect.top + parseFloat(getComputedStyle(box).borderTopWidth);
      const middle = (top + rect.bottom) / 2;
      const out: Record<string, number> = {};
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const node = walker.nextNode();
        if (node === null || (node.textContent ?? "").trim() === "") continue;
        const style = getComputedStyle(node.parentElement!);
        canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const metrics = canvas.measureText("H");
        const range = document.createRange();
        range.selectNodeContents(node);
        const area = range.getClientRects()[0];
        const spare = area.height - (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
        const baseline = area.top + spare / 2 + metrics.fontBoundingBoxAscent;
        const caps = (baseline - metrics.actualBoundingBoxAscent + baseline) / 2;
        out[(node.textContent ?? "").trim()] = Math.round((caps - middle) * 100) / 100;
      }
      return out;
    },
    { selector, row },
  );
}

const within = (found: Record<string, number>) => {
  expect(Object.keys(found).length).toBeGreaterThan(0);
  for (const [text, off] of Object.entries(found)) expect(Math.abs(off), `"${text}" off by ${off}`).toBeLessThanOrEqual(1);
};

for (const look of ["modern", "terminal"])
  for (const background of [false, true])
    test.describe(`${look}${background ? ", with a background" : ""}`, () => {
      test("centres the status bar's words in the bar's row", async ({ page }) => {
        await open(page, look, background);
        const bar = page.getByTestId("status-bar");
        // In the modern look the bar has no rule and stands on the ground,
        // so its row reaches up to the cards' foot.
        if (look === "modern") {
          const foot = await page.evaluate(() =>
            Math.max(...[...document.querySelectorAll("section[data-pane]")].map((one) => one.getBoundingClientRect().bottom)),
          );
          expect((await bar.boundingBox())!.y).toBeCloseTo(foot, 0);
        }
        within(await offsets(page, "[data-testid='status-bar'] :is([data-testid$='-readout'], .lb, .pc)", "[data-testid='status-bar']"));
        // At a larger size too.
        await page.addStyleTag({ content: ":root { --status-size: 14px !important; }" });
        within(await offsets(page, "[data-testid='status-bar'] :is([data-testid$='-readout'], .lb, .pc)", "[data-testid='status-bar']"));
      });

      test("stands the agent pane's title, its state, project and branch on the changes title's line", async ({
        page,
        browserName,
      }) => {
        await open(page, look, background);
        const head = "section[data-pane='agent'] > header";
        await expect(page.locator(`${head} .meta`)).toHaveText("idle");
        const runs = await offsets(page, `${head} :is(.title, .meta, .crumb-text)`, head);
        const changes = await offsets(page, "section[data-pane='changes'] > header .title", "section[data-pane='changes'] > header");
        const line = Object.values(changes)[0];
        expect(Object.keys(runs).length).toBeGreaterThan(0);
        for (const [text, off] of Object.entries(runs))
          expect(Math.abs(off - line), `"${text}" ${off} against the changes title's ${line}`).toBeLessThanOrEqual(0.5);
        if (browserName === "webkit") within(runs);
      });
    });
