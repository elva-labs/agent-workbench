import { readFileSync } from "node:fs";
import { flushSync } from "svelte";
import { render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "$lib/core";

const sets: Partial<Settings>[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsSet: async (change: Partial<Settings>) => {
      sets.push(change);
      return change as Settings;
    },
  }),
}));

import UserStyles from "$lib/components/UserStyles.svelte";
import { conductor } from "$lib/conductor.svelte";
import { resetPersist } from "$lib/persist";
import { settings } from "$lib/settings.svelte";
import { settingsAsk } from "$lib/settingsTools.svelte";
import { theme } from "$lib/theme.svelte";
import {
  adoptStyles,
  adoptUserStylesSetting,
  loadUserStyles,
  paintStyles,
  resetUserStyles,
  setUserStyles,
  styleProblem,
  userStyles,
} from "$lib/userStyles.svelte";

const sheet = () => document.getElementById("workbench-user-styles");

beforeEach(() => {
  sets.length = 0;
  resetPersist();
  resetUserStyles();
  localStorage.clear();
  settings.open = false;
  settingsAsk.asking = null;
  conductor.asking = null;
  sheet()?.remove();
});

/** The cases the core's own tests hold a sheet to, read from its source,
    so the two readings cannot drift apart. */
function coreCases(test: string): string[] {
  const rust = readFileSync(
    `${process.cwd()}/src-tauri/crates/core/src/styles.rs`,
    "utf8",
  );
  const start = rust.indexOf(`fn ${test}()`);
  const body = rust.slice(start, rust.indexOf("\n        ] {", start));
  return [...body.matchAll(/^\s*"((?:[^"\\]|\\.)*)",$/gm)].map(([, text]) =>
    JSON.parse(`"${text}"`),
  );
}

describe("styleProblem", () => {
  it("passes every sheet the core passes", () => {
    const cases = coreCases("a_sheet_that_restyles_and_loads_nothing_passes");
    expect(cases.length).toBeGreaterThan(5);
    for (const css of cases) expect(styleProblem(css), css).toBeNull();
  });

  it("refuses every sheet the core refuses", () => {
    const cases = coreCases("a_sheet_that_would_load_anything_is_refused");
    expect(cases.length).toBeGreaterThan(5);
    for (const css of cases) expect(styleProblem(css), css).not.toBeNull();
  });

  it("refuses escapes, which can spell a url", () => {
    expect(styleProblem("body { background: \\75 rl(https://x); }")).toMatch(/backslash/);
  });

  it("refuses a sheet too big", () => {
    expect(styleProblem("a{}".repeat(90_000))).toMatch(/KB/);
  });
});

describe("the sheet in the page", () => {
  it("is written last in the head, and taken out when not shown", () => {
    userStyles.css = "header { color: red; }";
    document.head.appendChild(document.createElement("style"));
    expect(paintStyles(true)).toBe(true);
    expect(sheet()?.textContent).toBe("header { color: red; }");
    expect(document.head.lastElementChild).toBe(sheet());
    expect(paintStyles(true)).toBe(false);
    expect(paintStyles(false)).toBe(true);
    expect(sheet()?.textContent).toBe("");
  });

  it("is laid over the app's only while it is on", () => {
    userStyles.css = "header { color: red; }";
    render(UserStyles);
    flushSync();
    expect(sheet()?.textContent).toBe("");
    userStyles.on = true;
    flushSync();
    expect(sheet()?.textContent).toBe("header { color: red; }");
  });

  it("is set aside while the settings are open or the app asks something", () => {
    userStyles.css = "header { color: red; }";
    userStyles.on = true;
    render(UserStyles);
    flushSync();
    expect(sheet()?.textContent).not.toBe("");

    settings.open = true;
    flushSync();
    expect(sheet()?.textContent).toBe("");
    settings.open = false;
    flushSync();
    expect(sheet()?.textContent).not.toBe("");

    settingsAsk.asking = {
      request: { id: "a", tool: "settings_change", arguments: {}, cwd: "/p", session: null },
      caller: "An agent",
      reason: null,
      changes: [],
      theme: null,
      css: null,
    };
    flushSync();
    expect(sheet()?.textContent).toBe("");
    settingsAsk.asking = null;
    flushSync();

    conductor.asking = { caller: "x" } as never;
    flushSync();
    expect(sheet()?.textContent).toBe("");
    conductor.asking = null;
    flushSync();
    expect(sheet()?.textContent).toBe("header { color: red; }");
  });

  it("is a repaint for the terminals when it changes", () => {
    userStyles.css = "header { color: red; }";
    userStyles.on = true;
    render(UserStyles);
    flushSync();
    const before = theme.painted;
    adoptStyles({ css: ":root { --ansi-red: #ff0000; }", problem: null });
    flushSync();
    expect(theme.painted).toBe(before + 1);
  });
});

describe("the setting", () => {
  it("is sent to the core when the user turns it", () => {
    setUserStyles(true);
    expect(userStyles.on).toBe(true);
    expect(sets).toEqual([{ userStyles: true }]);
  });

  it("is kept with the sheet for the first frame of the next start", () => {
    adoptStyles({ css: "header { color: red; }", problem: null });
    adoptUserStylesSetting(true);
    resetUserStyles();
    loadUserStyles();
    expect(userStyles.on).toBe(true);
    expect(userStyles.css).toBe("header { color: red; }");
  });

  it("does not take a kept sheet that breaks the rules", () => {
    localStorage.setItem(
      "workbench.userStyles",
      JSON.stringify({ on: true, css: "@import 'https://x';" }),
    );
    loadUserStyles();
    expect(userStyles.css).toBe("");
  });

  it("carries the reason a sheet on disk is not used", () => {
    adoptStyles({ css: "", problem: "the stylesheet imports another" });
    expect(userStyles.problem).toBe("the stylesheet imports another");
  });
});
