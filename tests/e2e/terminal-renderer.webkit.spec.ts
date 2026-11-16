import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * The renderer each terminal draws with as the cards' share moves: the GPU
 * renderer while the cards let nothing through, the DOM renderer while they
 * let a background through, and no swap back and forth while a share is
 * being picked, since a swap makes every terminal build its renderer anew.
 */

const MOD = "ControlOrMeta";

const LAGOON = {
  dots: [
    { hue: 192, chroma: 0.9 },
    { hue: 252, chroma: 0.8 },
  ],
  harmony: "free",
  strength: 0.6,
  grain: 0.25,
};

/** Whether WebGL here is drawn by a GPU. A software rasteriser, which
    headless Chromium has, gets the DOM renderer alone (`softwareGl` in
    `src/lib/terminal.ts` names the same ones), so no swap is made there. */
function gpuHere(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (gl === null) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return !/llvmpipe|softpipe|swiftshader|swrast|software/i.test(name);
  });
}

/** How many terminals draw with each renderer: the GPU one draws on a canvas. */
function renderers(page: Page) {
  return page.evaluate(() => {
    let gpu = 0;
    let dom = 0;
    for (const host of document.querySelectorAll("[data-testid='terminal']")) {
      if (host.querySelector("canvas") !== null) gpu++;
      else dom++;
    }
    return { gpu, dom };
  });
}

async function slide(page: Page, value: string, keep = false) {
  await page.getByTestId("background-cards").evaluate(
    (input: HTMLInputElement, { to, kept }) => {
      input.value = to;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (kept) input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { to: value, kept: keep },
  );
}

test("swaps the terminals' renderer as the share is kept, not while it is picked", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { appearance: "light", backgrounds: { teal: LAGOON } } });
  await page.goto("/");
  test.skip(!(await gpuHere(page)), "WebGL here is a software rasteriser, which gets the DOM renderer alone");
  for (let i = 1; i <= 3; i++) {
    await page.getByTestId("new-session").click();
    await expect.poll(() => renderers(page).then((r) => r.gpu + r.dom)).toBe(i);
  }
  await expect.poll(() => renderers(page)).toEqual({ gpu: 3, dom: 0 });

  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("background-picker")).toBeVisible();
  await slide(page, "12");
  await expect(page.locator("html")).toHaveAttribute("data-cards", "");
  await expect.poll(() => renderers(page)).toEqual({ gpu: 0, dom: 3 });

  // Drawn through none and back while picking: the DOM renderer stays.
  await slide(page, "0");
  await expect(page.locator("html")).not.toHaveAttribute("data-cards", "");
  expect(await renderers(page)).toEqual({ gpu: 0, dom: 3 });
  await slide(page, "16");
  expect(await renderers(page)).toEqual({ gpu: 0, dom: 3 });

  // None kept: the GPU renderer is back; a share kept: the DOM one.
  await slide(page, "0", true);
  await expect.poll(() => renderers(page)).toEqual({ gpu: 3, dom: 0 });
  await slide(page, "12", true);
  await expect.poll(() => renderers(page)).toEqual({ gpu: 0, dom: 3 });
});
