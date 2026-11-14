import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptHooks,
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
  startChecks,
  wanted,
} from "$lib/hook.svelte";

const state = {
  installed: {} as Record<string, boolean>,
  calls: [] as string[],
  fail: null as string | null,
  /** Holds a batch for these projects until released, by its first one. */
  held: {} as Record<string, Promise<void>>,
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
    async hookStatusMany(projects: string[]) {
      state.calls.push(`many:${projects.join(",")}`);
      if (state.fail !== null) throw new Error(state.fail);
      await state.held[projects[0]];
      return projects.map((project) => ({
        installed: state.installed[project] === true,
        settings: "",
        events: "",
      }));
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
  state.held = {};
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

describe("starting", () => {
  const thirty = Array.from({ length: 30 }, (_, at) => `/repo/p${at}`);

  it("asks once for every project the window opened with", async () => {
    hook.starting = true;
    hook.everywhere = false;
    state.installed[thirty[3]] = true;
    for (const project of thirty) ensure(project);
    expect(state.calls).toEqual([]);

    startChecks(() => thirty);
    await vi.waitFor(() =>
      expect(state.calls).toContain(`uninstall:${thirty[3]}`),
    );

    const asked = state.calls.filter((call) => call.startsWith("status:"));
    expect(asked).toEqual([]);
    expect(state.calls.filter((call) => call.startsWith("many:"))).toEqual([
      `many:${thirty.join(",")}`,
    ]);
    // The answers were applied: the one that had them is taken off, as the
    // answer says none, and every project is known.
    expect(state.calls).toContain(`uninstall:${thirty[3]}`);
    expect(thirty.every((project) => isKnown(project))).toBe(true);
  });

  it("installs where the answer is on and the project has none", async () => {
    hook.starting = true;
    hook.everywhere = true;
    state.installed[B] = true;
    startChecks(() => [A, B]);
    await vi.waitFor(() => expect(isInstalled(A)).toBe(true));
    expect(state.calls.filter((call) => call.startsWith("install:"))).toEqual([
      `install:${A}`,
    ]);
    expect(isInstalled(B)).toBe(true);
  });

  it("asks for a project opened afterwards by itself", async () => {
    hook.starting = true;
    hook.everywhere = false;
    startChecks(() => [A, B]);
    await vi.waitFor(() => expect(isKnown(B)).toBe(true));
    state.calls = [];

    ensure("/repo/three");
    ensure(A);
    await vi.waitFor(() => expect(isKnown("/repo/three")).toBe(true));
    expect(state.calls).toEqual(["status:/repo/three"]);
  });

  it("asks once for each machine, and local projects do not wait on a remote one", async () => {
    hook.starting = true;
    hook.everywhere = false;
    let release = () => {};
    state.held["ssh://ada@box/srv/a"] = new Promise<void>((resolve) => {
      release = resolve;
    });
    const projects = [A, "ssh://ada@box/srv/a", B, "ssh://ada@box/srv/b", "ssh://bob@lab/x"];
    startChecks(() => projects);

    await vi.waitFor(() => expect(isKnown(A) && isKnown(B)).toBe(true));
    expect(isKnown("ssh://ada@box/srv/a")).toBe(false);
    expect(state.calls).toEqual([
      `many:${A},${B}`,
      "many:ssh://ada@box/srv/a,ssh://ada@box/srv/b",
      "many:ssh://bob@lab/x",
    ]);

    release();
    await vi.waitFor(() => expect(isKnown("ssh://ada@box/srv/b")).toBe(true));
  });

  it("asks once for a machine whose projects arrive after the local batch", async () => {
    hook.starting = true;
    hook.everywhere = false;
    const box = (name: string) => `ssh://ada@box/srv/${name}`;
    const open = [A, B];
    const arrive: Record<string, () => void> = {};
    const arriving = new Map(
      ["a", "b", "c"].map((name) => [
        box(name),
        new Promise<void>((resolve) => {
          arrive[name] = () => {
            if (name !== "c") open.push(box(name));
            resolve();
          };
        }),
      ]),
    );
    startChecks(() => open, arriving);
    await vi.waitFor(() => expect(isKnown(A) && isKnown(B)).toBe(true));

    // Each arrival is seen by the window's effect, which asks nothing for it.
    arrive.a();
    ensure(box("a"));
    arrive.b();
    ensure(box("b"));
    await Promise.resolve();
    expect(state.calls).toEqual([`many:${A},${B}`]);

    // The last one is given up; the machine is then asked once.
    arrive.c();
    await vi.waitFor(() => expect(isKnown(box("b"))).toBe(true));
    expect(state.calls).toEqual([
      `many:${A},${B}`,
      `many:${box("a")},${box("b")}`,
    ]);
  });

  it("leaves projects held back for their machine to its batch when the core's answer differs", async () => {
    hook.starting = true;
    hook.everywhere = false;
    const box = (name: string) => `ssh://ada@box/srv/${name}`;
    const open = [A, box("a")];
    let arriveB = () => {};
    const arriving = new Map([
      [box("a"), Promise.resolve()],
      [
        box("b"),
        new Promise<void>((resolve) => {
          arriveB = () => {
            open.push(box("b"));
            resolve();
          };
        }),
      ],
    ]);
    startChecks(() => open, arriving);
    await vi.waitFor(() => expect(isKnown(A)).toBe(true));
    ensure(box("a"));
    state.calls = [];

    // The core's answer is on, while box/a waits for box/b.
    adoptHooks({ everywhere: true, overrides: {} }, [A, box("a")]);
    await vi.waitFor(() => expect(state.calls).toEqual([`install:${A}`]));

    arriveB();
    await vi.waitFor(() => expect(isInstalled(box("b"))).toBe(true));
    expect(state.calls).toEqual([
      `install:${A}`,
      `many:${box("a")},${box("b")}`,
      `install:${box("a")}`,
      `install:${box("b")}`,
    ]);
  });

  it("treats a failed request as not installed, without an error", async () => {
    hook.starting = true;
    hook.everywhere = false;
    state.fail = "no home directory";
    startChecks(() => [A, B]);
    await vi.waitFor(() => expect(isKnown(B)).toBe(true));
    expect(isInstalled(A)).toBe(false);
    expect(hook.error).toBeNull();
  });
});
