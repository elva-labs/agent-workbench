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
  /** Where to run when that is not the project: a worktree under it. */
  cwd?: string;
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

/** A transition one of the agent's own hooks reported, by session id:
    `prompt` (the user sent one), `stop` (the turn ended), `permission` (it
    is asking), `idle` (it has been waiting a while). */
export interface SessionEvent {
  sessionId: string;
  kind: "prompt" | "stop" | "permission" | "idle";
}

/** A place in a file the agent asked to show, through the daemon's MCP
    tool: the file, absolute, a range of lines, a note, and where the agent
    runs, which says which project it is for. */
export interface ShowRequest {
  path: string;
  from: number;
  to: number;
  note: string | null;
  cwd: string;
  /** The agent's session id, when the agent's environment named one. */
  session: string | null;
}

/** A file whose diff the agent asked to open, absolute, with a note. */
export interface DiffRequest {
  path: string;
  note: string | null;
  cwd: string;
  session: string | null;
}

/** A command the agent asked to have typed into a new terminal. */
export interface TerminalRequest {
  command: string;
  cwd: string;
  session: string | null;
}

/** A line the agent left for its session's row. */
export interface NotifyRequest {
  text: string;
  cwd: string;
  session: string | null;
}

/** A plugin as its manifest declares it, plus what is on and running. */
export interface PluginInfo {
  name: string;
  path: string;
  description: string;
  version: string;
  run: string[];
  tools: string[];
  sections: string[];
  view: "wide" | "full" | null;
  enabled: boolean;
  state: "off" | "starting" | "running" | "stopped" | "failed";
  detail: string | null;
  hello: {
    name: string;
    version: string;
    tools: unknown[];
    sections: unknown[];
    view: unknown | null;
  } | null;
}

/** A plugin source: a repository cloned, or a directory on the machine. */
export interface PluginSource {
  id: string;
  kind: "git" | "dir";
  location: string;
  reference: string | null;
  commit: string | null;
  newer: string | null;
  error: string | null;
  plugins: PluginInfo[];
}

export interface PluginStateEvent {
  source: string;
  name: string;
  state: PluginInfo["state"];
  detail: string | null;
  hello: PluginInfo["hello"];
}

/** One thing an action asks for before it runs: a line of text, or a
    choice among named options. */
export interface PluginField {
  id: string;
  label: string;
  kind: "text" | "choice";
  /** The options to choose among, for a choice. */
  options: { id: string; label: string }[] | null;
  placeholder: string | null;
}

/** Something a section's header or one of its rows offers to do. An action
    with fields is asked about in a dialog before it runs. */
export interface PluginAction {
  id: string;
  label: string;
  input: PluginField[] | null;
}

/** A line in a plugin's section: what it is, how it is doing, and what can
    be done to it. */
export interface PluginRow {
  id: string;
  label: string;
  detail: string | null;
  state: "ok" | "busy" | "waiting" | "failed" | null;
  actions: PluginAction[] | null;
  /** The action Enter or a click on the row runs, by id. */
  default: string | null;
}

/** A section's rows for one project, as the plugin has them now. No rows
    means the section is gone for that project. */
export interface PluginSectionEvent {
  source: string;
  plugin: string;
  section: string;
  title: string;
  project: string;
  rows: PluginRow[];
  actions: PluginAction[];
}

/** What went wrong when an action ran, for the plugin's sections to say. */
export interface PluginNoticeEvent {
  source: string;
  plugin: string;
  text: string;
}

/** An action taken on a section's header or on one of its rows. */
export interface PluginActionRequest {
  source: string;
  plugin: string;
  section: string;
  action: string;
  row: string | null;
  input: Record<string, string>;
  project: string;
}

/** A process running under a session's or a shell's own. */
export interface Process {
  pid: number;
  parent: number;
  name: string;
  command: string;
  /** Share of one CPU, in percent, since the reading before. */
  cpu: number;
  /** Resident memory, in bytes. */
  memory: number;
  /** When it started, in seconds since the epoch. */
  started: number;
}

/** What the user is looking at, as put on record for the agent's tools.
    Paths are as the project's machine sees them. */
export interface Selection {
  project: string;
  file: string | null;
  view: "diff" | "file" | null;
  from: number | null;
  to: number | null;
  media: { files: string[]; caption: string | null } | null;
}

/** Media the agent asked to present: files, absolute, in the order to look
    at them, a caption, and where the agent runs. */
