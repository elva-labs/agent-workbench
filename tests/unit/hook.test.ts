import { beforeEach, describe, expect, it, vi } from "vitest";
import { check, hook, isInstalled, isKnown, reset, toggle } from "$lib/hook.svelte";

const state = {
  installed: {} as Record<string, boolean>,
  calls: [] as string[],
  fail: null as string | null,
};

vi.mock("$lib/core", () => ({
  core: () => ({
    async hookStatus(project: string) {
      state.calls.push(`status:${project}`);
      if (state.fail !== null) throw new Error(state.fail);
      return { installed: state.installed[project] === true, settings: "", events: "" };
    },
    async hookInstall(project: string) {
      state.calls.push(`install:${project}`);
      if (state.fail !== null) throw new Error(state.fail);
      state.installed[project] = true;
      return { installed: true, settings: "", events: "" };
    },
    async hookUninstall(project: string) {
      state.calls.push(`uninstall:${project}`);
      if (state.fail !== null) throw new Error(state.fail);
      state.installed[project] = false;
      return { installed: false, settings: "", events: "" };
    },
  }),
}));

const A = "/repo/one";
const B = "/repo/two";

beforeEach(() => {
  reset();
  state.installed = {};
  state.calls = [];
  state.fail = null;
});

describe("check", () => {
  // Off by default: nothing should edit a person's config because they opened
  // a folder.
  it("reports not installed for a fresh project", async () => {
    await check(A);
    expect(isInstalled(A)).toBe(false);
    expect(isKnown(A)).toBe(true);
  });

  it("reports installed when the core says so", async () => {
    state.installed[A] = true;
    await check(A);
    expect(isInstalled(A)).toBe(true);
  });

  // The watcher works regardless, so a failed check is not worth an error.
  it("treats a failure as not installed rather than as a problem", async () => {
    state.fail = "no home directory";
    await check(A);
    expect(isInstalled(A)).toBe(false);
    expect(hook.error).toBeNull();
  });

  it("is unknown until asked", () => {
    expect(isKnown(A)).toBe(false);
    expect(isInstalled(A)).toBe(false);
  });

  it("is never installed for no project", () => {
    expect(isInstalled(null)).toBe(false);
    expect(isKnown(null)).toBe(false);
  });
});

describe("toggle", () => {
  it("installs when it is off", async () => {
    await check(A);
    await toggle(A);
    expect(isInstalled(A)).toBe(true);
    expect(state.calls).toContain(`install:${A}`);
  });

  it("uninstalls when it is on", async () => {
    state.installed[A] = true;
    await check(A);
    await toggle(A);
    expect(isInstalled(A)).toBe(false);
    expect(state.calls).toContain(`uninstall:${A}`);
  });

  // Per project, because the settings file is per project.
  it("keeps projects apart", async () => {
    await check(A);
    await check(B);
    await toggle(A);

    expect(isInstalled(A)).toBe(true);
    expect(isInstalled(B)).toBe(false);
  });

  it("reports a failure rather than lying about the state", async () => {
    await check(A);
    state.fail = "settings file is read-only";
    await toggle(A);

    expect(hook.error).toContain("read-only");
    expect(isInstalled(A)).toBe(false);
  });

  it("clears a previous error on the next attempt", async () => {
    await check(A);
    state.fail = "transient";
    await toggle(A);
    expect(hook.error).not.toBeNull();

    state.fail = null;
    await toggle(A);
    expect(hook.error).toBeNull();
  });

  it("is not busy once it has finished", async () => {
    await check(A);
    await toggle(A);
    expect(hook.busy).toBe(false);
  });
});
