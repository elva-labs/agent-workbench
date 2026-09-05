import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Settings from "$lib/components/Settings.svelte";
import { chordFor, keys, resetKeys } from "$lib/keys.svelte";
import { closeSettings, openSettings, settings } from "$lib/settings.svelte";
import { setTheme, theme } from "$lib/theme.svelte";

vi.mock("$lib/platform", () => ({ isMac: () => true, isWindows: () => false }));

beforeEach(() => {
  resetKeys();
  setTheme("system");
  openSettings();
});

describe("the settings", () => {
  it("picks a theme", async () => {
    render(Settings);
    await fireEvent.click(screen.getByTestId("theme-dark"));
    expect(theme.choice).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByTestId("theme-dark")).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(screen.getByTestId("theme-system"));
    expect(document.documentElement.dataset.theme).toBeUndefined();
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
