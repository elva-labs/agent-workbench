import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * A presented HTML page loads the files in its own folder and nothing
 * else. The fake core gives the page a base address of the form the app
 * serves a page's folder at on Windows, and this spec answers for that
 * address with a route, as the app's protocol answers for it: a request
 * that reaches the route at all was let through by the page's policy.
 */

const PAGE = `${PROJECT}/out/report.html`;
const BASE = `http://awb-page.localhost/${Buffer.from(PAGE).toString("base64").replace(/[^a-z0-9]/gi, "")}/`;
const SHOT = "after-owner-modern-dark-100-window.jpg";

/** A screenshot's shape, 1600 by 1000. */
const SHOT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#3f56b5"/></svg>';

/** One red pixel. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const HTML = `<!doctype html>
<html><head><style>img{display:block;width:240px;height:60px}</style></head><body>
<h1 id="page">Shots</h1>
<img id="beside" src="${SHOT}">
<img id="under" src="shots/b%20c.png">
<a id="full" href="${SHOT}"><img id="thumb" src="${SHOT}"></a>
<img id="remote" src="https://remote.example/r.png">
<img id="above" src="../secret.png">
<img id="gone" src="gone.png">
<a id="web" href="https://remote.example/">the web</a>
<p id="fetch">waiting</p><p id="canvas">waiting</p>
<script>
addEventListener("load", function () {
  fetch("${SHOT}").then(function () { document.getElementById("fetch").textContent = "read"; },
    function () { document.getElementById("fetch").textContent = "blocked"; });
  var c = document.createElement("canvas"), g = c.getContext("2d");
  g.drawImage(document.getElementById("beside"), 0, 0);
  try { g.getImageData(0, 0, 1, 1); document.getElementById("canvas").textContent = "read"; }
  catch (e) { document.getElementById("canvas").textContent = "tainted"; }
});
</script>
</body></html>`;

/** What reached the network, and what reached the page's folder. */
async function serve(page: Page) {
  const asked = { files: [] as string[], remote: [] as string[] };
  await page.route("http://awb-page.localhost/**", (route) => {
    const url = route.request().url();
    asked.files.push(url);
    if (url === `${BASE}${SHOT}`) return route.fulfill({ contentType: "image/svg+xml", body: SHOT_SVG });
    if (url === `${BASE}shots/b%20c.png`) return route.fulfill({ contentType: "image/png", body: PNG });
    return route.fulfill({ status: 404, contentType: "text/plain", body: "is not there" });
  });
  await page.route("https://remote.example/**", (route) => {
    asked.remote.push(route.request().url());
    return route.fulfill({ contentType: "image/png", body: PNG });
  });
  return asked;
}

test.beforeEach(async ({ page }) => {
  await installFakeCore(page);
  await page.addInitScript(
    ([path, html]) => {
      const w = window as unknown as Record<string, unknown>;
      w.__pages = { [path]: html };
      w.__pageRefusals = { "gone.png": "is not there" };
    },
    [PAGE, HTML],
  );
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
});

async function present(page: Page) {
  await page.evaluate(
    ([path, cwd]) =>
      (window as unknown as { __presentRequest: (request: unknown) => void }).__presentRequest({
        files: [path],
        caption: "The shots.",
        cwd,
      }),
    [PAGE, PROJECT],
  );
}

/** Whether an image in the page loaded, failed and was drawn over with
    why, or neither yet. */
const shown = (page: Page, id: string) =>
  page
    .frameLocator("[data-testid='media-page']")
    .frameLocator("iframe")
    .locator(`#${id}`)
    .evaluate((img: HTMLImageElement) =>
      img.src.startsWith("data:") ? "why" : img.complete && img.naturalWidth > 0 ? "loaded" : "not yet",
    );

test("loads the images in the page's folder and nothing from above it or the web", async ({
  page,
}) => {
  const asked = await serve(page);
  await present(page);
  const inner = page.frameLocator("[data-testid='media-page']").frameLocator("iframe");
  await expect(inner.locator("#page")).toHaveText("Shots");

  // Beside the page, in a folder under it, and inside a link.
  await expect.poll(() => shown(page, "beside")).toBe("loaded");
  await expect.poll(() => shown(page, "under")).toBe("loaded");
  await expect.poll(() => shown(page, "thumb")).toBe("loaded");

  // A script reads none of their bytes: it cannot fetch, and an image it
  // draws taints the canvas.
  await expect(inner.locator("#fetch")).toHaveText("blocked");
  await expect(inner.locator("#canvas")).toHaveText("tainted");

  // The rest is said under the page, and in place of each image.
  const missed = page.getByTestId("media-page-missed");
  await expect(missed).toContainText("../secret.png is outside the page's folder");
  await expect(missed).toContainText(
    "https://remote.example/r.png is on the network, which a presented page does not reach",
  );
  await expect(missed).toContainText("gone.png is not there");
  for (const id of ["remote", "above", "gone"]) {
    await expect.poll(() => shown(page, id)).toBe("why");
    await expect(inner.locator(`#${id}`)).toHaveAttribute("title", /is (outside|on the network|not there)/);
  }

  // Nothing reached the web, and nothing above the page's own folder was
  // asked for: the policy stopped both before a request was made.
  expect(asked.remote).toEqual([]);
  expect(asked.files.filter((url) => !url.startsWith(BASE))).toEqual([]);
  expect(asked.files).toContain(`${BASE}${SHOT}`);
});

test("opens a linked image over the window and leaves a link to the web closed", async ({
  page,
}) => {
  const asked = await serve(page);
  await present(page);
  const inner = page.frameLocator("[data-testid='media-page']").frameLocator("iframe");
  await expect.poll(() => shown(page, "thumb")).toBe("loaded");

  await inner.locator("#full").click();
  const opened = page.getByTestId("media-page-opened");
  await expect(opened).toBeVisible();
  await expect(opened).toContainText(SHOT);
  const big = opened.locator("img");
  await expect(big).toHaveAttribute("src", `${BASE}${SHOT}`);
  await expect.poll(() => big.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600);
  // Fitted to the window, whole, and in the middle of it.
  const box = (await big.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.width).toBeGreaterThan(view.width / 2);
  expect(box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThan(2);

  // Escape puts it away and leaves the page as it was, in the viewer.
  await page.keyboard.press("Escape");
  await expect(opened).toHaveCount(0);
  await expect(page.getByTestId("media-stack")).toBeVisible();
  await expect(inner.locator("#page")).toHaveText("Shots");

  // A link to the web goes nowhere, and says so.
  await inner.locator("#web").click();
  await expect(page.getByTestId("media-page-missed")).toContainText(
    "https://remote.example/ is a link to the web, which a presented page does not open",
  );
  await expect(inner.locator("#page")).toHaveText("Shots");
  expect(asked.remote).toEqual([]);

  // A script cannot open one on its own: only a page the user is in can.
  // The miss posted after it is listed once the window has read both.
  await page.getByTestId("media-caption").click();
  await inner.locator("#page").evaluate((_, shot) => {
    parent.parent.postMessage({ workbenchOpen: shot }, "*");
    parent.parent.postMessage(
      { workbenchMissed: { url: "https://remote.example/after.png", how: "failed", said: null } },
      "*",
    );
  }, SHOT);
  await expect(page.getByTestId("media-page-missed")).toContainText("https://remote.example/after.png");
  await expect(opened).toHaveCount(0);
});
