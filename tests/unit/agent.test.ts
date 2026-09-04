import { beforeEach, describe, expect, it } from "vitest";
import {
  agent,
  applyDetect,
  detectFailed,
  installed,
  isInstalled,
  isReady,
  resetAgent,
  unavailableReason,
} from "$lib/agent.svelte";

const claude = {
  id: "claude-code",
  path: "/usr/local/bin/claude",
  caps: null,
  fromLoginShell: true,
};
const codex = { id: "codex", path: "/usr/local/bin/codex", caps: null, fromLoginShell: true };
const noClaude = { ...claude, path: null };
const noCodex = { ...codex, path: null };

beforeEach(resetAgent);

describe("detection", () => {
  it("is ready once one binary is found", () => {
    applyDetect(claude, true);
    expect(agent.availability).toBe("ready");
    expect(agent.paths["claude-code"]).toBe("/usr/local/bin/claude");
    expect(isReady()).toBe(true);
    expect(unavailableReason()).toBeNull();
  });

  it("offers the agents that are installed, in a fixed order", () => {
    applyDetect(codex, true);
    expect(installed()).toEqual(["codex"]);
    applyDetect(claude, true);
    expect(installed()).toEqual(["claude-code", "codex"]);
    expect(isInstalled("codex")).toBe(true);
    applyDetect(noCodex, true);
    expect(installed()).toEqual(["claude-code"]);
    expect(isInstalled("codex")).toBe(false);
  });

  // One missing binary is not the answer: the other may still be there.
  it("keeps looking until every agent has been asked for", () => {
    applyDetect(noClaude, true);
    expect(agent.availability).toBe("unknown");
    expect(unavailableReason()).toContain("Looking for");
    applyDetect(noCodex, true);
    expect(agent.availability).toBe("missing");
    expect(isReady()).toBe(false);
  });

  it("says so when there is no core behind the window", () => {
    applyDetect(noClaude, false);
    expect(agent.availability).toBe("detached");
    expect(unavailableReason()).toContain("Not connected");
  });

  // The distinction that turns a shrug into a next step.
  it("qualifies missing binaries when the login shell could not be read", () => {
    applyDetect({ ...noClaude, fromLoginShell: false }, true);
    applyDetect({ ...noCodex, fromLoginShell: false }, true);
    expect(unavailableReason()).toContain("login shell could not be read");
  });

  it("names both agents when neither is there", () => {
    applyDetect(noClaude, true);
    applyDetect(noCodex, true);
    expect(unavailableReason()).toContain("Neither claude nor codex was found on your PATH");
    expect(unavailableReason()).not.toContain("could not be read");
  });

  it("reports the error when the lookup itself failed", () => {
    detectFailed("the core went away");
    expect(agent.availability).toBe("missing");
    expect(unavailableReason()).toBe("the core went away");
  });

  it("does not let one failed lookup hide an agent that was found", () => {
    applyDetect(claude, true);
    detectFailed("codex lookup failed");
    expect(agent.availability).toBe("ready");
  });

  it("clears a previous error on a fresh look", () => {
    detectFailed("transient");
    applyDetect(claude, true);
    expect(agent.error).toBeNull();
    expect(unavailableReason()).toBeNull();
  });

  it("says it is still looking before anything has been asked", () => {
    expect(unavailableReason()).toContain("Looking for");
  });
});
