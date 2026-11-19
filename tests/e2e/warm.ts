import { chromium, type FullConfig } from "@playwright/test";
import { installFakeCore } from "./fake";

/**
 * Runs once before the browser tests. The dev server answers as soon as it
 * listens, with a page that holds no app yet: it compiles the app's modules
 * when the first page asks for them, which on a cold server takes longer
 * than a test waits for a pane. This loads the app once and waits for its
 * panes, so every test meets a server that has the app ready.
 */
export default async function warm(config: FullConfig) {
  const origin = config.projects[0].use.baseURL!;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await installFakeCore(page);
    await page.goto(origin);
    await page.locator("section[data-pane='agent']").waitFor({ timeout: config.webServer?.timeout ?? 120_000 });
  } finally {
    await browser.close();
  }
}
