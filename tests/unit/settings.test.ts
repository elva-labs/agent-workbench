import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import Settings from "$lib/components/Settings.svelte";
import { chordFor, keys, resetKeys } from "$lib/keys.svelte";
import { closeSettings, openSettings, settings } from "$lib/settings.svelte";
import { setPalette, setTheme, theme } from "$lib/theme.svelte";

import { reset as resetHook } from "$lib/hook.svelte";
import { workspace, reset as resetWorkspace } from "$lib/workspace.svelte";

vi.mock("$lib/platform", () => ({ isMac: () => true, isWindows: () => false }));

const fake = { hooks: {} as Record<string, boolean> };

vi.mock("$lib/core", () => ({
  core: () => ({
    hookStatus: async (project: string) => ({
      installed: fake.hooks[project] === true,
      settings: "",
      events: "",
    }),
    hookInstall: async (project: string) => {
      fake.hooks[project] = true;
      return { installed: true, settings: "", events: "" };
    },
    hookUninstall: async (project: string) => {
      fake.hooks[project] = false;
      return { installed: false, settings: "", events: "" };
    },
  }),
}));

const repo = (path: string, name: string, isGit = true) => ({
  path,
  name,
  repository: isGit ? path : null,
  isGit,
});

beforeEach(() => {
  fake.hooks = {};
  resetHook();
  resetWorkspace();
  resetKeys();
  setTheme("system");
  setPalette("teal");
  openSettings();
});

describe("the settings", () => {
  // Off by default: the hooks edit the project's own settings, so nobody
  // gets them for merely opening a folder.
  it("offers the agent hooks per open project, off, and turns them on when asked", async () => {
    workspace.open.push(repo("/repo", "repo"), repo("/other", "other"));
    workspace.active = "/repo";

    render(Settings);
    const rows = screen.getAllByTestId("hooks-row");
    expect(rows).toHaveLength(2);
    expect(screen.queryByTestId("hooks-none")).toBeNull();
    const first = within(rows[0]);
    await waitFor(() => expect(first.getByTestId("hooks-off")).toHaveAttribute("aria-checked", "true"));

    await fireEvent.click(first.getByTestId("hooks-on"));
    await waitFor(() => expect(first.getByTestId("hooks-on")).toHaveAttribute("aria-checked", "true"));
    expect(fake.hooks["/repo"]).toBe(true);
    // The other project is untouched.
    expect(within(rows[1]).getByTestId("hooks-off")).toHaveAttribute("aria-checked", "true");

    // Asking for what it already has is nothing; asking for the other turns it off.
    await fireEvent.click(first.getByTestId("hooks-on"));
    expect(fake.hooks["/repo"]).toBe(true);
    await fireEvent.click(first.getByTestId("hooks-off"));
    await waitFor(() => expect(first.getByTestId("hooks-off")).toHaveAttribute("aria-checked", "true"));
    expect(fake.hooks["/repo"]).toBe(false);
  });

  it("says so when there is no project to choose for", () => {
    render(Settings);
    expect(screen.getByTestId("hooks-none")).toBeInTheDocument();
    expect(screen.queryByTestId("hooks-row")).toBeNull();
  });

  it("picks a theme", async () => {
    render(Settings);
    await fireEvent.click(screen.getByTestId("theme-dark"));
    expect(theme.choice).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByTestId("theme-dark")).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(screen.getByTestId("theme-system"));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("picks a colour palette", async () => {
    render(Settings);
    expect(screen.getAllByRole("radio", { name: /indigo|amber|rose|mono|teal/i })).toHaveLength(5);
    await fireEvent.click(screen.getByTestId("palette-indigo"));
    expect(theme.palette).toBe("indigo");
    expect(document.documentElement.dataset.palette).toBe("indigo");
    expect(screen.getByTestId("palette-indigo")).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(screen.getByTestId("palette-teal"));
    expect(document.documentElement.dataset.palette).toBeUndefined();
  });

  it("switches presets and shows the chords in the platform's glyphs", async () => {
    render(Settings);
    expect(screen.getByTestId("chord-focus.sessions")).toHaveTextContent("⌘1");
    await fireEvent.click(screen.getByTestId("preset-vim"));
    expect(keys.preset).toBe("vim");
    expect(screen.getByTestId("chord-focus.sessions")).toHaveTextContent("⌘H");
    expect(screen.getByTestId("preset-vim")).toHaveAttribute("aria-checked", "true");
  });

  // Click a chord, press the new one: recorded, and the table is custom.
  it("records a chord pressed on a row", async () => {
    render(Settings);
    await fireEvent.click(screen.getByTestId("chord-review"));
    expect(screen.getByTestId("chord-review")).toHaveTextContent("Press keys");
    await fireEvent.keyDown(screen.getByTestId("settings"), { key: "g", metaKey: true });
    expect(chordFor("review")).toEqual({ key: "g", shift: false, alt: false });
    expect(screen.getByTestId("chord-review")).toHaveTextContent("⌘G");
    expect(screen.getByTestId("preset-custom")).toBeInTheDocument();
  });

  it("says why a chord was refused, and keeps the old one", async () => {
    render(Settings);
    await fireEvent.click(screen.getByTestId("chord-review"));
    await fireEvent.keyDown(screen.getByTestId("settings"), { key: "e", metaKey: true });
    expect(screen.getByTestId("chord-problem")).toHaveTextContent("Diff or whole file");
    expect(chordFor("review")).toEqual({ key: "d", shift: false, alt: false });
  });

  it("gives up recording on Escape, and closes on Escape otherwise", async () => {
    render(Settings);
    await fireEvent.click(screen.getByTestId("chord-review"));
    await fireEvent.keyDown(screen.getByTestId("settings"), { key: "Escape" });
    expect(screen.getByTestId("chord-review")).toHaveTextContent("⌘D");
    expect(settings.open).toBe(true);
    await fireEvent.keyDown(screen.getByTestId("settings"), { key: "Escape" });
    expect(settings.open).toBe(false);
  });

  it("resets one chord to the default", async () => {
    render(Settings);
    await fireEvent.click(screen.getByTestId("preset-vim"));
    await fireEvent.click(screen.getByTestId("reset-focus.sessions"));
    expect(chordFor("focus.sessions")).toEqual({ key: "1", shift: false, alt: false });
    expect(screen.getByTestId("preset-custom")).toBeInTheDocument();
  });

  it("closes from its button and from the scrim", async () => {
    render(Settings);
    await fireEvent.click(screen.getByTestId("settings-close"));
    expect(settings.open).toBe(false);
    openSettings();
    await fireEvent.click(screen.getByTestId("settings-scrim"));
    expect(settings.open).toBe(false);
    closeSettings();
  });
});
