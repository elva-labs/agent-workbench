import type { DetectReport, SessionEnded } from "$lib/core";

/**
 * What the agent pane is doing, and why.
 *
 * The exit policy is the part worth being deliberate about. There is no shell
 * to fall back to in this pane, so when the agent goes the pane has nothing to
 * show. It must distinguish a clean exit from a crash, offer a way back, and
 * never respawn by itself: a broken install would otherwise turn into a loop
 * that burns CPU and hides the actual error.
 */

export type AgentStatus =
  | "unknown" // not looked for yet
  | "missing" // the binary is not on PATH
  | "no-project" // nothing to run in yet
  | "detached" // no core behind the window
  | "idle" // found, not started
  | "starting"
  | "running"
  | "exited" // finished on its own terms
  | "crashed" // non-zero, or killed
  | "failed"; // never got as far as running

export const agent = $state({
  status: "unknown" as AgentStatus,
  /** The running session, when there is one. */
  id: null as string | null,
  /** Where the binary was found. */
  path: null as string | null,
  fromLoginShell: false,
  exitCode: null as number | null,
  error: null as string | null,
  /**
   * The project an agent was started for. Auto-start fires once per project,
   * never again: a crash must not become a respawn loop, and reopening the
   * same project should not queue a second agent.
   */
  startedFor: null as string | null,
});

export function applyDetect(report: DetectReport, hasCore: boolean, hasProject: boolean) {
  agent.path = report.path;
  agent.fromLoginShell = report.fromLoginShell;
  agent.status = !hasCore
    ? "detached"
    : report.path === null
      ? "missing"
      : !hasProject
        ? "no-project"
        : "idle";
}

/**
 * Whether the pane should start the agent without being asked.
 *
 * True exactly once per project, and only from a standing start. A workbench
 * whose whole purpose is running an agent should open with one running, but a
 * session that stopped stays stopped until you say otherwise.
 */
export function shouldAutoStart(projectPath: string | null): boolean {
  if (projectPath === null) return false;
  if (agent.status !== "idle") return false;
  return agent.startedFor !== projectPath;
}

/** Called when a project opens: the next auto-start is for a different root. */
export function projectChanged(projectPath: string | null) {
  // A different root means the last run no longer counts, so the next
  // auto-start is allowed. The same root keeps its history.
  if (agent.startedFor !== projectPath) agent.startedFor = null;

  if (projectPath === null) agent.status = "no-project";
  else if (agent.status === "no-project") agent.status = "idle";
  else if (["exited", "crashed", "failed"].includes(agent.status)) agent.status = "idle";
}

export function starting() {
  agent.status = "starting";
  agent.error = null;
  agent.exitCode = null;
}

export function running(id: string, projectPath: string | null) {
  agent.id = id;
  agent.status = "running";
  agent.startedFor = projectPath;
}

/**
 * The project moved out from under a running agent.
 *
 * Deliberately stopping one is not a crash, so the session is disowned rather
 * than mourned: a late exit event for it is ignored, and the pane is ready to
 * start in the new project rather than showing a stop it caused itself.
 */
export function abandon(projectPath: string | null) {
  agent.id = null;
  agent.exitCode = null;
  agent.error = null;
  agent.status = projectPath === null ? "no-project" : "idle";
}

export function failed(error: string) {
  agent.id = null;
  agent.status = "failed";
  agent.error = error;
}

export function ended(event: SessionEnded) {
  if (event.id !== agent.id) return;
  agent.id = null;
  agent.exitCode = event.code;
  agent.status = event.clean ? "exited" : "crashed";
}

/** Whether the pane offers to start or restart the agent. */
export function canStart(): boolean {
  return ["idle", "exited", "crashed", "failed"].includes(agent.status);
}

/** What the pane says when the agent is not running. */
export function statusMessage(): string {
  switch (agent.status) {
    case "unknown":
      return "Looking for the agent…";
    case "detached":
      return "Not connected to the workbench core.";
    case "no-project":
      return "Open a project to start the agent.";
    case "missing":
      return agent.fromLoginShell
        ? "claude was not found on your PATH. Install Claude Code, or check that it is on the PATH your login shell sets up."
        : "claude was not found, and your login shell could not be read, so the PATH searched may be incomplete.";
    case "idle":
      return "Ready.";
    case "starting":
      return "Starting…";
    case "running":
      return "Running.";
    case "exited":
      return "The agent exited.";
    case "crashed":
      return agent.exitCode === null
        ? "The agent was stopped."
        : `The agent exited with code ${agent.exitCode}.`;
    case "failed":
      return agent.error ?? "The agent could not be started.";
  }
}

/** The word shown in the pane header. */
export function statusLabel(): string {
  switch (agent.status) {
    case "running":
      return "running";
    case "starting":
      return "starting";
    case "missing":
    case "detached":
      return "unavailable";
    case "no-project":
      return "no project";
    case "crashed":
    case "failed":
      return "stopped";
    default:
      return "not running";
  }
}
