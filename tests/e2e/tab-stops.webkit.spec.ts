import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// The window by keyboard alone, in WebKit as well as Chromium. WebKit, the
// app's webview on macOS, passes over a button on Tab unless it carries a
// tab index; one rule gives every control one. A single control is a stop
// in reading order; a list, a radio group or a tab row is one stop walked
// with the arrows; a dialog, the palette and a question in a strip keep
// Tab inside; a pane narrowed away or under a dialog takes none. Each walk
// names what has the keyboard at each step, which is the same in both.

const MOD = "ControlOrMeta";
const TREE = "[data-testid='file-tree']";

/** What has the keyboard: its test id, else its label, else its tag. */
function holder(page: Page) {
  return page.evaluate(() => {
    const owner = document.activeElement as HTMLElement | null;
    if (owner === null || owner === document.body) return null;
    return owner.getAttribute("data-testid") ?? owner.getAttribute("aria-label") ?? owner.tagName.toLowerCase();
  });
}

/** Whether the keyboard's place is drawn in the app's own look: a ring in
    the accent, never the browser's own, or a row's edge in it; a
    splitter's line lit in the accent; a list's cursor on its row; a text
    field's caret. */
function ringed(page: Page) {
  return page.evaluate(() => {
    const owner = document.activeElement as HTMLElement | null;
    if (owner === null) return false;
    if (owner.matches("input:not([type='checkbox']):not([type='radio']), textarea, [contenteditable='true']")) return true;
    if (!owner.matches(":focus-visible")) return false;
    const colour = (value: string) => {
      const probe = document.createElement("i");
      probe.style.color = value;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    const root = getComputedStyle(owner);
    if (owner.matches("[data-testid='file-tree'], [data-testid='sessions-nav']"))
      return owner.querySelector(".cursor") !== null;
    if (owner.getAttribute("role") === "separator")
      return getComputedStyle(owner, "::after").backgroundColor === colour(root.getPropertyValue("--splitter-hover").trim());
    const style = getComputedStyle(owner);
    const accent = colour(root.getPropertyValue("--accent").trim());
    // A row of a list is marked as the tree's cursor is, inside its edge.
    if (style.boxShadow.includes(accent)) return true;
    if (style.outlineStyle === "none" || style.outlineStyle === "auto" || parseFloat(style.outlineWidth) === 0) return false;
    return style.outlineColor === accent;
  });
}

/** Presses `key` `times` times and names what has the keyboard after
    each, checking that each place is drawn. */
async function walk(page: Page, key: string, times: number) {
  const names: (string | null)[] = [];
  for (let at = 0; at < times; at++) {
    await page.keyboard.press(key);
    const name = await holder(page);
    names.push(name);
    if (name !== null) await expect.poll(() => ringed(page), { message: `the ring on ${name}` }).toBe(true);
  }
  return names;
}

async function open(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await installFakeCore(page, {
    open: [PROJECT],
    transcripts: [{ id: "earlier-1", modified: Date.now() - 3_600_000, size: 100, title: "earlier work" }],
  });
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
}

const tree = (page: Page, name: string) => page.locator(TREE).getByText(name, { exact: true });

test("walks the panes in reading order, and back", async ({ page }) => {
  await open(page);
  await page.getByTestId("sessions-nav").focus();
  const forward = [
    "Resize projects and sessions",
    "start-other",
    "start-agent",
    "Resize changes",
    "toggle-right",
    "mode-agent",
    "search-field",
    "mode-files",
    "changes-menu",
    "file-tree",
  ];
  expect(await walk(page, "Tab", forward.length)).toEqual(forward);
  expect(await walk(page, "Shift+Tab", forward.length)).toEqual([...forward.slice(0, -1).reverse(), "sessions-nav"]);
});

test("presses a header button by Enter, and walks its menu with the arrows", async ({ page }) => {
  await open(page);
  await page.getByTestId("search-field").focus();
  expect(await walk(page, "Tab", 2)).toEqual(["mode-files", "changes-menu"]);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("changes-menu-items")).toBeVisible();
  expect(await holder(page)).toBe("menu-scope-changed");
  expect(await walk(page, "ArrowDown", 2)).toEqual(["menu-scope-all", "menu-reload"]);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("changes-menu-items")).toHaveCount(0);
  expect(await holder(page)).toBe("changes-menu");
  // Tab out of an open menu takes the menu with it.
  await page.keyboard.press("Space");
  await expect(page.getByTestId("changes-menu-items")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("changes-menu-items")).toHaveCount(0);
  expect(await holder(page)).toBe("file-tree");
});

