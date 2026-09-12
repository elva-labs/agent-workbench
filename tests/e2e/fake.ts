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
        spawn: async (
          spawnOptions: { session?: string },
          onOutput: (bytes: Uint8Array) => void,
        ) => {
          const ptyId = `pty-${++ptyCount}`;
          // What each spawn asked for, and a way for a test to put bytes on
          // a session's terminal, __say.
          const w = window as unknown as {
            __spawns?: unknown[];
            __say?: (id: string, text: string) => void;
            __outputs?: Record<string, (bytes: Uint8Array) => void>;
          };
          (w.__spawns ??= []).push({ ...spawnOptions, ptyId });
          (w.__outputs ??= {})[ptyId] = onOutput;
          w.__say ??= (id, text) =>
            w.__outputs?.[id]?.(new TextEncoder().encode(text));
          return {
            ptyId,
            sessionId: spawnOptions.session ?? `session-${ptyCount}`,
          };
        },
        // A shell draws its prompt a moment after it is up.
        spawnShell: async (
          _options: unknown,
          onOutput: (bytes: Uint8Array) => void,
        ) => {
          setTimeout(() => onOutput(new TextEncoder().encode("$ ")), 20);
          return `pty-${++ptyCount}`;
        },
        // What was written to a pty, for a test to read back.
        write: async (id: string, data: string) => {
          const w = window as unknown as { __written?: [string, string][] };
          (w.__written ??= []).push([id, data]);
        },
        resize: async () => {},
        kill: async () => {},
        ptyCwd: async () => null,
        // Plugin sources, kept here: a URL with "good" in it adds a source
        // with one plugin, anything else is refused.
        pluginSources: async () => {
          const w = window as unknown as { __pluginSources?: unknown[] };
          return w.__pluginSources ?? [];
        },
        pluginAdd: async (location: string, reference: string | null) => {
          const w = window as unknown as {
            __pluginSources?: Record<string, unknown>[];
          };
          if (!location.includes("good"))
            throw new Error("could not clone: repository not found");
          const source = {
            id: `src-${(w.__pluginSources ?? []).length + 1}`,
            kind: location.startsWith("/") ? "dir" : "git",
            location,
            reference,
            commit: "0123456789abcdef",
            newer: null,
            error: null,
            plugins: [
              {
                name: "github",
                path: "github",
                description: "Pull requests, checks and review comments.",
                version: "0.2.0",
                run: ["node", "main.js"],
                tools: ["pr", "checks"],
                sections: ["Pull request"],
                view: "wide",
                enabled: false,
                state: "off",
                detail: null,
                hello: null,
              },
            ],
          };
          (w.__pluginSources ??= []).push(source);
          return source;
        },
        pluginRemove: async (id: string) => {
          const w = window as unknown as { __pluginSources?: { id: string }[] };
          w.__pluginSources = (w.__pluginSources ?? []).filter(
            (s) => s.id !== id,
          );
        },
        pluginCheck: async () => "fedcba9876543210",
        pluginUpdate: async (id: string) => {
          const w = window as unknown as {
            __pluginSources?: Record<string, unknown>[];
          };
          const source = (w.__pluginSources ?? []).find((s) => s.id === id)!;
          source.commit = "fedcba9876543210";
          source.newer = null;
          return source;
        },
        pluginEnable: async (id: string, name: string, on: boolean) => {
          const w = window as unknown as {
            __pluginSources?: {
              id: string;
              plugins: Record<string, unknown>[];
            }[];
          };
          const source = (w.__pluginSources ?? []).find((s) => s.id === id)!;
          const plugin = source.plugins.find((p) => p.name === name)!;
          plugin.enabled = on;
          plugin.state = on ? "starting" : "off";
          return source;
        },
        // Every set of open projects the window sent, for a test to read
        // back.
        pluginProjects: async (paths: string[]) => {
          const w = window as unknown as { __pluginProjects?: string[][] };
          (w.__pluginProjects ??= []).push(paths);
        },
        onPluginState: async (handler: (event: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__pluginState =
            handler;
          return () => {};
        },
        onPluginSection: async (handler: (event: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__pluginSection =
            handler;
          return () => {};
        },
        onPluginNotice: async (handler: (event: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__pluginNotice =
            handler;
          return () => {};
        },
        onPluginView: async (handler: (event: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__pluginView = handler;
          return () => {};
        },
        onPluginViewData: async (handler: (event: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__pluginViewData =
            handler;
          return () => {};
        },
        // Every message a plugin's page sent, for a test to read back.
        pluginViewMessage: async (request: unknown) => {
          const w = window as unknown as { __pluginViewMessages?: unknown[] };
          (w.__pluginViewMessages ??= []).push(request);
        },
        // Every action taken, for a test to read back. "explode" is the one
        // a plugin is never running for.
        pluginAction: async (request: { action: string }) => {
          const w = window as unknown as { __pluginActions?: unknown[] };
          (w.__pluginActions ??= []).push(request);
          if (request.action === "explode")
            throw new Error("the plugin is not running");
        },
        // What runs under a pty: whatever a test put there.
        ptyProcesses: async (id: string) => {
          const w = window as unknown as {
            __processes?: Record<string, unknown[]>;
          };
          return w.__processes?.[id] ?? [];
        },
        stopProcess: async (id: string, pid: number) => {
          const w = window as unknown as {
            __processes?: Record<string, { pid: number }[]>;
            __stopped?: [string, number][];
          };
          (w.__stopped ??= []).push([id, pid]);
          if (w.__processes?.[id])
            w.__processes[id] = w.__processes[id].filter((p) => p.pid !== pid);
        },
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
        onTerminalRequest: async (handler: (request: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__terminalRequest =
            handler;
          return () => {};
        },
        onNotifyRequest: async (handler: (request: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__notifyRequest =
            handler;
          return () => {};
        },
        // The conductor's calls, pushed by a test through the handler, and
        // the window's answers, read back from the list.
        onConductRequest: async (handler: (request: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__conductRequest =
            handler;
          return () => {};
        },
        conductAnswer: async (
          id: string,
          cwd: string,
          content: string | null,
          error: string | null,
        ) => {
          const w = window as unknown as { __conductAnswers?: unknown[] };
          (w.__conductAnswers ??= []).push({ id, cwd, content, error });
        },
        worktreeAdd: async (project: string, name: string) =>
          `${project}/.claude/worktrees/${name}`,
        orchestratorDir: async () => "/home/ada/.agent-workbench/orchestrator",
        // The worktrees a test has put under a project, in __worktrees by
        // project; removing one takes it out of the list.
        worktrees: async (project: string) => {
          const w = window as unknown as {
            __worktrees?: Record<string, { name: string }[]>;
          };
          return w.__worktrees?.[project] ?? [];
        },
        worktreeRemove: async (project: string, name: string) => {
          const w = window as unknown as {
            __worktrees?: Record<
              string,
              { name: string; merged: boolean; dirty: boolean }[]
            >;
          };
          const list = w.__worktrees?.[project] ?? [];
          const tree = list.find((t) => t.name === name);
          if (tree === undefined) throw new Error(`no worktree ${name}`);
          if (tree.dirty || !tree.merged)
            throw new Error(`${name} has work in it`);
          w.__worktrees![project] = list.filter((t) => t.name !== name);
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
          if (path.endsWith(".html"))
            return {
              mime: "text/html",
              data: btoa(
                "<h1 id='page'>A page</h1><script>document.body.appendChild(Object.assign(document.createElement('p'),{id:'ran',textContent:'ran'}))</script>",
              ),
              size: 100,
            };
          if (path.endsWith(".mmd"))
            return {
              mime: "text/vnd.mermaid",
              data: btoa("graph TD; A[Start] --> B[End]"),
              size: 28,
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
