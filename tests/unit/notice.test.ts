import { beforeEach, describe, expect, it, vi } from "vitest";
import { hook, loadHooks, setEverywhere } from "$lib/hook.svelte";
import {
  dismissHooksNotice,
  hooksNoticeDue,
  loadNotices,
  notices,
  resetNotices,
  retireHooksNotice,
} from "$lib/notice.svelte";

vi.mock("$lib/core", () => ({
  core: () => ({
    async hookStatus() {
      return { installed: false, settings: "", events: "" };
    },
    async hookInstall() {
      return { installed: true, settings: "", events: "" };
    },
    async hookUninstall() {
      return { installed: false, settings: "", events: "" };
    },
  }),
}));

/** A setup from before the choice: a workspace on record, hooks off. */
function existingSetup() {
  localStorage.setItem("workbench.workspace", JSON.stringify({ open: [] }));
  localStorage.setItem(
    "workbench.hooks",
    JSON.stringify({ everywhere: false, overrides: {} }),
  );
}

beforeEach(() => {
  localStorage.clear();
  resetNotices();
});

describe("the hooks notice", () => {
  it("is due for a setup with hooks off, and not for a fresh install", () => {
    existingSetup();
    loadHooks();
    loadNotices();
    expect(hooksNoticeDue()).toBe(true);

    localStorage.clear();
    loadHooks();
    loadNotices();
    expect(hook.everywhere).toBe(true);
    expect(hooksNoticeDue()).toBe(false);
  });

  it("stays dismissed across a restart", () => {
    existingSetup();
    loadHooks();
    loadNotices();
    dismissHooksNotice();
    expect(hooksNoticeDue()).toBe(false);
    resetNotices();
    loadNotices();
    expect(notices.hooksDismissed).toBe(true);
    expect(hooksNoticeDue()).toBe(false);
  });

  it("is retired once hooks are on, so turning them off later brings nothing back", async () => {
    existingSetup();
    loadHooks();
    loadNotices();
    await setEverywhere(true, []);
    expect(hooksNoticeDue()).toBe(false);
    retireHooksNotice();
    await setEverywhere(false, []);
    expect(hooksNoticeDue()).toBe(false);
  });

  it("survives storage that is not what it wrote", () => {
    existingSetup();
    localStorage.setItem("workbench.notices", "nonsense");
    loadHooks();
    loadNotices();
    expect(hooksNoticeDue()).toBe(true);
  });
});
