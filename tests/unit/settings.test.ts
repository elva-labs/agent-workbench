import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import Settings from "$lib/components/Settings.svelte";
import { chordFor, keys, resetKeys } from "$lib/keys.svelte";
import { closeSettings, openSettings, settings } from "$lib/settings.svelte";
import { setPalette, setTheme, theme } from "$lib/theme.svelte";

import { hook, reset as resetHook } from "$lib/hook.svelte";
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
  it("has one answer for every project, and lets a project say otherwise", async () => {
    workspace.open.push(repo("/repo", "repo"), repo("/other", "other"));
    workspace.active = "/repo";

    render(Settings);
    const everywhere = within(screen.getByTestId("hooks-everywhere"));
    expect(everywhere.getByTestId("hooks-everywhere-off")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // The overrides are folded away until one is in use.
    const overrides = screen.getByTestId("hooks-overrides");
    expect(overrides).toHaveAttribute("aria-expanded", "false");
    await fireEvent.click(overrides);
    expect(overrides).toHaveAttribute("aria-expanded", "true");
    const rows = screen.getAllByTestId("hooks-row");
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(first.getByTestId("hooks-default")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // The answer for all, applied to both open projects at once.
    await fireEvent.click(everywhere.getByTestId("hooks-everywhere-on"));
    await waitFor(() => expect(fake.hooks["/repo"]).toBe(true));
    await waitFor(() => expect(fake.hooks["/other"]).toBe(true));
    expect(everywhere.getByTestId("hooks-everywhere-on")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // One project says otherwise; the other is untouched.
    await fireEvent.click(first.getByTestId("hooks-off"));
    await waitFor(() => expect(fake.hooks["/repo"]).toBe(false));
    expect(first.getByTestId("hooks-off")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(fake.hooks["/other"]).toBe(true);

    // Asking for what it has is nothing; following the rest again brings it back.
    await fireEvent.click(first.getByTestId("hooks-off"));
    expect(fake.hooks["/repo"]).toBe(false);
    await fireEvent.click(first.getByTestId("hooks-default"));
    await waitFor(() => expect(fake.hooks["/repo"]).toBe(true));
  });

  it("shows the overrides open when a project has one", () => {
    workspace.open.push(repo("/repo", "repo"));
    hook.overrides["/repo"] = false;
    render(Settings);
    const overrides = screen.getByTestId("hooks-overrides");
    expect(overrides).toHaveAttribute("aria-expanded", "true");
    expect(overrides).toHaveTextContent("(1)");
    expect(
      within(screen.getByTestId("hooks-row")).getByTestId("hooks-off"),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("says so when there is no project to choose for", () => {
    render(Settings);
    expect(screen.getByTestId("hooks-none")).toBeInTheDocument();
    expect(screen.queryByTestId("hooks-row")).toBeNull();
    expect(screen.queryByTestId("hooks-overrides")).toBeNull();
    expect(screen.getByTestId("hooks-everywhere")).toBeInTheDocument();
  });

  it("picks a theme", async () => {
    render(Settings);
    await fireEvent.click(screen.getByTestId("theme-dark"));
    expect(theme.choice).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByTestId("theme-dark")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await fireEvent.click(screen.getByTestId("theme-system"));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("picks a colour palette", async () => {
    render(Settings);
    const colours = screen.getByRole("radiogroup", { name: "Colour" });
    expect(within(colours).getAllByRole("radio")).toHaveLength(5);
    await fireEvent.click(screen.getByTestId("palette-indigo"));
    expect(theme.palette).toBe("indigo");
    expect(document.documentElement.dataset.palette).toBe("indigo");
    expect(screen.getByTestId("palette-indigo")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await fireEvent.click(screen.getByTestId("palette-teal"));
    expect(document.documentElement.dataset.palette).toBeUndefined();
  });

  it("switches presets and shows the chords in the platform's glyphs", async () => {
    render(Settings);
    expect(screen.getByTestId("chord-focus.sessions")).toHaveTextContent("⌘1");
    await fireEvent.click(screen.getByTestId("preset-vim"));
    expect(keys.preset).toBe("vim");
    expect(screen.getByTestId("chord-focus.sessions")).toHaveTextContent("⌘H");
    expect(screen.getByTestId("preset-vim")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  // Click a chord, press the new one: recorded, and the table is custom.
  it("records a chord pressed on a row", async () => {
    render(Settings);
    await fireEvent.click(screen.getByTestId("chord-review"));
    expect(screen.getByTestId("chord-review")).toHaveTextContent("Press keys");
    await fireEvent.keyDown(screen.getByTestId("settings"), {
      key: "g",
      metaKey: true,
    });
    expect(chordFor("review")).toEqual({ key: "g", shift: false, alt: false });
    expect(screen.getByTestId("chord-review")).toHaveTextContent("⌘G");
    expect(screen.getByTestId("preset-custom")).toBeInTheDocument();
  });

  it("says why a chord was refused, and keeps the old one", async () => {
    render(Settings);
    await fireEvent.click(screen.getByTestId("chord-review"));
    await fireEvent.keyDown(screen.getByTestId("settings"), {
      key: "e",
      metaKey: true,
    });
    expect(screen.getByTestId("chord-problem")).toHaveTextContent(
      "Diff or whole file",
    );
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
    expect(chordFor("focus.sessions")).toEqual({
      key: "1",
      shift: false,
      alt: false,
    });
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
