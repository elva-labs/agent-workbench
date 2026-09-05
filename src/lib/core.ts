import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl as openWithSystem } from "@tauri-apps/plugin-opener";

/**
 * The one place the frontend talks to the Rust core.
 *
 * Everything else in `src/lib` is pure or renders; this module is the seam. It
 * exists as an interface rather than as scattered `invoke` calls for two
 * reasons: the shape of the core is worth stating in one place, and the
 * end-to-end tests can stand a fake behind it and drive the terminal for real
 * without emulating Tauri's internals.
 */

/** The agents the core knows how to drive. */
export type AgentId = "claude-code" | "codex";

export interface DetectReport {
  id: string;
  path: string | null;
  caps: { resumable: boolean; titles: boolean; acp: boolean } | null;
  /** False when the login shell could not be read, which changes what a
      missing binary means. */
  fromLoginShell: boolean;
}

export interface SpawnOptions {
  agent: AgentId;
  project: string;
  /** Resume an existing session rather than starting a new one. */
  session?: string;
  cols: number;
  rows: number;
}

/** What starting a session hands back: the pty to talk to, and the session id
    the agent was told to use, which is what resuming takes later. Null for an
    agent that mints its own id; `onSessionIdentified` reports it once the
    agent has written it down. */
export interface Spawned {
  ptyId: string;
  sessionId: string | null;
}

export interface SessionIdentified {
  ptyId: string;
  sessionId: string;
  title: string | null;
}

/** A plain shell for the terminal panel: the user's own, started in the
    project directory with the same environment the agent gets. */
export interface ShellOptions {
  project: string;
  cols: number;
  rows: number;
}

export interface ProjectInfo {
  path: string;
  name: string;
  repository: string | null;
  isGit: boolean;
}

export interface ChangedFile {
  path: string;
  status: string;
  add: number;
  del: number;
  binary: boolean;
}

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  old: number | null;
  new: number | null;
}

export interface FileDiff {
  lines: DiffLine[];
  binary: boolean;
  truncated: boolean;
}

export interface FileContent {
  lines: string[];
  binary: boolean;
  truncated: boolean;
}

export interface Transcript {
  /** The Claude Code session id, which is what `claude --resume` takes. */
  id: string;
  /** Seconds since the epoch. */
  modified: number;
  size: number;
  /** Absent when the transcript format moved: a missing title, not an error. */
  title: string | null;
}

export interface HookStatus {
  installed: boolean;
  settings: string;
  events: string;
}

export interface SessionEnded {
  id: string;
  code: number | null;
  clean: boolean;
}

/** A file drag over the window, in CSS pixels from the webview's top left. */
export type FileDrag =
  | { type: "over"; x: number; y: number }
  | { type: "drop"; paths: string[]; x: number; y: number }
  | { type: "leave" };

export interface Core {
  detect(agent: string): Promise<DetectReport>;
  /** Opens the native folder picker. Null when the user cancels. */
  pickProject(): Promise<string | null>;
  projectInfo(path: string): Promise<ProjectInfo>;
  setWindowTitle(title: string): Promise<void>;
  /** Opens a link in the system browser. */
  openUrl(url: string): Promise<void>;
  spawn(options: SpawnOptions, onOutput: (bytes: Uint8Array) => void): Promise<Spawned>;
  /** Resolves to the pty id. Ended like a session, through `onSessionEnded`. */
  spawnShell(options: ShellOptions, onOutput: (bytes: Uint8Array) => void): Promise<string>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  /** Where the process is working now. Null when the OS will not say. */
  ptyCwd(id: string): Promise<string | null>;
  onSessionEnded(handler: (ended: SessionEnded) => void): Promise<() => void>;
  /** An agent that mints its own ids has written one down for a session. */
  onSessionIdentified(handler: (identified: SessionIdentified) => void): Promise<() => void>;
  /** Files dragged over and dropped on the window. The webview never gets
      the DOM events for these; the window takes them and reports paths. */
  onFileDrag(handler: (drag: FileDrag) => void): Promise<() => void>;
  /** Settings was chosen from the native menu. */
  onOpenSettings(handler: () => void): Promise<() => void>;

  /** Sessions the agent already has on disk for this project, newest first. */
  transcripts(project: string, agent: AgentId): Promise<Transcript[]>;
  /** What the agent calls a session now, for agents that keep that in an
      index of their own rather than in the terminal title. */
  sessionTitle(agent: AgentId, id: string): Promise<string | null>;

  hookStatus(project: string): Promise<HookStatus>;
  hookInstall(project: string): Promise<HookStatus>;
  hookUninstall(project: string): Promise<HookStatus>;

  gitStatus(root: string): Promise<ChangedFile[]>;
  gitFiles(root: string): Promise<string[]>;
  gitDiff(root: string, file: string): Promise<FileDiff>;
  gitContent(root: string, file: string): Promise<FileContent>;
  /** Starts watching a worktree, replacing whatever was watched before. */
  gitWatch(root: string): Promise<void>;
  onGitChanged(handler: (root: string) => void): Promise<() => void>;
}

/**
 * Normalises whatever the channel hands us into bytes.
 *
 * Tauri sends `InvokeResponseBody::Raw` over the raw IPC path, and the exact
 * JavaScript shape is not something the docs pin down: it can arrive as an
 * ArrayBuffer, as a typed array, or as a plain array of numbers depending on
 * the platform's IPC transport. Accepting all three costs a few lines and
 * removes a class of platform-specific bug.
 */