export interface PresentRequest {
  files: string[];
  caption: string | null;
  cwd: string;
  /** The agent's session id, when the agent's environment named one. */
  session: string | null;
}

/** An image or a PDF, read where it is and encoded for the window. */
export interface Media {
  mime: string;
  /** Base64. */
  data: string;
  size: number;
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

/** Machines the window can offer: named in the user's ssh configuration,
    or set up by the app itself. */
export interface RemoteHosts {
  configured: string[];
  /** Paired machines: named by the token, reached at the address it carried. */
  saved: {
    name: string;
    host: string;
    user: string;
    port: number;
    target: string;
  }[];
}

/** Directories under a path on a machine, each with the host on, so any
    of them opens as it is. */
export interface RemoteDirs {
  path: string;
  dirs: { name: string; path: string }[];
}

export interface RemoteClosed {
  host: string;
  reason: string;
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

export interface GrepHit {
  path: string;
  /** One-based, as editors count. */
  line: number;
  text: string;
}

export interface GrepResult {
  hits: GrepHit[];
  /** True when there were more than the core's cap and the rest were dropped. */
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
  /** Where the session ran when that is not the project itself: a worktree
      under it, which is where it resumes. */
  cwd?: string | null;
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
  /** The window's own controls, for the platforms where the app draws them. */
  windowControl(action: "minimize" | "maximize" | "close"): Promise<void>;
  /** The native popup that stands in for a menu bar on those platforms. */
  openAppMenu(): Promise<void>;
  /** A count on the app's icon, or none. Sessions waiting for the user. */
  setBadge(count: number | null): Promise<void>;
  spawn(
    options: SpawnOptions,
    onOutput: (bytes: Uint8Array) => void,
  ): Promise<Spawned>;
  /** Resolves to the pty id. Ended like a session, through `onSessionEnded`. */
  spawnShell(
    options: ShellOptions,
    onOutput: (bytes: Uint8Array) => void,
  ): Promise<string>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  /** Where the process is working now. Null when the OS will not say. */
  ptyCwd(id: string): Promise<string | null>;
  /** What runs under a pty's process, the process itself left out. */
  ptyProcesses(id: string): Promise<Process[]>;
  stopProcess(id: string, pid: number): Promise<void>;
  /** The plugin sources on this machine, with their plugins and states. */
  pluginSources(): Promise<PluginSource[]>;
  pluginAdd(location: string, reference: string | null): Promise<PluginSource>;
  pluginRemove(id: string): Promise<void>;
  /** A newer commit on the source's ref, or null when there is none. */
  pluginCheck(id: string): Promise<string | null>;
  pluginUpdate(id: string): Promise<PluginSource>;
  pluginEnable(id: string, name: string, on: boolean): Promise<PluginSource>;
  /** The projects open, each machine told the ones on it, so the plugins
      running there know which projects they serve. */
  pluginProjects(paths: string[]): Promise<void>;
  onPluginState(
    handler: (event: PluginStateEvent) => void,
  ): Promise<() => void>;
  /** A plugin's section has rows for a project, or none left. */
  onPluginSection(
    handler: (event: PluginSectionEvent) => void,
  ): Promise<() => void>;
  /** An action went wrong, for the plugin's sections to say. */
  onPluginNotice(
    handler: (event: PluginNoticeEvent) => void,
  ): Promise<() => void>;
  /** Takes an action on a section's header or row. Rejects with the reason
      when the plugin is not running. */
  pluginAction(request: PluginActionRequest): Promise<void>;
  onSessionEnded(handler: (ended: SessionEnded) => void): Promise<() => void>;
  /** An agent that mints its own ids has written one down for a session. */
  onSessionIdentified(
    handler: (identified: SessionIdentified) => void,
  ): Promise<() => void>;
  /** A session hook fired, for projects with the hooks installed. */
  onSessionEvent(handler: (event: SessionEvent) => void): Promise<() => void>;
  /** The agent asked to show the user a place in a file. */
  onShowRequest(handler: (request: ShowRequest) => void): Promise<() => void>;
  /** The agent asked to present media. */
  onPresentRequest(
    handler: (request: PresentRequest) => void,
  ): Promise<() => void>;
  /** Reads an image or a PDF for the window, wherever the path is. */
  readMedia(path: string): Promise<Media>;
  onDiffRequest(handler: (request: DiffRequest) => void): Promise<() => void>;
  onTerminalRequest(
    handler: (request: TerminalRequest) => void,
  ): Promise<() => void>;
  onNotifyRequest(
    handler: (request: NotifyRequest) => void,
  ): Promise<() => void>;
  /** Puts what the user is looking at on record on the project's machine,
      or clears it there with null. */
  setSelection(project: string, selection: Selection | null): Promise<void>;
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
  /** Lines matching a query, in the changed files or in every file listed. */
  gitGrep(
    root: string,
    query: string,
    scope: "changed" | "all",
  ): Promise<GrepResult>;
  gitDiff(root: string, file: string): Promise<FileDiff>;
  gitContent(root: string, file: string): Promise<FileContent>;
  /** Starts watching a worktree, replacing whatever was watched before. */
  gitWatch(root: string): Promise<void>;
  onGitChanged(handler: (root: string) => void): Promise<() => void>;

