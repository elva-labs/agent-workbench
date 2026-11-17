import { describe, expect, it } from "vitest";
import { fitMode, modeName, narrowerOf, nextNarrower } from "$lib/modeFit";

// The mode a session another started begins in: its starter's own as far
// as its agent has it, and never a wider one.

describe("the mode a started session is given", () => {
  it("is the starter's own on the same agent, where the workbench starts a session in it", () => {
    for (const mode of ["plan", "default", "dontAsk", "acceptEdits", "auto"])
      expect(fitMode("claude-code", mode, "claude-code")).toBe(mode);
    for (const mode of ["read-only", "auto", "full-access"]) expect(fitMode("codex", mode, "codex")).toBe(mode);
  });

  it("is the nearest below a mode no session is started in", () => {
    expect(fitMode("claude-code", "bypassPermissions", "claude-code")).toBe("auto");
  });

  it("goes no further than the starter's on the other agent", () => {
    expect(fitMode("claude-code", "auto", "codex")).toBe("auto");
    expect(fitMode("claude-code", "acceptEdits", "codex")).toBe("read-only");
    expect(fitMode("claude-code", "default", "codex")).toBe("read-only");
    expect(fitMode("claude-code", "bypassPermissions", "codex")).toBe("full-access");
    expect(fitMode("codex", "full-access", "claude-code")).toBe("auto");
    expect(fitMode("codex", "auto", "claude-code")).toBe("acceptEdits");
    expect(fitMode("codex", "read-only", "claude-code")).toBe("default");
    // Codex has nothing as narrow as Plan: its narrowest.
    expect(fitMode("claude-code", "plan", "codex")).toBe("read-only");
  });

  it("is called as the agents' own lists call it, or by its own name", () => {
    expect(modeName("claude-code", "acceptEdits")).toBe("Accept edits");
    expect(modeName("codex", "read-only")).toBe("Read only");
    expect(modeName("claude-code", "constructor")).toBe("constructor");
  });

  it("is none for a mode not on the scale", () => {
    expect(fitMode("claude-code", "somethingNew", "claude-code")).toBeNull();
    expect(fitMode("codex", "untrusted, workspace-write", "codex")).toBeNull();
    expect(fitMode("claude-code", "constructor", "codex")).toBeNull();
  });

  it("falls back a step at a time, and takes the narrower of two", () => {
    expect(nextNarrower("claude-code", "auto")).toBe("acceptEdits");
    expect(nextNarrower("claude-code", "acceptEdits")).toBe("default");
    expect(nextNarrower("claude-code", "default")).toBe("plan");
    expect(nextNarrower("claude-code", "plan")).toBeNull();
    expect(nextNarrower("codex", "full-access")).toBe("auto");
    expect(narrowerOf("claude-code", "auto", "plan")).toBe("plan");
    expect(narrowerOf("claude-code", null, "auto")).toBe("auto");
    expect(narrowerOf("claude-code", "acceptEdits", null)).toBe("acceptEdits");
  });
});
