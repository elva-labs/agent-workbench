import type { DetectReport } from "$lib/core";

/**
 * Whether there is an agent to run at all.
 *
 * One question, asked once, about the machine rather than about any session.
 * What individual sessions are doing lives in `sessions.svelte.ts`.
 */

export type Availability =
  | "unknown" // not looked for yet
  | "detached" // no core behind the window
  | "missing" // the binary is not on PATH
  | "ready";

export const agent = $state({
  availability: "unknown" as Availability,
  /** Where the binary was found. */
  path: null as string | null,
  /** False when the login shell could not be read, which changes what a
      missing binary means. */
  fromLoginShell: false,
  error: null as string | null,
});

export function applyDetect(report: DetectReport, hasCore: boolean) {
  agent.path = report.path;
  agent.fromLoginShell = report.fromLoginShell;
  agent.error = null;
  agent.availability = !hasCore ? "detached" : report.path === null ? "missing" : "ready";
}

export function detectFailed(error: string) {
  agent.availability = "missing";
  agent.error = error;
}

export function isReady(): boolean {
  return agent.availability === "ready";
}

/** Why no agent can be started, or null when one can. */
export function unavailableReason(): string | null {
  switch (agent.availability) {
    case "unknown":
      return "Looking for the agent…";
    case "detached":
      return "Not connected to the workbench core.";
    case "missing":
      return (
        agent.error ??
        (agent.fromLoginShell
          ? "claude was not found on your PATH. Install Claude Code, or check that it is on the PATH your login shell sets up."
          : "claude was not found, and your login shell could not be read, so the PATH searched may be incomplete.")
      );
    case "ready":
      return null;
  }
}
