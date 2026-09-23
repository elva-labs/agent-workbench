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

/** Where the fake keeps the settings file the core would keep, in the
    page's storage so a reload finds it the way a restart finds the file. */
export const SETTINGS_FILE = "fake.settings";

export async function installFakeCore(
  page: Page,
  options: {
    open?: string[];
    opened?: string[];
    fixture?: GitFixture;
    /** A settings file already on the machine. */
    settings?: Record<string, unknown>;
  } = {},
) {
  await page.addInitScript(
    ({ open, opened, fixture, settings, settingsFile }) => {
      const state = { fixture, changed: null as unknown, opened };
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

      // The embedded browser's tabs, kept the way the Rust model keeps
      // them: ids from 1, never reused; opening activates; closing the
      // active tab activates its right neighbour, else its left.
      type FakeBrowserTab = {
        id: number;
        url: string;
        title: string;
        home: string | null;
        opener: { kind: "user" } | { kind: "agent"; session: string };
        loading: boolean;
        canGoBack: boolean;
        canGoForward: boolean;
        error: string | null;
      };

      const browserState = {
        tabs: [] as FakeBrowserTab[],
        active: null as number | null,
        nextId: 1,
        // Per-tab back/forward stack: the urls visited, and where in them
        // the tab now stands.
        histories: new Map<number, { stack: string[]; index: number }>(),
      };

      const browserSnapshot = () => ({
        tabs: browserState.tabs.map((tab) => ({ ...tab })),
        active: browserState.active,
      });

      const emitBrowserTabs = () => {
        const w = window as unknown as {
          __browserTabs?: (snapshot: unknown) => void;
        };
        w.__browserTabs?.(browserSnapshot());
      };

      // The tab a page-tool call names, or the active one for null.
      const resolveFakeTab = (id: number | null): FakeBrowserTab | undefined =>
        id === null
          ? browserState.tabs.find((tab) => tab.id === browserState.active)
          : browserState.tabs.find((tab) => tab.id === id);

      const hostOf = (url: string) => {
        try {
          return new URL(url).hostname;
        } catch {
          return url;
        }
      };

      // The scheme `input` names, if it names one at all: a colon followed
      // by digits and the end of the authority is a port, not a scheme.
      const explicitScheme = (input: string): string | null => {
        const slashes = input.indexOf("://");
        if (slashes !== -1) return input.slice(0, slashes);
        const colon = input.indexOf(":");
        if (colon === -1) return null;
        const after = input.slice(colon + 1);
        const digits = after.match(/^\d*/)![0];
        if (digits.length > 0) {
          const rest = after.slice(digits.length);
          if (rest === "" || /^[/?#]/.test(rest)) return null;
        }
        return input.slice(0, colon);
      };

      // `http` or `https` for a scheme-less address, by what its host looks
      // like: localhost, an IPv4 address, or a single name with a port get
      // plain http, and anything else with a dot gets https.
      const classifyHost = (input: string): string => {
        const authorityEnd = input.search(/[/?#]/);
        const authority = authorityEnd === -1 ? input : input.slice(0, authorityEnd);
        if (authority === "") throw new Error("not an address");
        const port = authority.match(/^(.+):(\d+)$/);
        const host = port ? port[1] : authority;
        const hasPort = port !== null;
        if (host === "") throw new Error("not an address");
        const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
        const local = host.toLowerCase() === "localhost" || isIPv4;
        if (local || (hasPort && !host.includes("."))) return "http";
        if (host.includes(".")) return "https";
        throw new Error("not an address");
      };

      // The same address rules the core applies, in a simplified form: no
      // search fallback, no scheme reads as http or https by the host's
      // shape, and anything else is refused with the reason to show.
      const normalizeBrowserAddress = (input: string): string => {
        const trimmed = input.trim();
        if (trimmed === "") throw new Error("enter an address");
        if (/\s/.test(trimmed)) throw new Error("not an address");
        const named = explicitScheme(trimmed);
        const scheme = named ?? classifyHost(trimmed);
        if (scheme.toLowerCase() !== "http" && scheme.toLowerCase() !== "https") {
          throw new Error("only http and https addresses open here");
        }
        const candidate = named !== null ? trimmed : `${scheme}://${trimmed}`;
        return new URL(candidate).href;
      };

      // A finished navigation: the url lands at once, the title becomes its
      // host, and the tab's history stack gains an entry, dropping whatever
      // was ahead of it.
      const browserNavigated = (tab: FakeBrowserTab, url: string) => {
        const history = browserState.histories.get(tab.id) ?? {
          stack: [],
          index: -1,
        };
        history.stack = history.stack.slice(0, history.index + 1);
        history.stack.push(url);
        history.index = history.stack.length - 1;
        browserState.histories.set(tab.id, history);
        tab.url = url;
        tab.title = hostOf(url);
        tab.loading = false;
        tab.error = null;
        tab.canGoBack = history.index > 0;
        tab.canGoForward = false;
      };

      type FakeSource = {
        id: string;
        kind: string;
        location: string;
        reference: string | null;
        commit: string | null;
        newer: string | null;
        error: string | null;
        known: boolean;
        plugins: Record<string, unknown>[];
      };

      /** A plugin the shipped list names and nothing has been fetched for:
          the name and the line, and nothing else. */
      const listed = (name: string, description: string) => ({
        name,
        path: "",
        description,
        version: "",
        run: [] as string[],
        build: [] as string[],
        tools: [] as string[],
        sections: [] as string[],
        view: null,
        enabled: false,
        state: "off",
        detail: null,
        hello: null,
      });

      /** The source the shipped list offers, as it stands unfetched. */
      const offered = (): FakeSource => ({
        id: "known-elva-labs",
        kind: "git",
        location: "https://github.com/elva-labs/agent-workbench-plugins",
        reference: "main",
        commit: null,
        newer: null,
        error: null,
        known: true,
        plugins: [
          listed(
            "todos",
            "The TODOs in the code, and notes to self, per project.",
          ),
          listed(
            "git",
            "The branch, what changed, the stashes and a graph of the log.",
          ),
        ],
      });

      const sources = (): FakeSource[] => {
        const w = window as unknown as { __pluginSources?: FakeSource[] };
        return (w.__pluginSources ??= [offered()]);
      };

      // The settings file, as the core keeps it: absent until the window
      // hands over its own copy or a change is made, checked the way the
      // core checks a change, and announced to the window on every change.
      if (settings !== null && localStorage.getItem(settingsFile) === null) {
        localStorage.setItem(settingsFile, JSON.stringify(settings));
      }
      const settingsDefaults = {
        appearance: "system",
        look: "modern",
        palette: "teal",
        terminalFont: "system",
        interfaceFont: "system",
        keys: {},
        hooks: { everywhere: true, overrides: {} },
      };
      const allowed: Record<string, string[]> = {
        appearance: ["system", "light", "dark"],
        look: ["modern", "terminal"],
        palette: ["teal", "indigo", "amber", "rose", "mono"],
        terminalFont: ["system", "plex", "jetbrains"],
        interfaceFont: ["system", "plex", "inter"],
      };
      const readSettings = (): Record<string, unknown> | null => {
        const raw = localStorage.getItem(settingsFile);
        return raw === null ? null : { ...settingsDefaults, ...JSON.parse(raw) };
      };
      const settingsChanged = (next: unknown) => {
        const w = window as unknown as {
          __settingsChanged?: (settings: unknown) => void;
          __settingsWrites?: unknown[];
        };
        (w.__settingsWrites ??= []).push(next);
        w.__settingsChanged?.(next);
      };

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
        // Where the window said its header's middle is, for a test to read.
        controlsCentre: async (centre: number) => {
          (
            window as unknown as { __controlsCentre?: number }
          ).__controlsCentre = centre;
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
        // Every size a pty is told, for a test to count the layouts its
        // terminal was measured in: a fit that changes nothing sends nothing.
        resize: async (id: string, cols: number, rows: number) => {
          const w = window as unknown as {
            __resizes?: { id: string; cols: number; rows: number }[];
          };
          (w.__resizes ??= []).push({ id, cols, rows });
        },
        kill: async () => {},
        ptyCwd: async () => null,
        // Plugin sources, kept here. The list the app ships offers one
        // source, unfetched, with its plugins named; a URL with "good" in
        // it adds a source of the user's own, anything else is refused.
        pluginSources: async () => {
          return sources();
        },
        pluginAdd: async (location: string, reference: string | null) => {
          if (!location.includes("good"))
            throw new Error("could not clone: repository not found");
          const own = sources().filter((s) => s.known !== true).length;
          const source = {
            id: `src-${own + 1}`,
            kind: location.startsWith("/") ? "dir" : "git",
            location,
            reference,
            commit: "0123456789abcdef",
            newer: null,
            error: null,
            known: false,
            plugins: [
              {
                name: "github",
                path: "github",
                description: "Pull requests, checks and review comments.",
                version: "0.2.0",
                run: ["node", "dist/main.js"],
                build: ["npm", "run", "build"],
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
          sources().push(source);
          return source;
        },
        // Fetching an offered source clones it: the manifest's word takes
        // the list's place, and its plugins are still off.
        pluginFetch: async (id: string) => {
          const source = sources().find((s) => s.id === id)!;
          source.commit = "0123456789abcdef";
          source.plugins = [
            {
              name: "todos",
              path: "plugins/todos",
              description:
                "The TODOs in the code, and notes to self, per project.",
              version: "0.1.0",
              run: ["node", "dist/main.js"],
              build: ["npm", "run", "build"],
              tools: ["list", "add", "finish"],
              sections: ["Todos", "Notes"],
              view: null,
              enabled: false,
              state: "off",
              detail: null,
              hello: null,
            },
            {
              name: "git",
              path: "plugins/git",
              description:
                "The branch, what changed, the stashes and a graph of the log.",
              version: "0.1.0",
              run: ["node", "dist/main.js"],
              build: ["npm", "run", "build"],
              tools: ["status", "commit", "log"],
              sections: ["Git", "Branches"],
              view: "full",
              enabled: false,
              state: "off",
              detail: null,
              hello: null,
            },
          ];
          return source;
        },
        // A source the list names is offered again once its clone is gone.
        pluginRemove: async (id: string) => {
          const w = window as unknown as { __pluginSources?: FakeSource[] };
          w.__pluginSources = sources().flatMap((s) =>
            s.id !== id ? [s] : s.known ? [offered()] : [],
          );
        },
        pluginCheck: async () => "fedcba9876543210",
        pluginUpdate: async (id: string) => {
          const source = sources().find((s) => s.id === id)!;
          source.commit = "fedcba9876543210";
          source.newer = null;
          return source;
        },
        pluginEnable: async (id: string, name: string, on: boolean) => {
          const source = sources().find((s) => s.id === id)!;
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
          // A test says as much of a section as it cares about; the rest
          // is what a plugin that says nothing gets.
          (window as unknown as Record<string, unknown>).__pluginSection = (
            sent: Record<string, unknown>,
          ) => handler({ detail: null, folded: false, order: 0, ...sent });
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
        onSessionEvent: async (
          handler: (event: { sessionId: string; kind: string }) => void,
        ) => {
          (
            window as unknown as {
              __sessionEvent?: (event: {
                sessionId: string;
                kind: string;
              }) => void;
            }
          ).__sessionEvent = handler;
          return () => {};
        },
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
        // The browser's own calls, pushed by a test through the handler,
        // and the window's answers, read back from the list.
        onBrowserRequest: async (handler: (request: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__browserRequest =
            handler;
          return () => {};
        },
        browserAnswer: async (
          id: string,
          cwd: string,
          content: string | null,
          error: string | null,
        ) => {
          const w = window as unknown as { __browserAnswers?: unknown[] };
          (w.__browserAnswers ??= []).push({ id, cwd, content, error });
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
        // Folders handed to the app from outside the window: the ones it
        // started with, and any a test hands over through
        // `__openRequested` while it runs.
        takeOpened: async () => state.opened.splice(0),
        onOpenRequested: async (handler: () => void) => {
          (window as unknown as Record<string, unknown>).__openRequested = (
            paths: string[],
          ) => {
            state.opened.push(...paths);
            handler();
          };
          return () => {};
        },
        onFileDrag: async (handler: (drag: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__fileDrag = handler;
          return () => {};
        },

        // The embedded browser: tabs kept in memory, with the address rules
        // and the history stack a real tab would have.
        browserOpen: async (url: string | null, session: string | null) => {
          const home = url === null ? null : normalizeBrowserAddress(url);
          const id = browserState.nextId++;
          const tab: FakeBrowserTab = {
            id,
            url: "about:blank",
            title: "",
            home,
            opener:
              session !== null ? { kind: "agent", session } : { kind: "user" },
            loading: false,
            canGoBack: false,
            canGoForward: false,
            error: null,
          };
          browserState.tabs.push(tab);
          browserState.histories.set(id, { stack: [], index: -1 });
          if (home !== null) browserNavigated(tab, home);
          browserState.active = id;
          emitBrowserTabs();
          return browserSnapshot();
        },
        browserClose: async (id: number) => {
          const index = browserState.tabs.findIndex((tab) => tab.id === id);
          if (index !== -1) {
            browserState.tabs.splice(index, 1);
            browserState.histories.delete(id);
            if (browserState.active === id) {
              const next = browserState.tabs[index] ?? browserState.tabs[index - 1];
              browserState.active = next ? next.id : null;
            }
          }
          emitBrowserTabs();
          return browserSnapshot();
        },
        browserActivate: async (id: number) => {
          if (browserState.tabs.some((tab) => tab.id === id)) {
            browserState.active = id;
          }
          emitBrowserTabs();
          return browserSnapshot();
        },
        browserNavigate: async (id: number, address: string) => {
          const tab = browserState.tabs.find((candidate) => candidate.id === id);
          if (tab === undefined) throw new Error("no such tab");
          const url = normalizeBrowserAddress(address);
          browserNavigated(tab, url);
          emitBrowserTabs();
        },
        browserBack: async (id: number) => {
          const tab = browserState.tabs.find((candidate) => candidate.id === id);
          if (tab === undefined) throw new Error("no such tab");
          const history = browserState.histories.get(id);
          if (history !== undefined && history.index > 0) {
            history.index -= 1;
            tab.url = history.stack[history.index];
            tab.title = hostOf(tab.url);
            tab.error = null;
            tab.canGoBack = history.index > 0;
            tab.canGoForward = true;
          }
          emitBrowserTabs();
        },
        browserForward: async (id: number) => {
          const tab = browserState.tabs.find((candidate) => candidate.id === id);
          if (tab === undefined) throw new Error("no such tab");
          const history = browserState.histories.get(id);
          if (history !== undefined && history.index < history.stack.length - 1) {
            history.index += 1;
            tab.url = history.stack[history.index];
            tab.title = hostOf(tab.url);
            tab.error = null;
            tab.canGoBack = true;
            tab.canGoForward = history.index < history.stack.length - 1;
          }
          emitBrowserTabs();
        },
        browserReload: async (id: number) => {
          const tab = browserState.tabs.find((candidate) => candidate.id === id);
          if (tab === undefined) throw new Error("no such tab");
          tab.error = null;
          emitBrowserTabs();
        },
        browserHome: async (id: number) => {
          const tab = browserState.tabs.find((candidate) => candidate.id === id);
          if (tab === undefined) throw new Error("no such tab");
          if (tab.home !== null) browserNavigated(tab, tab.home);
          emitBrowserTabs();
        },
        // Where the browser was last told to sit, and whether it is
        // showing, for a test to read back.
        browserPlace: async (
          x: number,
          y: number,
          width: number,
          height: number,
        ) => {
          (
            window as unknown as {
              __browser?: { rect: unknown; showing: boolean };
            }
          ).__browser = { rect: { x, y, width, height }, showing: true };
        },
        browserHide: async () => {
          const w = window as unknown as {
            __browser?: { rect: unknown; showing: boolean };
          };
          w.__browser = { rect: w.__browser?.rect ?? null, showing: false };
        },
        browserTabs: async () => browserSnapshot(),
        onBrowserTabs: async (handler: (snapshot: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__browserTabs =
            handler;
          return () => {};
        },
        // The chords the app currently claims, as the frontend last handed
        // them over, and the way a test fires a click landing in a tab's
        // webview: calling the handler `onBrowserFocused` stored here.
        browserKeys: async (chords: unknown) => {
          (window as unknown as Record<string, unknown>).__browserKeys =
            chords;
        },
        onBrowserFocused: async (handler: () => void) => {
          (window as unknown as Record<string, unknown>).__browserFocused =
            handler;
          return () => {};
        },
        // The page tools: there is no real page behind a fake tab, so each
        // answers with simple canned data keyed off the tab it was asked
        // about, enough to exercise the wiring from a browser tool's call
        // to its answer.
        browserSnapshot: async (id: number | null) => {
          const tab = resolveFakeTab(id);
          if (tab === undefined) throw new Error("no such tab");
          return `page ${tab.url}\n- link "Example" [ref=e1]`;
        },
        browserClick: async (id: number | null, ref: string) => {
          const tab = resolveFakeTab(id);
          if (tab === undefined) throw new Error("no such tab");
          if (ref !== "e1") throw new Error("no such element; take a new snapshot");
        },
        browserType: async (
          id: number | null,
          ref: string,
          _text: string,
          _submit: boolean,
        ) => {
          const tab = resolveFakeTab(id);
          if (tab === undefined) throw new Error("no such tab");
          if (ref !== "e1") throw new Error("no such element; take a new snapshot");
        },
        browserConsole: async (id: number | null) => {
          const tab = resolveFakeTab(id);
          if (tab === undefined) throw new Error("no such tab");
          return [
            { level: "log", text: `console for ${tab.url}`, time: Date.now(), url: tab.url },
          ];
        },
        browserScreenshot: async (id: number | null) => {
          const tab = resolveFakeTab(id);
          if (tab === undefined) throw new Error("no such tab");
          return `/tmp/workbench-browser/${tab.id}-fake.png`;
        },
        browserEval: async (id: number | null, script: string) => {
          const tab = resolveFakeTab(id);
          if (tab === undefined) throw new Error("no such tab");
          return JSON.stringify({ ran: script.length > 0, url: tab.url });
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
        settingsGet: async () => {
          const found = readSettings();
          return found === null
            ? { stored: false, settings: settingsDefaults }
            : { stored: true, settings: found };
        },
        settingsSet: async (change: Record<string, unknown>) => {
          for (const [field, value] of Object.entries(change)) {
            if (field in allowed) {
              if (!allowed[field].includes(value as string))
                throw new Error(`${field} is one of ${allowed[field].join(", ")}`);
            } else if (field !== "keys" && field !== "hooks") {
              throw new Error(`there is no setting called ${field}`);
            }
          }
          const next = { ...(readSettings() ?? settingsDefaults), ...change };
          localStorage.setItem(settingsFile, JSON.stringify(next));
          settingsChanged(next);
          return next;
        },
        // A test edits the file behind the window's back through this.
        onSettingsChanged: async (handler: (settings: unknown) => void) => {
          (window as unknown as Record<string, unknown>).__settingsChanged =
            handler;
          return () => {};
        },
      };
    },
    {
      open: options.open ?? [PROJECT],
      opened: options.opened ?? [],
      fixture: options.fixture ?? DEFAULT_FIXTURE,
      settings: options.settings ?? null,
      settingsFile: SETTINGS_FILE,
    },
  );
}
