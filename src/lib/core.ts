import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

/**
 * The one place the frontend talks to the Rust core.
 *
 * Everything else in `src/lib` is pure or renders; this module is the seam. It
 * exists as an interface rather than as scattered `invoke` calls for two
 * reasons: the shape of the core is worth stating in one place, and the
 * end-to-end tests can stand a fake behind it and drive the terminal for real
 * without emulating Tauri's internals.
 */

export interface DetectReport {
  id: string;
  path: string | null;
  caps: { resumable: boolean; titles: boolean; acp: boolean } | null;
  /** False when the login shell could not be read, which changes what a
      missing binary means. */
  fromLoginShell: boolean;
}

export interface SpawnOptions {
  agent: string;
  project: string;
  /** Resume an existing session rather than starting a new one. */
  session?: string;
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

export interface SessionEnded {
  id: string;
  code: number | null;
  clean: boolean;
}

export interface Core {
  detect(agent: string): Promise<DetectReport>;
  /** Opens the native folder picker. Null when the user cancels. */
  pickProject(): Promise<string | null>;
  projectInfo(path: string): Promise<ProjectInfo>;
  setWindowTitle(title: string): Promise<void>;
  spawn(options: SpawnOptions, onOutput: (bytes: Uint8Array) => void): Promise<string>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  onSessionEnded(handler: (ended: SessionEnded) => void): Promise<() => void>;

  /** Sessions already on disk for this project, newest first. */
  transcripts(project: string): Promise<Transcript[]>;

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

  async spawn(options, onOutput) {
    const channel = new Channel<unknown>();
    channel.onmessage = (message) => onOutput(toBytes(message));
    return invoke<string>("pty_spawn", { ...options, onOutput: channel });
  },

  write: (id, data) => invoke("pty_write", { id, data }),
  resize: (id, cols, rows) => invoke("pty_resize", { id, cols, rows }),
  kill: (id) => invoke("pty_kill", { id }),

  async onSessionEnded(handler) {
    return listen<SessionEnded>("session_ended", (event) => handler(event.payload));
  },

  transcripts: (project) => invoke<Transcript[]>("sessions_list", { project }),

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
  async spawn() {
    throw new Error("not connected to the workbench core");
  },
  async write() {},
  async resize() {},
  async kill() {},
  async onSessionEnded() {
    return () => {};
  },
  async transcripts() {
    return [];
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
