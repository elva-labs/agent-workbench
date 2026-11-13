import { defineConfig, devices } from "@playwright/test";
import { devPort } from "./dev-port.js";

/**
 * End-to-end tests run against the real Vite dev server in a real browser.
 *
 * This is the tier that verifies the app as a user meets it: panes drag, the
 * keyboard model holds, layout survives a restart. It stops at the Tauri IPC
 * boundary, which has nothing behind it until phase 1; when the PTY lands, a
 * second tier on tauri-driver drives the packaged binary. See tests/e2e/README.
 */
// WORKBENCH_DEV_PORT moves the dev server off the default port. When it is
// set, a server already answering there is an error, never a server to reuse.
const { port, custom: customPort } = devPort();
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: origin,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: origin,
    reuseExistingServer: !process.env.CI && !customPort,
    timeout: 120_000,
  },
});