export function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(payload)) return Uint8Array.from(payload as number[]);
  return new Uint8Array();
}

const tauriCore: Core = {
  detect: (agent) => invoke<DetectReport>("agent_detect", { id: agent }),

  async pickProject() {
    const chosen = await openDialog({ directory: true, multiple: false, title: "Open project" });
    return typeof chosen === "string" ? chosen : null;
  },

  projectInfo: (path) => invoke<ProjectInfo>("project_info", { path }),

  async setWindowTitle(title) {
    await getCurrentWindow().setTitle(title);
  },

  openUrl: (url) => openWithSystem(url),

  async spawn(options, onOutput) {
    const channel = new Channel<unknown>();
    channel.onmessage = (message) => onOutput(toBytes(message));
    return invoke<Spawned>("pty_spawn", { ...options, onOutput: channel });
  },

  async spawnShell(options, onOutput) {
    const channel = new Channel<unknown>();
    channel.onmessage = (message) => onOutput(toBytes(message));
    return invoke<string>("pty_shell", { ...options, onOutput: channel });
  },

  write: (id, data) => invoke("pty_write", { id, data }),
  resize: (id, cols, rows) => invoke("pty_resize", { id, cols, rows }),
  kill: (id) => invoke("pty_kill", { id }),
  ptyCwd: (id) => invoke<string | null>("pty_cwd", { id }),

  async onSessionEnded(handler) {
    return listen<SessionEnded>("session_ended", (event) => handler(event.payload));
  },

  async onSessionIdentified(handler) {
    return listen<SessionIdentified>("session_identified", (event) => handler(event.payload));
  },

  async onOpenSettings(handler) {
    return listen("open_settings", () => handler());
  },

  async onFileDrag(handler) {
    return getCurrentWebview().onDragDropEvent((event) => {
      const drag = event.payload;
      if (drag.type === "leave") {
        handler({ type: "leave" });
        return;
      }
      // Tauri reports physical pixels; the DOM thinks in CSS pixels.
      const scale = window.devicePixelRatio || 1;
      const x = drag.position.x / scale;
      const y = drag.position.y / scale;
      if (drag.type === "drop") handler({ type: "drop", paths: drag.paths, x, y });
      else handler({ type: "over", x, y });
    });
  },

  transcripts: (project, agent) => invoke<Transcript[]>("sessions_list", { project, agent }),
  sessionTitle: (agent, id) => invoke<string | null>("session_title", { agent, id }),

  hookStatus: (project) => invoke<HookStatus>("hook_status", { project }),
  hookInstall: (project) => invoke<HookStatus>("hook_install", { project }),
  hookUninstall: (project) => invoke<HookStatus>("hook_uninstall", { project }),

  gitStatus: (root) => invoke<ChangedFile[]>("git_status", { root }),
  gitFiles: (root) => invoke<string[]>("git_files", { root }),
  gitDiff: (root, file) => invoke<FileDiff>("git_diff", { root, file }),
  gitContent: (root, file) => invoke<FileContent>("git_content", { root, file }),
  gitWatch: (root) => invoke("git_watch", { root }),

  async onGitChanged(handler) {
    return listen<string>("git_changed", (event) => handler(event.payload));
  },
};

/** What the app does when there is no core behind it: say so, do nothing. */
const detachedCore: Core = {
  async detect(agent) {
    return { id: agent, path: null, caps: null, fromLoginShell: false };
  },
  async pickProject() {
    return null;
  },
  async projectInfo(path) {
    return { path, name: path, repository: null, isGit: false };
  },
  async setWindowTitle() {},
  async openUrl() {},
  async spawn() {
    throw new Error("not connected to the workbench core");
  },
  async spawnShell() {
    throw new Error("not connected to the workbench core");
  },
  async write() {},
  async resize() {},
  async kill() {},
  async ptyCwd() {
    return null;
  },
  async onSessionEnded() {
    return () => {};
  },
  async onSessionIdentified() {
    return () => {};
  },
  async onFileDrag() {
    return () => {};
  },
  async onOpenSettings() {
    return () => {};
  },
  async transcripts() {
    return [];
  },
  async sessionTitle() {
    return null;
  },
  async hookStatus(project) {
    return { installed: false, settings: project, events: "" };
  },
  async hookInstall(project) {
    return { installed: false, settings: project, events: "" };
  },
  async hookUninstall(project) {
    return { installed: false, settings: project, events: "" };
  },
  async gitStatus() {
    return [];
  },
  async gitFiles() {
    return [];
  },
  async gitDiff() {
    return { lines: [], binary: false, truncated: false };
  },
  async gitContent() {
    return { lines: [], binary: false, truncated: false };
  },
  async gitWatch() {},
  async onGitChanged() {
    return () => {};
  },
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    /** Set by the end-to-end tests before the app loads. */
    __WORKBENCH_CORE__?: Core;
  }
}

export function core(): Core {
  if (typeof window === "undefined") return detachedCore;
  if (window.__WORKBENCH_CORE__) return window.__WORKBENCH_CORE__;
  if (window.__TAURI_INTERNALS__) return tauriCore;
  return detachedCore;
}
