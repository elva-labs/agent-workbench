import { expect, test, type Locator, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// The window by keyboard alone, in WebKit as well as Chromium. WebKit, the
// app's webview on macOS, passes over a button on Tab unless it carries a
// tab index; one rule gives every control one. A single control is a stop
// in reading order; a list, a radio group or a tab row is one stop walked
// with the arrows; a dialog, the palette and a question in a strip keep
// Tab inside; a pane narrowed away or under a dialog takes none. Each walk
// names what has the keyboard at each step, which is the same in both.
// The walks that pass the window's own controls run as each platform the
// app tells apart, whatever the machine.

const MOD = "ControlOrMeta";
const TREE = "[data-testid='file-tree']";

/** The platforms the app tells apart, by what the browser reports. On
    macOS the system draws the window's controls. On Linux and Windows the
    app draws them at the end of the rightmost header, after the corner,
    and a menu button at the start of the sessions pane's, open or folded;
    each is a stop where it stands. The app's chords there are Ctrl's. */
const PLATFORMS = [
  { name: "macOS", reported: "MacIntel", mod: "Meta", menu: [] as string[], controls: [] as string[] },
  {
    name: "Linux",
    reported: "Linux x86_64",
    mod: "Control",
    menu: ["app-menu"],
    controls: ["Minimize", "Maximize", "Close"],
  },
];
type Platform = (typeof PLATFORMS)[number];

/** The stop `holder` names `name`. */
function stop(page: Page, name: string) {
  return page.locator(`[data-testid="${name}"], [aria-label="${name}"]:not([data-testid])`);
}

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
    divider's line drawn in the accent; a list's cursor on its row; a text
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
    if (owner.getAttribute("role") === "separator") {
      const line = owner.querySelector(".line");
      if (line === null) return false;
      const drawn = getComputedStyle(line);
      return drawn.opacity === "1" && drawn.backgroundColor === colour(root.getPropertyValue("--accent").trim());
    }
    const style = getComputedStyle(owner);
    const accent = colour(root.getPropertyValue("--accent").trim());
    // A row of a list is marked as the tree's cursor is, inside its edge.
    if (style.boxShadow.includes(accent)) return true;
    if (style.outlineStyle === "none" || style.outlineStyle === "auto" || parseFloat(style.outlineWidth) === 0) return false;
    // A check box paints its own box over a ring drawn inside its edge.
    if (owner.matches("input[type='checkbox'], input[type='radio']") && parseFloat(style.outlineOffset) < 0) return false;
    return style.outlineColor === accent;
  });
}

/** How many CSS pixels on each side of `target`, outside its own box,
    change when it loses the keyboard: the part of its ring that can be
    seen there. Read from the screen, so a ring hidden under what the
    control paints, or cut off by what holds it, counts for nothing. */
