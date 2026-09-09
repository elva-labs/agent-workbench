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
  status: {
    path: string;
    status: string;
    add: number;
    del: number;
    binary: boolean;
  }[];
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
      const remotes = { reachable: new Set(["lab", "ada@lab"]) };

      if (open.length > 0) {
        localStorage.setItem(
          "workbench.workspace",
          JSON.stringify({ open, active: open[0], recent: open }),
        );
      } else {
        localStorage.removeItem("workbench.workspace");
      }
      // A workspace on record with no hooks choice reads as a setup from
      // before the choice, which is told about hooks once: taken as read
      // here, unless a test or the app has said, so the word does not sit
      // over the agent pane in every test.
      if (localStorage.getItem("workbench.notices") === null) {
        localStorage.setItem(
          "workbench.notices",
          JSON.stringify({ hooks: "dismissed" }),
        );
      }

      let ptyCount = 0;
      (
        window as unknown as { __WORKBENCH_CORE__: unknown }
      ).__WORKBENCH_CORE__ = {
        detect: async (agent: string) => ({
          id: agent,
          path: agent === "claude-code" ? "/usr/local/bin/claude" : null,
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
        openUrl: async () => {},
        windowControl: async (action: string) => {
          const w = window as unknown as { __windowControls?: string[] };
          (w.__windowControls ??= []).push(action);
        },
        openAppMenu: async () => {
          const w = window as unknown as { __windowControls?: string[] };
          (w.__windowControls ??= []).push("menu");
        },
        setBadge: async () => {},
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
        onSessionIdentified: async () => () => {},
        onSessionEvent: async () => () => {},
        onShowRequest: async (handler: (request: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__showRequest =
            handler;
          return () => {};
        },
        onPresentRequest: async (handler: (request: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__presentRequest =
            handler;
          return () => {};
        },
        onDiffRequest: async (handler: (request: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__diffRequest =
            handler;
          return () => {};
        },
        // The record of what is on screen, for a test to read back.
        setSelection: async (project: string, selection: unknown) => {
          (window as unknown as Record<string, unknown>).__selection = {
            project,
            selection,
          };
        },
        // One pixel of PNG for any image asked for; a PDF as itself; a
        // path with "missing" in it is not there.
        readMedia: async (path: string) => {
          if (path.includes("missing"))
            throw new Error(`could not read ${path}: No such file`);
          if (path.endsWith(".pdf"))
            return { mime: "application/pdf", data: "JVBERi0=", size: 5 };
          if (path.endsWith(".md"))
            return {
              mime: "text/markdown",
              data: btoa("# Draft\n\nHello *there*, <b>plain</b>.\n"),
              size: 30,
            };
          return {
            mime: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
            size: 70,
          };
        },

        // Two ways in: `lab`, which the user's own ssh setup reaches, and a
        // token from a machine's `agent-workbench-remote connect`.
        remoteHosts: async () => ({ configured: ["lab", "work"], saved: [] }),
        remoteConnect: async (target: string) => {
          if (!remotes.reachable.has(target)) {
            throw new Error(
              `ssh: Could not resolve hostname ${target}: Name or service not known`,
            );
          }
          return { host: target, version: "0.1.0" };
        },
        remotePair: async (token: string) => {
          if (token !== "awb1.demo")
            throw new Error("the token is not whole; copy all of it");
          remotes.reachable.add("ada@lab.example");
          return { host: "ada@lab.example", version: "0.1.0" };
        },
        remoteDirs: async (target: string, path: string) => {
          const base = path === "" ? `ssh://${target}/home/ada` : path;
          const names = base.endsWith("/home/ada")
            ? ["dev", "notes"]
            : base.endsWith("/dev")
              ? ["demo", "tools"]
              : [];
          return {
            path: base,
            dirs: names.map((name) => ({ name, path: `${base}/${name}` })),
          };
        },
        remoteDisconnect: async () => {},
        remoteForget: async () => {},
        onRemoteClosed: async (handler: (closed: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__remoteClosed =
            handler;
          return () => {};
        },
        onOpenSettings: async (handler: () => void) => {
          (window as unknown as Record<string, unknown>).__openSettings =
            handler;
          return () => {};
        },
        onFileDrag: async (handler: (drag: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__fileDrag = handler;
          return () => {};
        },

        transcripts: async () => [],
        sessionTitle: async () => null,
        hookStatus: async () => ({
          installed: false,
          settings: "",
          events: "",
        }),
        hookInstall: async () => ({
          installed: true,
          settings: "",
          events: "",
        }),
        hookUninstall: async () => ({
          installed: false,
          settings: "",
          events: "",
        }),
        gitStatus: async () => state.fixture.status,
        gitFiles: async () => state.fixture.files,
        // A search over what the fixture's viewer shows: every listed file
        // "contains" the shared header line, and the cache module a struct.
        gitGrep: async (_root: string, query: string, scope: string) => {
          const q = query.toLowerCase();
          const paths =
            scope === "changed"
              ? state.fixture.status.map((f) => f.path)
              : state.fixture.files;
          const hits: { path: string; line: number; text: string }[] = [];
          for (const path of paths) {
            if ("use std::collections::hashmap;".includes(q)) {
              hits.push({
                path,
                line: 1,
                text: "use std::collections::HashMap;",
              });
            }
            if (
              path === "src/cache/mod.rs" &&
              "pub struct cache {".includes(q)
            ) {
              hits.push({ path, line: 3, text: "pub struct Cache {" });
            }
          }
          return { hits, truncated: q === "flood" };
        },
        gitDiff: async (_root: string, file: string) => ({
          lines: [
            { kind: "hunk", text: "@@ -1,9 +1,12 @@", old: null, new: null },
            {
              kind: "ctx",
              text: "use std::collections::HashMap;",
              old: 1,
              new: 1,
            },
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
    {
      open: options.open ?? [PROJECT],
      fixture: options.fixture ?? DEFAULT_FIXTURE,
    },
  );
}