test("walks the lines found as one stop, with Up and Down", async ({ page }) => {
  await open(page);
  await page.getByTestId("mode-lines").click();
  await page.getByTestId("search-field").fill("use std");
  await expect(page.getByTestId("search-hit")).toHaveCount(3);
  await page.getByTestId("search-field").focus();
  expect(await walk(page, "Tab", 3)).toEqual(["mode-lines", "changes-menu", "search-hit"]);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("search-hit").nth(1)).toBeFocused();
  expect(await walk(page, "Shift+Tab", 1)).toEqual(["changes-menu"]);
  // The stop goes back to the first hit once the keyboard has left.
  expect(await walk(page, "Tab", 1)).toEqual(["search-hit"]);
  await expect(page.getByTestId("search-hit").first()).toBeFocused();
});

test("walks the corner's switch with the arrows and flips the mode with Space", async ({ page }) => {
  await open(page);
  await page.getByTestId("search-field").focus();
  expect(await walk(page, "Shift+Tab", 2)).toEqual(["mode-agent", "toggle-right"]);
  await page.keyboard.press("Tab");
  // One stop: the arrows move the keyboard, and only Space or Enter picks.
  expect(await walk(page, "ArrowRight", 1)).toEqual(["mode-editor"]);
  await expect(page.getByTestId("mode-readout")).toHaveText("working");
  expect(await walk(page, "Tab", 1)).toEqual(["search-field"]);
  expect(await walk(page, "Shift+Tab", 1)).toEqual(["mode-agent"]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("mode-readout")).toHaveText("editing");
  // The keyboard goes where the mode puts it: the tree, with nothing open.
  await expect(page.locator(TREE)).toBeFocused();
});

test("keeps the keyboard on the corner when its button hides the pane it stands in", async ({ page }) => {
  await open(page);
  await page.getByTestId("search-field").focus();
  expect(await walk(page, "Shift+Tab", 2)).toEqual(["mode-agent", "toggle-right"]);
  await page.keyboard.press("Enter");
  await expect(page.locator("section[data-pane='changes']")).toHaveCount(0);
  expect(await holder(page)).toBe("toggle-right");
  await page.keyboard.press("Enter");
  await expect(page.locator("section[data-pane='changes']")).toBeVisible();
  expect(await holder(page)).toBe("toggle-right");
});

