import { beforeEach, describe, expect, it } from "vitest";
import {
  agent,
  applyDetect,
  canStart,
  ended,
  failed,
  running,
  starting,
  statusLabel,
  statusMessage,
} from "$lib/agent.svelte";

const found = { id: "claude-code", path: "/usr/local/bin/claude", caps: null, fromLoginShell: true };
const missing = { id: "claude-code", path: null, caps: null, fromLoginShell: true };

beforeEach(() => {
  agent.status = "unknown";
  agent.id = null;
  agent.path = null;
  agent.fromLoginShell = false;
  agent.exitCode = null;
  agent.error = null;
});

describe("detection", () => {
  it("is ready once the binary is found", () => {
    applyDetect(found, true);
    expect(agent.status).toBe("idle");
    expect(agent.path).toBe("/usr/local/bin/claude");
  });

  it("says the binary is missing when it is not on PATH", () => {
    applyDetect(missing, true);
    expect(agent.status).toBe("missing");
  });

  it("says so when there is no core behind the window", () => {
    applyDetect(missing, false);
    expect(agent.status).toBe("detached");
  });

  // The distinction that turns a shrug into a next step.
  it("qualifies a missing binary when the login shell could not be read", () => {
    applyDetect({ ...missing, fromLoginShell: false }, true);
    expect(statusMessage()).toContain("login shell could not be read");
  });

  it("does not qualify it when the login shell was read", () => {
    applyDetect(missing, true);
    expect(statusMessage()).toContain("not found on your PATH");
    expect(statusMessage()).not.toContain("could not be read");
  });
});

describe("the run cycle", () => {
  it("goes ready, starting, running", () => {
    applyDetect(found, true);
    starting();
    expect(agent.status).toBe("starting");
    running("pty-1");
    expect(agent.status).toBe("running");
    expect(agent.id).toBe("pty-1");
  });

  it("clears the last error when starting again", () => {
    failed("could not start");
    starting();
    expect(agent.error).toBeNull();
    expect(agent.exitCode).toBeNull();
  });

  it("records a failure to start without leaving a session id behind", () => {
    running("pty-1");
    failed("boom");
    expect(agent.status).toBe("failed");
    expect(agent.id).toBeNull();
    expect(statusMessage()).toBe("boom");
  });
});

describe("the exit policy", () => {
  it("treats code zero as a clean exit", () => {
    running("pty-1");
    ended({ id: "pty-1", code: 0, clean: true });
    expect(agent.status).toBe("exited");
    expect(agent.id).toBeNull();
  });

  // A non-zero exit is a crash as far as the pane is concerned, and it says so
  // rather than quietly clearing itself.
  it("treats anything else as a crash and names the code", () => {
    running("pty-1");
    ended({ id: "pty-1", code: 1, clean: false });
    expect(agent.status).toBe("crashed");
    expect(statusMessage()).toContain("code 1");
  });

  it("reports a signal kill without inventing a code", () => {
    running("pty-1");
    ended({ id: "pty-1", code: null, clean: false });
    expect(agent.status).toBe("crashed");
    expect(statusMessage()).toBe("The agent was stopped.");
  });

  it("ignores an exit belonging to a session that is not the current one", () => {
    running("pty-2");
    ended({ id: "pty-1", code: 1, clean: false });
    expect(agent.status).toBe("running");
    expect(agent.id).toBe("pty-2");
  });
});

describe("canStart", () => {
  // There is no shell to fall back to here, so the pane offers a way back
  // rather than respawning by itself: a broken install would otherwise loop.
  it("offers to start when ready, and to restart after it stops", () => {
    for (const status of ["idle", "exited", "crashed", "failed"] as const) {
      agent.status = status;
      expect(canStart(), status).toBe(true);
    }
  });

  it("offers nothing while it is running or starting", () => {
    for (const status of ["running", "starting"] as const) {
      agent.status = status;
      expect(canStart(), status).toBe(false);
    }
  });

  it("offers nothing when there is no binary or no core", () => {
    for (const status of ["missing", "detached", "unknown"] as const) {
      agent.status = status;
      expect(canStart(), status).toBe(false);
    }
  });
});

describe("statusLabel", () => {
  it("names every state the header can be in", () => {
    const labels = new Map([
      ["unknown", "not running"],
      ["idle", "not running"],
      ["exited", "not running"],
      ["starting", "starting"],
      ["running", "running"],
      ["missing", "unavailable"],
      ["detached", "unavailable"],
      ["crashed", "stopped"],
      ["failed", "stopped"],
    ] as const);

    for (const [status, label] of labels) {
      agent.status = status;
      expect(statusLabel(), status).toBe(label);
    }
  });
});
