import { defineConfig } from "vitest/config";

/** The WebDriver tier: one app per file, tests in order, generous timeouts. */
export default defineConfig({
  test: {
    include: ["tests/driver/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 180_000,
    reporters: process.env.CI ? ["default", "github-actions"] : ["default"],
  },
});