test("walks the settings, every section and its controls, and never leaves them", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("settings")).toBeVisible();
  const appearance = [
    "settings-close",
    "settings-tab-appearance",
    "theme-system",
    "look-modern",
    "mono-system",
    "sans-system",
    "palette-teal",
    "styles-off",
  ];
  expect(await walk(page, "Tab", appearance.length + 1)).toEqual([...appearance, "settings-close"]);
  expect(await walk(page, "Shift+Tab", 2)).toEqual(["styles-off", "palette-teal"]);

  // A radio group is one stop: the arrows walk it, and Space picks.
  await page.getByTestId("theme-system").focus();
  expect(await walk(page, "ArrowRight", 2)).toEqual(["theme-light", "theme-dark"]);
  await expect(page.getByTestId("theme-system")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-checked", "true");
  expect(await walk(page, "Tab", 1)).toEqual(["look-modern"]);
  expect(await walk(page, "Shift+Tab", 1)).toEqual(["theme-dark"]);

  // The tabs are one stop, on the one shown; the arrows show the next.
  await page.getByTestId("settings-tab-appearance").focus();
  expect(await walk(page, "ArrowDown", 1)).toEqual(["settings-tab-live"]);
  expect(await walk(page, "Tab", 2)).toEqual(["hooks-everywhere-off", "hooks-overrides"]);
  for (const [tab, first] of [
    ["sessions", "session-kind-terminal"],
    ["workflows", "workflow-chip"],
    ["accounts", "account-add-open"],
    ["plugins", "plugin-off"],
    ["keys", "preset-default"],
    ["notifications", "notifications-on"],
  ] as const) {
    await page.getByTestId(`settings-tab-${tab}`).focus();
    await page.keyboard.press("Enter");
    expect(await walk(page, "Tab", 1), tab).toEqual([first]);
    // The workflows are one stop, and New workflow one after them.
    if (tab === "workflows") expect(await walk(page, "Tab", 1)).toEqual(["workflow-new"]);
  }
  expect(await walk(page, "Tab", 2)).toEqual(["chime-off", "settings-close"]);
  // Enter on a button presses it.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("settings")).toHaveCount(0);
});

test("walks a dialog's own buttons round its ends", async ({ page }) => {
  await open(page);
  await page.getByTestId("earlier-sessions").click();
  await expect(page.getByTestId("resume-filter")).toBeFocused();
  // The sessions are walked from the filter, so they are no stops.
  expect(await walk(page, "Tab", 2)).toEqual(["resume-close", "resume-filter"]);
  expect(await walk(page, "Shift+Tab", 2)).toEqual(["resume-close", "resume-filter"]);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("resume")).toHaveCount(0);

  await page.getByTestId("sessions-nav").focus();
  await page.getByTestId("sessions-menu").click();
  await page.getByTestId("open-remote").click();
  await expect(page.getByTestId("remote-token")).toBeFocused();
  expect(await walk(page, "Tab", 5)).toEqual(["remote-pair", "remote-host", "remote-connect", "remote-close", "remote-token"]);
  expect(await walk(page, "Shift+Tab", 2)).toEqual(["remote-close", "remote-connect"]);
});

