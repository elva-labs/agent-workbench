import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { devPort } from "./dev-port.js";

const host = process.env.TAURI_DEV_HOST;

// The dev server's port. WORKBENCH_DEV_PORT overrides it for browser test runs
// from a second checkout; the HMR port is the one after it.
const { port } = devPort();

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],

  // The webviews the app runs in all speak ES2022. Lowering the syntax for
  // older engines rewrites xterm's `x ||= {}` into a form the bundler then
  // tree-shakes wrongly, leaving an assignment to a variable it removed,
  // and the terminal dies on the first DECRQM query a TUI sends.
  build: {
    target: "es2022",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
