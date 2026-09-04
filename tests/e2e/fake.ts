import type { Page } from "@playwright/test";

/**
 * A fake core, installed at the seam `src/lib/core.ts` already checks.
 *
 * Shared by the specs that need the app populated but are not about the core
 * itself: the layout and the file tree both want a repository to look at, and
 * neither wants to emulate Tauri's IPC to get one.
 */

export const PROJECT = "/home/ada/dev/demo";

export interface GitFixture {
  status: { path: string; status: string; add: number; del: number; binary: boolean }[];
  files: string[];
}

/** Mirrors a repository mid-refactor: a rename in progress across three files. */
export const DEFAULT_FIXTURE: GitFixture = {
  status: [
    { path: "src/cache/mod.rs", status: "M", add: 18, del: 6, binary: false },
    { path: "src/lib.rs", status: "M", add: 2, del: 2, binary: false },
    { path: "src/token_cache.rs", status: "D", add: 0, del: 41, binary: false },
  ],
  files: [
    "Cargo.toml",
    "README.md",
    "docs/architecture.md",
    "docs/adapters.md",
    "src/adapter/acp.rs",
    "src/adapter/claude_code.rs",
    "src/adapter/mod.rs",
    "src/cache/eviction.rs",
    "src/cache/mod.rs",
    "src/cache/store.rs",
    "src/git/diff.rs",
    "src/git/status.rs",
    "src/git/watcher.rs",
    "src/lib.rs",
    "src/main.rs",
    "src/pty/env.rs",
    "src/pty/mod.rs",
    "tests/git_status.rs",
  ],
};

export async function installFakeCore(
  page: Page,
  options: { open?: string[]; fixture?: GitFixture } = {},
) {
  await page.addInitScript(
    ({ open, fixture }) => {
      const state = { fixture, changed: null as unknown };
      (window as unknown as Record<string, unknown>).__fixture = state;

      if (open.length > 0) {
        localStorage.setItem(
          "workbench.workspace",
          JSON.stringify({ open, active: open[0], recent: open }),
        );
      } else {
        localStorage.removeItem("workbench.workspace");
      }

      let ptyCount = 0;
      (window as unknown as { __WORKBENCH_CORE__: unknown }).__WORKBENCH_CORE__ = {
        detect: async () => ({
          id: "claude-code",
          path: "/usr/local/bin/claude",
          caps: null,
          fromLoginShell: true,
        }),
        pickProject: async () => null,
        projectInfo: async (path: string) => ({
          path,
          name: path.split("/").filter(Boolean).pop() ?? path,
          repository: path,
          isGit: true,
        }),
        setWindowTitle: async () => {},
        spawn: async (spawnOptions: { session?: string }) => ({
          ptyId: `pty-${++ptyCount}`,
          sessionId: spawnOptions.session ?? `session-${ptyCount}`,
        }),
        spawnShell: async () => `pty-${++ptyCount}`,
        write: async () => {},
        resize: async () => {},
        kill: async () => {},
        ptyCwd: async () => null,
        onSessionEnded: async () => () => {},
        onFileDrag: async (handler: (drag: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__fileDrag = handler;
          return () => {};
        },

        transcripts: async () => [],
        hookStatus: async () => ({ installed: false, settings: "", events: "" }),
        hookInstall: async () => ({ installed: true, settings: "", events: "" }),
        hookUninstall: async () => ({ installed: false, settings: "", events: "" }),
        gitStatus: async () => state.fixture.status,
        gitFiles: async () => state.fixture.files,
        gitDiff: async (_root: string, file: string) => ({
          lines: [
            { kind: "hunk", text: "@@ -1,9 +1,12 @@", old: null, new: null },
            { kind: "ctx", text: "use std::collections::HashMap;", old: 1, new: 1 },
            { kind: "del", text: "pub struct TokenCache {", old: 4, new: null },
            { kind: "add", text: "pub struct Cache {", old: null, new: 5 },
            { kind: "add", text: `// ${file}`, old: null, new: 6 },
          ],
          binary: false,
          truncated: false,
        }),
        gitContent: async (_root: string, file: string) => ({
          lines: ["use std::collections::HashMap;", "", `// ${file}`],
          binary: false,
          truncated: false,
        }),
        gitWatch: async () => {},
        onGitChanged: async (handler: () => void) => {
          (window as unknown as Record<string, unknown>).__gitChanged = handler;
          return () => {};
        },
      };
    },
    { open: options.open ?? [PROJECT], fixture: options.fixture ?? DEFAULT_FIXTURE },
  );
}