  /** Machines to offer: the ssh configuration's and the app's own. */
  remoteHosts(): Promise<RemoteHosts>;
  /** Opens the connection to a target, putting the daemon there first if it is missing. */
  remoteConnect(target: string): Promise<{ host: string; version: string }>;
  /** Takes in the token the daemon printed on a machine, then connects. */
  remotePair(token: string): Promise<{ host: string; version: string }>;
  /** Directories under a path on the target, or under its home for "". */
  remoteDirs(target: string, path: string): Promise<RemoteDirs>;
  remoteDisconnect(target: string): Promise<void>;
  remoteForget(target: string): Promise<void>;
  /** A connection went away, with every session it carried. */
  onRemoteClosed(handler: (closed: RemoteClosed) => void): Promise<() => void>;
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
    const chosen = await openDialog({
      directory: true,
      multiple: false,
      title: "Open project",
    });
    return typeof chosen === "string" ? chosen : null;
  },

  projectInfo: (path) => invoke<ProjectInfo>("project_info", { path }),

  async setWindowTitle(title) {
    await getCurrentWindow().setTitle(title);
  },

  openUrl: (url) => openWithSystem(url),

  async windowControl(action) {
    const window = getCurrentWindow();
    if (action === "minimize") await window.minimize();
    else if (action === "maximize") await window.toggleMaximize();
    else await window.close();
  },

  openAppMenu: () => invoke("app_menu"),

  async setBadge(count) {
    await getCurrentWindow().setBadgeCount(count === null ? undefined : count);
  },

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
  ptyProcesses: (id) => invoke<Process[]>("pty_processes", { id }),
  stopProcess: (id, pid) => invoke<void>("pty_stop_process", { id, pid }),
  pluginSources: () => invoke<PluginSource[]>("plugin_sources"),
  pluginAdd: (location, reference) =>
    invoke<PluginSource>("plugin_add", { location, reference }),
  pluginRemove: (id) => invoke<void>("plugin_remove", { id }),
  pluginCheck: (id) => invoke<string | null>("plugin_check", { id }),
  pluginUpdate: (id) => invoke<PluginSource>("plugin_update", { id }),
  pluginEnable: (id, name, on) =>
    invoke<PluginSource>("plugin_enable", { id, name, on }),
  pluginProjects: (paths) => invoke<void>("plugin_projects", { paths }),
  async onPluginState(handler) {
    return listen<PluginStateEvent>("plugin_state", (event) =>
      handler(event.payload),
    );
  },
  async onPluginSection(handler) {
    return listen<PluginSectionEvent>("plugin_section", (event) =>
      handler(event.payload),
    );
  },
  async onPluginNotice(handler) {
    return listen<PluginNoticeEvent>("plugin_notice", (event) =>
      handler(event.payload),
    );
  },
  pluginAction: (request) => invoke<void>("plugin_action", { ...request }),

  async onSessionEnded(handler) {
    return listen<SessionEnded>("session_ended", (event) =>
      handler(event.payload),
    );
  },

  async onSessionIdentified(handler) {
    return listen<SessionIdentified>("session_identified", (event) =>
      handler(event.payload),
    );
  },