test("keeps Tab in the palette's field", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${MOD}+Shift+P`);
  await expect(page.getByTestId("palette-field")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("palette-field")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("palette-field")).toBeFocused();
});

test("reaches the folded sessions column, and Tab out of the peeked pane puts it back", async ({ page }) => {
  await open(page);
  await tree(page, "lib.rs").click();
  await expect(page.locator("[data-testid='viewer']")).toBeVisible();
  await page.locator(TREE).focus();
  expect(await walk(page, "Tab", 3)).toEqual(["Resize the file tree", "viewer-edit", "Close the viewer"]);
  await page.getByTestId("start-other").focus();
  expect(await walk(page, "Shift+Tab", 1)).toEqual(["unfold-sessions"]);
  await page.keyboard.press("Enter");
  await expect(page.locator(".sessions-slot.peeking")).toHaveCount(1);
  await expect(page.getByTestId("sessions-nav")).toBeFocused();
  // The agent's controls are under the peeked pane: Tab does not reach them.
  await page.keyboard.press("Tab");
  await expect(page.locator(".sessions-slot.peeking")).toHaveCount(0);
  await expect(page.locator(TREE)).toBeFocused();
});

test("walks editor mode: the tree, the tab row and the views as one stop each", async ({ page }) => {
  await open(page, 1728);
  await page.keyboard.press(`${MOD}+Shift+E`);
  await expect(page.getByTestId("mode-readout")).toHaveText("editing");
  await tree(page, "README.md").dblclick();
  await tree(page, "Cargo.toml").dblclick();
  await expect(page.getByTestId("editor-tab")).toHaveCount(2);
  await expect(page.locator("[data-testid='editor-tab'][data-path='Cargo.toml']")).toHaveAttribute("aria-selected", "true");
  await page.locator(TREE).focus();
  expect(await walk(page, "Shift+Tab", 7)).toEqual([
    "changes-menu",
    "mode-files",
    "search-field",
    "editor-view-edit",
    "editor-tab",
    "tree-new-folder",
    "tree-new-file",
  ]);
  // The tab row: its stop is the tab in front; the arrows walk the tabs and
  // Enter brings one to the front, with the keyboard in the editor.
  await page.getByTestId("search-field").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("[data-testid='editor-tab'][data-path='Cargo.toml']")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("[data-testid='editor-tab'][data-path='README.md']")).toBeFocused();
  await expect(page.locator("[data-testid='editor-tab'][data-path='Cargo.toml']")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-testid='editor-tab'][data-path='README.md']")).toHaveAttribute("aria-selected", "true");
  const content = page.locator(".cm-content");
  await expect(content).toBeFocused();
  // The editor keeps Tab: it indents, and the keyboard stays.
  const before = await content.textContent();
  await page.keyboard.press("Tab");
  await expect(content).toBeFocused();
  expect(await content.textContent()).not.toBe(before);
  // Delete on a tab closes it, and the keyboard stays on the row, on the
  // tab in front.
  await page.keyboard.press(`${MOD}+3`);
  await expect(page.locator(TREE)).toBeFocused();
  for (let at = 0; at < 5; at++) await page.keyboard.press("Shift+Tab");
  await expect(page.locator("[data-testid='editor-tab'][data-path='README.md']")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-testid='editor-tab'][data-path='Cargo.toml']")).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("editor-tab")).toHaveCount(1);
  await expect(page.locator("[data-testid='editor-tab'][data-path='README.md']")).toBeFocused();
});

test("goes round a question in a strip, starting on Cancel", async ({ page }) => {
  await open(page, 1728);
  await page.keyboard.press(`${MOD}+Shift+E`);
  await tree(page, "README.md").dblclick();
  await page.locator(".cm-content").click();
  await page.keyboard.type("more");
  await page.keyboard.press(`${MOD}+w`);
  await expect(page.getByTestId("close-unsaved-cancel")).toBeFocused();
  const round = await walk(page, "Tab", 3);
  expect(round[2]).toBe("close-unsaved-cancel");
  expect(round.slice(0, 2).every((name) => name?.startsWith("close-unsaved-"))).toBe(true);
  expect(await walk(page, "Shift+Tab", 1)).toEqual([round[1]]);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("close-unsaved")).toHaveCount(0);
});

test("reaches the terminal panel's own controls before its shell", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${MOD}+J`);
  await expect(page.getByTestId("terminal-row")).toHaveCount(1);
  await page.locator(TREE).focus();
  expect(await walk(page, "Tab", 7)).toEqual([
    "Resize the terminal",
    "new-terminal",
    "split-terminal",
    "hide-terminal",
    "terminal-row",
    "Resize the terminal list",
    "Terminal input",
  ]);
  // The shell keeps Tab.
  expect(await walk(page, "Tab", 1)).toEqual(["Terminal input"]);
  await page.getByTestId("hide-terminal").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-row")).toBeHidden();
});

/** What each pty was sent from the `from`th write on, by its id. */
function sent(page: Page, from: number) {
  return page.evaluate((from) => {
    const out: Record<string, string> = {};
    for (const [id, data] of ((window as unknown as { __written?: [string, string][] }).__written ?? []).slice(from))
      out[id] = (out[id] ?? "") + data;
    return out;
  }, from);
}

const writes = (page: Page) =>
  page.evaluate(() => ((window as unknown as { __written?: unknown[] }).__written ?? []).length);

