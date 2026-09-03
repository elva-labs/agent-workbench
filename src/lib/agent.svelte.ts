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
});

export function applyDetect(report: DetectReport, hasCore: boolean) {
  agent.path = report.path;
  agent.fromLoginShell = report.fromLoginShell;
  agent.status = !hasCore ? "detached" : report.path === null ? "missing" : "idle";
}

export function starting() {
  agent.status = "starting";
  agent.error = null;
  agent.exitCode = null;
}

export function running(id: string) {
  agent.id = id;
  agent.status = "running";
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
    case "crashed":
    case "failed":
      return "stopped";
    default:
      return "not running";
  }
}
