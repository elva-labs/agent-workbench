import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import path from "node:path";

// Unit and component tests run against the Svelte components directly rather
// than through SvelteKit: there is no router to exercise, and skipping the kit
// plugin keeps $lib the only alias the tests need.
export default defineConfig({
  plugins: [svelte({ hot: false }), svelteTesting()],
  resolve: {
    alias: {
      $lib: path.resolve("./src/lib"),
    },
    conditions: ["browser"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.{ts,svelte}"],
      exclude: ["src/lib/styles/**"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