async function ringOutside(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  const pad = 6;
  const clip = { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
  const ringed = (await page.screenshot({ clip })).toString("base64");
  await target.evaluate((element) => (element as HTMLElement).blur());
  const bare = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(
    async ({ shots, pad, box }) => {
      const pixels = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      const [a, b] = await Promise.all(shots.map(pixels));
      // The shot is in device pixels: the control's box within it, scaled.
      const scale = a.width / (box.width + 2 * pad);
      const [left, top, right, bottom] = [pad * scale, pad * scale, (pad + box.width) * scale, (pad + box.height) * scale];
      const changed = { top: 0, bottom: 0, left: 0, right: 0 };
      for (let y = 0; y < a.height; y++)
        for (let x = 0; x < a.width; x++) {
          const side = y < top ? "top" : y >= bottom ? "bottom" : x < left ? "left" : x >= right ? "right" : null;
          if (side === null) continue;
          const at = (y * a.width + x) * 4;
          const diff =
            Math.abs(a.data[at] - b.data[at]) + Math.abs(a.data[at + 1] - b.data[at + 1]) + Math.abs(a.data[at + 2] - b.data[at + 2]);
          if (diff > 60) changed[side] += 1;
        }
      const css = (count: number) => Math.round(count / (scale * scale));
      return { top: css(changed.top), bottom: css(changed.bottom), left: css(changed.left), right: css(changed.right) };
    },
    { shots: [ringed, bare], pad, box },
  );
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

/** Opens the window, taking itself for `platform` when one is given and
    for the machine's own otherwise. */
async function open(page: Page, width = 1440, platform?: Platform) {
  if (platform !== undefined)
    await page.addInitScript(
      (reported) => Object.defineProperty(Navigator.prototype, "platform", { get: () => reported }),
      platform.reported,
    );
  await page.setViewportSize({ width, height: 900 });
  await installFakeCore(page, {
    open: [PROJECT],
    transcripts: [{ id: "earlier-1", modified: Date.now() - 3_600_000, size: 100, title: "earlier work" }],
  });
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
}

const tree = (page: Page, name: string) => page.locator(TREE).getByText(name, { exact: true });

for (const platform of PLATFORMS)
  test(`walks the panes in reading order, and back, on ${platform.name}`, async ({ page }) => {
    await open(page, 1440, platform);
    // From the window's first stop to its last.
    const stops = [
      ...platform.menu,
      "sessions-nav",
      "Resize projects and sessions",
      "start-other",
      "start-agent",
      "Resize changes",
      "toggle-right",
      "mode-agent",
      ...platform.controls,
      "search-field",
      "mode-files",
      "changes-menu",
      "file-tree",
    ];
    await page.getByTestId(stops[0]).focus();
    expect(await walk(page, "Tab", stops.length - 1)).toEqual(stops.slice(1));
    expect(await walk(page, "Shift+Tab", stops.length - 1)).toEqual(stops.slice(0, -1).reverse());
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
  // A mode picked with the pointer is for typing in: the field has the keyboard.
  await page.getByTestId("mode-lines").click();
  await expect(page.getByTestId("search-field")).toBeFocused();
  await page.keyboard.type("use std");
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

for (const platform of PLATFORMS)
  test(`walks the corner's switch with the arrows and flips the mode with Space, on ${platform.name}`, async ({ page }) => {
    await open(page, 1440, platform);
    // The stop after the switch: the window's own controls where the app
    // draws them, else the changes pane's field.
    const next = platform.controls[0] ?? "search-field";
    await stop(page, next).focus();
    expect(await walk(page, "Shift+Tab", 2)).toEqual(["mode-agent", "toggle-right"]);
    await page.keyboard.press("Tab");
    // One stop: the arrows move the keyboard, and only Space or Enter picks.
    expect(await walk(page, "ArrowRight", 1)).toEqual(["mode-editor"]);
    await expect(page.getByTestId("mode-readout")).toHaveText("working");
    await expect(page.getByTestId("mode-agent")).toHaveAttribute("tabindex", "-1");
    // Still one stop after the arrow: Shift+Tab leaves the switch at once.
    expect(await walk(page, "Shift+Tab", 1)).toEqual(["toggle-right"]);
    expect(await walk(page, "Tab", 2)).toEqual(["mode-agent", next]);
    expect(await walk(page, "Shift+Tab", 1)).toEqual(["mode-agent"]);
    await page.keyboard.press("ArrowRight");
    expect(await walk(page, "Tab", 1)).toEqual([next]);
    expect(await walk(page, "Shift+Tab", 1)).toEqual(["mode-agent"]);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(page.getByTestId("mode-readout")).toHaveText("editing");
    // The keyboard goes where the mode puts it: the tree, with nothing open.
    await expect(page.locator(TREE)).toBeFocused();
  });

for (const platform of PLATFORMS)
  test(`keeps the keyboard on the corner when its button hides the pane it stands in, on ${platform.name}`, async ({
    page,
  }) => {
    await open(page, 1440, platform);
    await stop(page, platform.controls[0] ?? "search-field").focus();
    expect(await walk(page, "Shift+Tab", 2)).toEqual(["mode-agent", "toggle-right"]);
    await page.keyboard.press("Enter");
    await expect(page.locator("section[data-pane='changes']")).toHaveCount(0);
    expect(await holder(page)).toBe("toggle-right");
    // The corner ends the agent's header now, and the window's own
    // controls moved with it, still after the switch.
    expect(await walk(page, "Tab", 2)).toEqual(["mode-agent", platform.controls[0] ?? "start-other"]);
    expect(await walk(page, "Shift+Tab", 2)).toEqual(["mode-agent", "toggle-right"]);
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
    "compact-off",
    "mono-system",
    "sans-system",
    "palette-teal",
    "background-pad",
    "background-add",
    "harmony-single",
    "ready-none",
    "styles-off",
  ];
  expect(await walk(page, "Tab", appearance.length + 1)).toEqual([...appearance, "settings-close"]);
  expect(await walk(page, "Shift+Tab", 2)).toEqual(["styles-off", "ready-none"]);

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

test("rings a check box outside its box, checked or not, in both looks and themes", async ({ page }) => {
  await open(page);
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId("settings")).toBeVisible();
  const box = page.getByTestId("workflow-start-only");
  for (const look of ["modern", "terminal"])
    for (const theme of ["light", "dark"]) {
      await page.getByTestId("settings-tab-appearance").click();
      await page.getByTestId(`look-${look}`).click();
      await page.getByTestId(`theme-${theme}`).click();
      await page.getByTestId("settings-tab-workflows").click();
      for (const checked of [true, false]) {
        await expect(box).toBeChecked({ checked });
        await box.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(box).toBeFocused();
        await expect.poll(() => ringed(page), { message: `the ring on the box, ${look} ${theme}` }).toBe(true);
        const sides = await ringOutside(page, box);
        for (const [side, seen] of Object.entries(sides))
          expect(seen, `the ring's ${side}, ${look} ${theme}, checked ${checked}`).toBeGreaterThan(10);
        await box.focus();
        await page.keyboard.press("Space");
      }
      // A step's check box, in the step's own part.
      const any = page.getByTestId("step-model-any");
      await any.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(any).toBeFocused();
      for (const [side, seen] of Object.entries(await ringOutside(page, any)))
        expect(seen, `the step box's ring's ${side}, ${look} ${theme}`).toBeGreaterThan(10);
    }
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
  // Connecting puts the folders in place of the fields, with the keyboard.
  await page.getByTestId("remote-host").fill("lab");
  await page.getByTestId("remote-connect").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("remote-dir").first()).toBeFocused();
  await expect.poll(() => ringed(page)).toBe(true);
  expect(await walk(page, "Tab", 2)).toEqual(["remote-open", "remote-close"]);
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

for (const platform of PLATFORMS)
  test(`reaches the folded sessions column, and Tab out of the peeked pane puts it back, on ${platform.name}`, async ({
    page,
  }) => {
    await open(page, 1440, platform);
    await tree(page, "lib.rs").click();
    await expect(page.locator("[data-testid='viewer']")).toBeVisible();
    await page.locator(TREE).focus();
    expect(await walk(page, "Tab", 3)).toEqual(["Resize the file tree", "viewer-edit", "Close the viewer"]);
    // The menu button, where the app draws one, heads the folded column,
    // over the button the column is.
    await page.getByTestId("start-other").focus();
    expect(await walk(page, "Shift+Tab", platform.menu.length + 1)).toEqual(["unfold-sessions", ...platform.menu]);
    if (platform.menu.length > 0) await page.keyboard.press("Tab");
    await expect(page.getByTestId("unfold-sessions")).toBeFocused();
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
  await expect(page.locator(".cm-content")).toBeFocused();

  // Asked by Delete on the tab row, it gives the keyboard back to the row.
  const tab = page.locator("[data-testid='editor-tab'][data-path='README.md']");
  await page.getByTestId("search-field").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(tab).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("close-unsaved-cancel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("close-unsaved")).toHaveCount(0);
  await expect(tab).toBeFocused();
  await expect.poll(() => ringed(page)).toBe(true);
  await page.keyboard.press("Delete");
  await page.getByTestId("close-unsaved-confirm").click();
  await expect(page.getByTestId("editor-tab")).toHaveCount(0);
  await expect(page.locator(TREE)).toBeFocused();
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

test("Enter or Space on a shell's row puts the keyboard in that shell, and sends it nothing", async ({ page }) => {
  const [first, second] = await twoShells(page);
  await page.getByTestId("hide-terminal").focus();
  expect(await walk(page, "Tab", 1)).toEqual(["terminal-row"]);
  await expect(row(page, 1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, 0)).toBeFocused();
  await expect(row(page, 1)).toHaveAttribute("aria-selected", "true");
  let from = await writes(page);
  await page.keyboard.press("Enter");
  await expect(row(page, 0)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => holder(page)).toBe("Terminal input");
  expect(await typeInto(page, "ls")).toBe(first);
  // All any shell was sent since the Enter is the typing.
  expect(await sent(page, from)).toEqual({ [first]: "ls" });

  await page.getByTestId("hide-terminal").focus();
  expect(await walk(page, "Tab", 1)).toEqual(["terminal-row"]);
  await expect(row(page, 0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  from = await writes(page);
  await page.keyboard.press("Space");
  await expect(row(page, 1)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => holder(page)).toBe("Terminal input");
  expect(await typeInto(page, "pwd")).toBe(second);
  expect(await sent(page, from)).toEqual({ [second]: "pwd" });
  await expect(page.getByTestId("terminal-row")).toHaveCount(2);
});

test("Delete on a shell's row closes the shell under the keyboard, and keeps the keyboard on the rows", async ({ page }) => {
  const [, second] = await twoShells(page);
  await page.getByTestId("hide-terminal").focus();
  expect(await walk(page, "Tab", 1)).toEqual(["terminal-row"]);
  // The arrows pick nothing, so Delete closes the row the keyboard is on
  // rather than the shell in front.
  await page.keyboard.press("ArrowUp");
  await expect(row(page, 0)).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("terminal-row")).toHaveCount(1);
  await expect(row(page, 0)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => holder(page)).toBe("Terminal input");
  expect(await typeInto(page, "ls")).toBe(second);
  // Tab onto the rows and Backspace closes the last, and the keyboard goes
  // to the pane the panel hands the focus to.
  await page.getByTestId("hide-terminal").focus();
  expect(await walk(page, "Tab", 1)).toEqual(["terminal-row"]);
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("terminal-row")).toHaveCount(0);
  await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  await expect.poll(() => holder(page)).not.toBeNull();
});

for (const platform of PLATFORMS)
  test(`takes no Tab into a pane narrowed away or under a dialog, on ${platform.name}`, async ({ page }) => {
    await open(page, 660, platform);
    await expect(page.locator("section[data-pane='changes']")).toHaveCount(0);
    await expect(page.getByTestId("unfold-sessions")).toBeDisabled();
    await page.getByTestId("start-agent").focus();
    // Once round the window: the agent pane alone, its header then its
    // body, with no sessions and no search. Past the last stop the
    // browser's own window has the keyboard for one press.
    const round = [
      null,
      ...platform.menu,
      "toggle-right",
      "mode-agent",
      ...platform.controls,
      "start-other",
      "start-agent",
    ];
    expect(await walk(page, "Tab", round.length)).toEqual(round);

    await page.keyboard.press(`${platform.mod}+,`);
    await expect(page.getByTestId("settings")).toBeVisible();
    const inside: boolean[] = [];
    for (let at = 0; at < 20; at++) {
      await page.keyboard.press(at % 3 === 2 ? "Shift+Tab" : "Tab");
      inside.push(await page.evaluate(() => document.querySelector("[data-testid='settings']")!.contains(document.activeElement)));
    }
    expect(inside.every(Boolean)).toBe(true);
  });
