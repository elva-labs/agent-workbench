import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  apply,
  check,
  ensure,
  hook,
  isInstalled,
  isKnown,
  loadHooks,
  reset,
  setEverywhere,
  setOverride,
  wanted,
} from "$lib/hook.svelte";

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
      return {
        installed: state.installed[project] === true,
        settings: "",
        events: "",
      };
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
  localStorage.clear();
  state.installed = {};
  state.calls = [];
  state.fail = null;
});

describe("check", () => {
  it("reports not installed for a project without them", async () => {
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

describe("the answer for every project", () => {
  // Fresh, on: the hooks are what makes a row exact, and they stay out of
  // the repository. A setup from before keeps what it had until asked.
  it("starts on for a fresh install and off for a setup from before", () => {
    loadHooks();
    expect(hook.everywhere).toBe(true);

    localStorage.setItem("workbench.workspace", "{}");
    loadHooks();
    expect(hook.everywhere).toBe(false);
  });

  it("keeps the choice and the projects' own words across a restart", async () => {
    await setEverywhere(true, []);
    await setOverride(B, false);
    reset();
    loadHooks();
    expect(hook.everywhere).toBe(true);
    expect(wanted(A)).toBe(true);
    expect(wanted(B)).toBe(false);
  });

  it("installs in a project brought to it, and removes from one not wanted", async () => {
    hook.everywhere = true;
    await apply(A);
    expect(isInstalled(A)).toBe(true);
    expect(state.calls).toEqual([`status:${A}`, `install:${A}`]);

    hook.everywhere = false;
    await apply(A);
    expect(isInstalled(A)).toBe(false);
    expect(state.calls).toContain(`uninstall:${A}`);
  });

  it("does nothing to a project already as wanted", async () => {
    state.installed[A] = true;
    hook.everywhere = true;
    await apply(A);
    expect(state.calls).toEqual([`status:${A}`]);
  });

  it("brings each open project to the answer once", async () => {
    hook.everywhere = true;
    ensure(A);
    ensure(A);
    await vi.waitFor(() => expect(isInstalled(A)).toBe(true));
    expect(state.calls.filter((call) => call.startsWith("install:"))).toEqual([
      `install:${A}`,
    ]);
  });

  it("applies a change of the answer to every open project", async () => {
    await setEverywhere(true, [A, B]);
    expect(isInstalled(A)).toBe(true);
    expect(isInstalled(B)).toBe(true);
    await setEverywhere(false, [A, B]);
    expect(isInstalled(A)).toBe(false);
    expect(isInstalled(B)).toBe(false);
  });

  // The rare project that wants otherwise, whichever way the rest go.
  it("lets one project say otherwise, and follow the rest again", async () => {
    await setEverywhere(true, [A, B]);
    await setOverride(B, false);
    expect(isInstalled(A)).toBe(true);
    expect(isInstalled(B)).toBe(false);

    await setEverywhere(false, [A, B]);
    expect(isInstalled(A)).toBe(false);
    await setOverride(A, true);
    expect(isInstalled(A)).toBe(true);

    await setOverride(A, null);
    expect(wanted(A)).toBe(false);
    expect(isInstalled(A)).toBe(false);
  });

  it("reports a failure rather than lying about the state", async () => {
    hook.everywhere = true;
    await check(A);
    state.fail = "settings file is read-only";
    await apply(A);

    expect(hook.error).toContain("read-only");
    expect(isInstalled(A)).toBe(false);
  });

  it("clears a previous error on the next attempt, and is not busy after", async () => {
    hook.everywhere = true;
    await check(A);
    state.fail = "transient";
    await apply(A);
    expect(hook.error).not.toBeNull();

    state.fail = null;
    await apply(A);
    expect(hook.error).toBeNull();
    expect(hook.busy).toBe(false);
  });
});