/** Types `text` and names the one pty it reached. */
async function typeInto(page: Page, text: string) {
  const from = await writes(page);
  await page.keyboard.type(text);
  await expect.poll(async () => Object.values(await sent(page, from)).join("")).toBe(text);
  const reached = Object.keys(await sent(page, from));
  expect(reached).toHaveLength(1);
  return reached[0];
}

/** The panel with two shells, the second in front with the keyboard; the
    ptys of the two, in order. */
async function twoShells(page: Page) {
  await open(page);
  await page.keyboard.press(`${MOD}+J`);
  await expect(page.getByTestId("terminal-row")).toHaveCount(1);
  await expect.poll(() => holder(page)).toBe("Terminal input");
  const first = await typeInto(page, "a");
  await page.getByTestId("new-terminal").click();
  await expect(page.getByTestId("terminal-row")).toHaveCount(2);
  await expect.poll(() => holder(page)).toBe("Terminal input");
  const second = await typeInto(page, "b");
  expect(second).not.toBe(first);
  return [first, second];
}

const row = (page: Page, at: number) => page.getByTestId("terminal-row").nth(at);

test("a click on a shell's row puts the keyboard in that shell", async ({ page }) => {
  const [first, second] = await twoShells(page);
  await row(page, 0).click();
  await expect(row(page, 0)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => holder(page)).toBe("Terminal input");
  expect(await typeInto(page, "echo hi")).toBe(first);
  // Backspace is the shell's, and closes nothing.
  const from = await writes(page);
  await page.keyboard.press("Backspace");
  await expect.poll(() => sent(page, from)).toEqual({ [first]: "\x7f" });
  await expect(page.getByTestId("terminal-row")).toHaveCount(2);
  await row(page, 1).click();
  await expect.poll(() => holder(page)).toBe("Terminal input");
  expect(await typeInto(page, "ls")).toBe(second);
});

test("Enter on a shell's row puts the keyboard in that shell", async ({ page }) => {
  const [first] = await twoShells(page);
  await page.getByTestId("hide-terminal").focus();
  expect(await walk(page, "Tab", 1)).toEqual(["terminal-row"]);
  await expect(row(page, 1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, 0)).toBeFocused();
  await expect(row(page, 1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(row(page, 0)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => holder(page)).toBe("Terminal input");
  expect(await typeInto(page, "ls")).toBe(first);
  await expect(page.getByTestId("terminal-row")).toHaveCount(2);
});

test("Delete on a shell's row closes it only once the arrows have walked the rows", async ({ page }) => {
  await twoShells(page);
  await page.getByTestId("hide-terminal").focus();
  expect(await walk(page, "Tab", 1)).toEqual(["terminal-row"]);
  // Tab onto the rows alone closes nothing.
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("terminal-row")).toHaveCount(2);
  await expect(row(page, 1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("terminal-row")).toHaveCount(1);
  // The keyboard stays on the rows, and the next Delete closes the last.
  await expect(row(page, 0)).toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("terminal-row")).toHaveCount(0);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  await expect.poll(() => holder(page)).not.toBeNull();
});

test("takes no Tab into a pane narrowed away or under a dialog", async ({ page }) => {
  await open(page, 660);
  await expect(page.locator("section[data-pane='changes']")).toHaveCount(0);
  await expect(page.getByTestId("unfold-sessions")).toBeDisabled();
  await page.getByTestId("start-agent").focus();
  const names = await walk(page, "Tab", 6);
  expect(names).not.toContain("sessions-nav");
  expect(names).not.toContain("search-field");
  expect(names).toContain("start-agent");

  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("settings")).toBeVisible();
  const inside: boolean[] = [];
  for (let at = 0; at < 20; at++) {
    await page.keyboard.press(at % 3 === 2 ? "Shift+Tab" : "Tab");
    inside.push(await page.evaluate(() => document.querySelector("[data-testid='settings']")!.contains(document.activeElement)));
  }
  expect(inside.every(Boolean)).toBe(true);
});
