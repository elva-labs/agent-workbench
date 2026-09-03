import { beforeEach, describe, expect, it } from "vitest";
import {
  agent,
  applyDetect,
  detectFailed,
  isReady,
  unavailableReason,
} from "$lib/agent.svelte";

const found = {
  id: "claude-code",
  path: "/usr/local/bin/claude",
  caps: null,
  fromLoginShell: true,
};
const missing = { id: "claude-code", path: null, caps: null, fromLoginShell: true };

beforeEach(() => {
  agent.availability = "unknown";
  agent.path = null;
  agent.fromLoginShell = false;
  agent.error = null;
});

describe("detection", () => {
  it("is ready once the binary is found", () => {
    applyDetect(found, true);
    expect(agent.availability).toBe("ready");
    expect(agent.path).toBe("/usr/local/bin/claude");
    expect(isReady()).toBe(true);
    expect(unavailableReason()).toBeNull();
  });

  it("says the binary is missing when it is not on PATH", () => {
    applyDetect(missing, true);
    expect(agent.availability).toBe("missing");
    expect(isReady()).toBe(false);
  });

  it("says so when there is no core behind the window", () => {
    applyDetect(missing, false);
    expect(agent.availability).toBe("detached");
    expect(unavailableReason()).toContain("Not connected");
  });

  // The distinction that turns a shrug into a next step.
  it("qualifies a missing binary when the login shell could not be read", () => {
    applyDetect({ ...missing, fromLoginShell: false }, true);
    expect(unavailableReason()).toContain("login shell could not be read");
  });

  it("does not qualify it when the login shell was read", () => {
    applyDetect(missing, true);
    expect(unavailableReason()).toContain("not found on your PATH");
    expect(unavailableReason()).not.toContain("could not be read");
  });

  it("reports the error when the lookup itself failed", () => {
    detectFailed("the core went away");
    expect(agent.availability).toBe("missing");
    expect(unavailableReason()).toBe("the core went away");
  });

  it("clears a previous error on a fresh look", () => {
    detectFailed("transient");
    applyDetect(found, true);
    expect(agent.error).toBeNull();
    expect(unavailableReason()).toBeNull();
  });

  it("says it is still looking before anything has been asked", () => {
    expect(unavailableReason()).toContain("Looking for");
  });
});