  async onSessionEvent(handler) {
    return listen<SessionEvent>("session_event", (event) =>
      handler(event.payload),
    );
  },
  async onShowRequest(handler) {
    return listen<ShowRequest>("show_request", (event) =>
      handler(event.payload),
    );
  },
  async onPresentRequest(handler) {
    return listen<PresentRequest>("present_request", (event) =>
      handler(event.payload),
    );
  },
  readMedia: (path) => invoke<Media>("read_media", { path }),
  async onDiffRequest(handler) {
    return listen<DiffRequest>("diff_request", (event) =>
      handler(event.payload),
    );
  },
  setSelection: (project, selection) =>
    invoke<void>("set_selection", { project, selection }),
  async onTerminalRequest(handler) {
    return listen<TerminalRequest>("terminal_request", (event) =>
      handler(event.payload),
    );
  },
  async onNotifyRequest(handler) {
    return listen<NotifyRequest>("notify_request", (event) =>
      handler(event.payload),
    );
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
      if (drag.type === "drop")
        handler({ type: "drop", paths: drag.paths, x, y });
      else handler({ type: "over", x, y });
    });
  },

  transcripts: (project, agent) =>
    invoke<Transcript[]>("sessions_list", { project, agent }),
  sessionTitle: (agent, id) =>
    invoke<string | null>("session_title", { agent, id }),

  hookStatus: (project) => invoke<HookStatus>("hook_status", { project }),
  hookInstall: (project) => invoke<HookStatus>("hook_install", { project }),
  hookUninstall: (project) => invoke<HookStatus>("hook_uninstall", { project }),

  gitStatus: (root) => invoke<ChangedFile[]>("git_status", { root }),
  gitFiles: (root) => invoke<string[]>("git_files", { root }),
  gitGrep: (root, query, scope) =>
    invoke<GrepResult>("git_grep", { root, query, scope }),
  gitDiff: (root, file) => invoke<FileDiff>("git_diff", { root, file }),
  gitContent: (root, file) =>
    invoke<FileContent>("git_content", { root, file }),
  gitWatch: (root) => invoke("git_watch", { root }),

  async onGitChanged(handler) {
    return listen<string>("git_changed", (event) => handler(event.payload));
  },

  remoteHosts: () => invoke<RemoteHosts>("remote_hosts"),
  remoteConnect: (host) =>
    invoke<{ host: string; version: string }>("remote_connect", { host }),
  remotePair: (token) =>
    invoke<{ host: string; version: string }>("remote_pair", { token }),
  remoteDirs: (host, path) => invoke<RemoteDirs>("remote_dirs", { host, path }),
  remoteDisconnect: (host) => invoke<void>("remote_disconnect", { host }),
  remoteForget: (target) => invoke<void>("remote_forget", { target }),
  async onRemoteClosed(handler) {
    return listen<RemoteClosed>("remote_closed", (event) =>
      handler(event.payload),
    );
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
  async windowControl() {},
  async openAppMenu() {},
  async setBadge() {},
  async spawn() {
    throw new Error("not connected to the workbench core");
  },
  async spawnShell() {
    throw new Error("not connected to the workbench core");
  },
  async write() {},
  async resize() {},
  async kill() {},
  async ptyProcesses() {
    return [];
  },
  async stopProcess() {},
  async pluginSources() {
    return [];
  },
  async pluginAdd() {
    throw new Error("no core");
  },
  async pluginRemove() {},
  async pluginCheck() {
    return null;
  },
  async pluginUpdate() {
    throw new Error("no core");
  },
  async pluginEnable() {
    throw new Error("no core");
  },
  async pluginProjects() {},
  async onPluginState() {
    return () => {};
  },
  async onPluginSection() {
    return () => {};
  },
  async onPluginNotice() {
    return () => {};
  },
  async pluginAction() {
    throw new Error("no core");
  },
  async ptyCwd() {
    return null;
  },
  async onSessionEnded() {
    return () => {};
  },
  async onSessionIdentified() {
    return () => {};
  },
  async onSessionEvent() {
    return () => {};
  },
  async onShowRequest() {
    return () => {};
  },
  async onPresentRequest() {
    return () => {};
  },
  async readMedia() {
    throw new Error("no core");
  },
  async onDiffRequest() {
    return () => {};
  },
  async setSelection() {},
  async onTerminalRequest() {
    return () => {};
  },
  async onNotifyRequest() {
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
  async gitGrep() {
    return { hits: [], truncated: false };
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
  async remoteHosts() {
    return { configured: [], saved: [] };
  },
  async remoteConnect() {
    throw new Error("no core to reach a machine with");
  },
  async remotePair() {
    throw new Error("no core to reach a machine with");
  },
  async remoteDirs() {
    throw new Error("no core to reach a machine with");
  },
  async remoteDisconnect() {},
  async remoteForget() {},
  async onRemoteClosed() {
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
