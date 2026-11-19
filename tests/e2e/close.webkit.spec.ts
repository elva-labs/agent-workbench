import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// Close closes what is in front, wherever the keyboard is: the dialog or
// the palette, the shell in front with the keyboard in the terminal panel,
// the browser's tab, the editor's tab, the viewer, and where nothing
// smaller is in front the window, which asks first while sessions run. A
// shell with something running in it asks first too. It is Cmd+W on
// macOS from anywhere; elsewhere Ctrl+W outside a terminal, which keeps
// it, and Ctrl+Shift+W from anywhere. Each walk that differs runs as each
// platform the app tells apart, whatever the machine, in WebKit and
// Chromium.

const PLATFORMS = [
  { name: "macOS", reported: "MacIntel", mod: "Meta", close: "Meta+w", inTerminal: "Meta+w" },
  { name: "Linux", reported: "Linux x86_64", mod: "Control", close: "Control+w", inTerminal: "Control+Shift+W" },
];
type Platform = (typeof PLATFORMS)[number];
const MAC = PLATFORMS[0];
const LINUX = PLATFORMS[1];

const ROW = "[data-testid='terminal-row']";
const TERMINAL = "section[data-pane='terminal']";
const TREE = "[data-testid='file-tree']";

async function open(page: Page, platform: Platform) {
  await page.addInitScript(
    (reported) => Object.defineProperty(Navigator.prototype, "platform", { get: () => reported }),
    platform.reported,
  );
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
}

function holder(page: Page) {
  return page.evaluate(() => {
    const owner = document.activeElement as HTMLElement | null;
    if (owner === null || owner === document.body) return null;
    return owner.getAttribute("data-testid") ?? owner.getAttribute("aria-label") ?? owner.tagName.toLowerCase();
  });
}

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

async function typeInto(page: Page, text: string) {
  const from = await writes(page);
  await page.keyboard.type(text);
  await expect.poll(async () => Object.values(await sent(page, from)).join("")).toBe(text);
  const reached = Object.keys(await sent(page, from));
  expect(reached).toHaveLength(1);
  return reached[0];
}

/** What the window asked of its controls: a close, a quit. */
const controls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __windowControls?: string[] }).__windowControls ?? []);

/** What Close in the File menu is called now. */
const closeName = (page: Page) =>
  page.evaluate(() => (window as unknown as { __menuText?: Record<string, string> }).__menuText?.["file.close"]);

/** Starts a session, with the keyboard in its terminal; its pty. */
async function startSession(page: Page) {
  await page.getByTestId("start-agent").click();
  await expect.poll(() => holder(page)).toBe("Terminal input");
  return typeInto(page, "x");
}

/** Opens the panel with one shell, the keyboard in it; its pty. */
async function openShell(page: Page, platform: Platform = MAC) {
  await page.keyboard.press(`${platform.mod}+j`);
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect.poll(() => holder(page)).toBe("Terminal input");
  return typeInto(page, "a");
}

/** Says something runs under a pty, as the core would read it. */
function running(page: Page, pty: string, command: string) {
  return page.evaluate(
    ({ pty, command }) => {
      const w = window as unknown as { __processes?: Record<string, unknown[]> };
      (w.__processes ??= {})[pty] = [
        { pid: 20, parent: 10, name: command.split(" ")[0], command, cpu: 0, memory: 0, started: 1 },
      ];
    },
    { pty, command },
  );
}

test.describe("a shell", () => {
  for (const platform of PLATFORMS) {
    test(`at an idle prompt closes at once, the keyboard going to the shell left, on ${platform.name}`, async ({ page }) => {
      await open(page, platform);
      const first = await openShell(page, platform);
      await page.getByTestId("new-terminal").click();
      await expect(page.locator(ROW)).toHaveCount(2);
      await expect.poll(() => holder(page)).toBe("Terminal input");
      await expect.poll(() => closeName(page)).toBe("Close Shell");
      await page.keyboard.press(platform.inTerminal);
      await expect(page.locator(ROW)).toHaveCount(1);
      await expect.poll(() => holder(page)).toBe("Terminal input");
      expect(await typeInto(page, "ls")).toBe(first);
      // The last takes the panel with it, and the keyboard goes to the agent pane.
      await page.keyboard.press(platform.inTerminal);
      await expect(page.locator(TERMINAL)).toBeHidden();
      await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
      expect(await controls(page)).toEqual([]);
    });
  }

  test("keeps Ctrl+W off macOS, where it deletes a word in the shell", async ({ page }) => {
    await open(page, LINUX);
    const shell = await openShell(page, LINUX);
    const from = await writes(page);
    await page.keyboard.press("Control+w");
    await expect.poll(() => sent(page, from)).toEqual({ [shell]: "\x17" });
    await expect(page.locator(ROW)).toHaveCount(1);
  });

  test("keeps Ctrl+W on macOS too, where the app's chord is Cmd+W", async ({ page }) => {
    await open(page, MAC);
    const shell = await openShell(page);
    const from = await writes(page);
    await page.keyboard.press("Control+w");
    await expect.poll(() => sent(page, from)).toEqual({ [shell]: "\x17" });
    await expect(page.locator(ROW)).toHaveCount(1);
  });

  for (const platform of PLATFORMS) {
    test(`with something running asks first, Cancel in front, and Escape gives the keyboard back, on ${platform.name}`, async ({ page }) => {
      await open(page, platform);
      const shell = await openShell(page, platform);
      await running(page, shell, "npm run dev");
      await page.keyboard.press(platform.inTerminal);
      const ask = page.getByTestId("close-shell");
      await expect(ask).toContainText("Close shell 1?");
      await expect(ask).toContainText("“npm run dev” is still running in it");
      await expect(page.getByTestId("close-shell-cancel")).toBeFocused();
      // A second press neither answers nor reaches past it.
      await page.keyboard.press(platform.inTerminal);
      await expect(ask).toBeVisible();
      await expect(page.locator(ROW)).toHaveCount(1);
      expect(await controls(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(ask).toHaveCount(0);
      await expect.poll(() => holder(page)).toBe("Terminal input");
      expect(await typeInto(page, "q")).toBe(shell);

      await page.keyboard.press(platform.inTerminal);
      await expect(ask).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("close-shell-confirm")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator(TERMINAL)).toBeHidden();
      await expect(page.locator(ROW)).toHaveCount(0);
    });
  }

  test("with something running has its question go with the panel, closing nothing", async ({ page }) => {
    await open(page, MAC);
    const shell = await openShell(page);
    await running(page, shell, "npm run dev");
    await page.keyboard.press("Meta+w");
    await expect(page.getByTestId("close-shell")).toBeVisible();
    await page.keyboard.press("Meta+j");
    await expect(page.locator(TERMINAL)).toBeHidden();
    await expect(page.getByTestId("close-shell")).toHaveCount(0);
    await page.keyboard.press("Meta+j");
    await expect(page.locator(TERMINAL)).toBeVisible();
    await expect(page.getByTestId("close-shell")).toHaveCount(0);
    await expect(page.locator(ROW)).toHaveCount(1);
    await expect.poll(() => holder(page)).toBe("Terminal input");
  });

  test("with something running puts the keyboard back on its question when closed again from the shell", async ({ page }) => {
    await open(page, MAC);
    const shell = await openShell(page);
    await running(page, shell, "npm run dev");
    await page.keyboard.press("Meta+w");
    const cancel = page.getByTestId("close-shell-cancel");
    await expect(cancel).toBeFocused();
    await page.locator("[data-testid='terminal-slot'].on").click({ position: { x: 40, y: 120 } });
    await expect.poll(() => holder(page)).toBe("Terminal input");
    await page.keyboard.press("Meta+w");
    await expect(cancel).toBeFocused();
    await expect(page.getByTestId("close-shell")).toHaveCount(1);
    await expect(page.locator(ROW)).toHaveCount(1);
  });

  test("draws Cancel as the answer Return gives, when the question came from a click", async ({ page }) => {
    await open(page, MAC);
    const shell = await openShell(page);
    await running(page, shell, "sleep 30");
    await page.locator(ROW).hover();
    await page.getByTestId("close-terminal").click();
    const cancel = page.getByTestId("close-shell-cancel");
    await expect(cancel).toBeFocused();
    const ring = await cancel.evaluate((button) => {
      const style = getComputedStyle(button);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(ring.style).toBe("solid");
    expect(ring.width).toBeGreaterThan(0);
  });

  test("with something running asks on its row's Delete, and the keyboard goes back to the row", async ({ page }) => {
    await open(page, MAC);
    const shell = await openShell(page);
    await running(page, shell, "sleep 30");
    await page.getByTestId("hide-terminal").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator(ROW)).toBeFocused();
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("close-shell")).toContainText("sleep 30");
    await expect(page.getByTestId("close-shell-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(ROW)).toBeFocused();
    await expect(page.locator(ROW)).toHaveCount(1);
  });

  test("with something running asks on its ×, and closes once answered", async ({ page }) => {
    await open(page, MAC);
    const shell = await openShell(page);
    await running(page, shell, "sleep 30");
    await page.locator(ROW).hover();
    await page.getByTestId("close-terminal").click();
    await expect(page.getByTestId("close-shell")).toBeVisible();
    await page.getByTestId("close-shell-confirm").click();
    await expect(page.locator(ROW)).toHaveCount(0);
  });
}
);

test.describe("the window", () => {
  for (const platform of PLATFORMS) {
    test(`asks before it closes while a session runs, and Cancel keeps everything, on ${platform.name}`, async ({ page }) => {
      await open(page, platform);
      const agent = await startSession(page);
      await expect.poll(() => closeName(page)).toBe("Close Window");
      await page.keyboard.press(platform.inTerminal);
      const ask = page.getByTestId("close-window");
      await expect(ask).toContainText("Close the window with 1 session running?");
      await expect(ask).toContainText("Closing the window quits the app");
      await expect(page.getByTestId("close-window-cancel")).toBeFocused();
      await expect(page.getByTestId("close-window-confirm")).toHaveText("Close window");
      // Return answers Cancel.
      await page.keyboard.press("Enter");
      await expect(ask).toHaveCount(0);
      expect(await controls(page)).toEqual([]);
      await expect.poll(() => holder(page)).toBe("Terminal input");
      expect(await typeInto(page, "y")).toBe(agent);

      await page.keyboard.press(platform.inTerminal);
      await page.getByTestId("close-window-confirm").click();
      await expect.poll(() => controls(page)).toEqual(["close"]);
    });
  }

  test("leaves Ctrl+W to the agent off macOS", async ({ page }) => {
    await open(page, LINUX);
    const agent = await startSession(page);
    const from = await writes(page);
    await page.keyboard.press("Control+w");
    await expect.poll(() => sent(page, from)).toEqual({ [agent]: "\x17" });
    await expect(page.getByTestId("close-window")).toHaveCount(0);
  });

  test("asks before it closes while a shell has something running, with no session", async ({ page }) => {
    await open(page, MAC);
    const shell = await openShell(page);
    await running(page, shell, "npm run dev");
    await page.locator(TREE).focus();
    await page.keyboard.press("Meta+w");
    const ask = page.getByTestId("close-window");
    await expect(ask).toContainText("Close the window with 1\u00a0busy shell running?");
    await expect(ask).toContainText("“npm run dev” is running in shell 1");
    await expect(page.getByTestId("close-window-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    expect(await controls(page)).toEqual([]);
    // With the panel hidden, by the window's own close as much as the chord.
    await page.keyboard.press("Meta+j");
    await expect(page.locator(TERMINAL)).toBeHidden();
    await page.evaluate(() =>
      (window as unknown as { __CHORD_CORE__: { windowControl: (a: string) => Promise<void> } }).__CHORD_CORE__.windowControl("close"),
    );
    await expect(ask).toContainText("busy shell");
    await page.getByTestId("close-window-confirm").click();
    await expect.poll(() => controls(page)).toEqual(["close"]);
  });

  test("closes at once with only an idle shell open and no session", async ({ page }) => {
    await open(page, MAC);
    await openShell(page);
    await page.locator(TREE).focus();
    await page.keyboard.press("Meta+w");
    await expect.poll(() => controls(page)).toEqual(["close"]);
    await expect(page.getByTestId("close-window")).toHaveCount(0);
  });

  test("closes at once with no session running", async ({ page }) => {
    await open(page, MAC);
    await page.locator(TREE).focus();
    await page.keyboard.press("Meta+w");
    await expect.poll(() => controls(page)).toEqual(["close"]);
    await expect(page.getByTestId("close-window")).toHaveCount(0);
  });

  test("asks the same on the window's own close, and on quit", async ({ page }) => {
    await open(page, MAC);
    await startSession(page);
    await page.evaluate(() =>
      (window as unknown as { __CHORD_CORE__: { windowControl: (a: string) => Promise<void> } }).__CHORD_CORE__.windowControl("close"),
    );
    await expect(page.getByTestId("close-window")).toContainText("Close the window with 1 session running?");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("close-window")).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __quit: () => void }).__quit());
    await expect(page.getByTestId("close-window")).toContainText("Quit with 1 session running?");
    await page.getByTestId("close-window-confirm").click();
    await expect.poll(() => controls(page)).toEqual(["quit"]);
  });
});

test.describe("what is in front", () => {
  test("is the viewer while reviewing, not the window", async ({ page }) => {
    await open(page, MAC);
    await startSession(page);
    await page.locator(TREE).getByText("lib.rs", { exact: true }).click();
    await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "reviewing");
    await expect.poll(() => closeName(page)).toBe("Close Viewer");
    await page.keyboard.press("Meta+2");
    await page.keyboard.press("Meta+w");
    await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "working");
    await expect(page.getByTestId("close-window")).toHaveCount(0);
  });

  test("is the browser's tab, then the viewer it was shown in", async ({ page }) => {
    await open(page, MAC);
    await page.getByTestId("changes-menu").click();
    await page.getByTestId("menu-browser").click();
    await expect(page.getByTestId("browser-tab")).toHaveCount(1);
    await expect.poll(() => closeName(page)).toBe("Close Tab");
    await page.keyboard.press("Meta+w");
    await expect(page.getByTestId("browser-tab")).toHaveCount(0);
    await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "reviewing");
    await page.keyboard.press("Meta+w");
    await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "working");
    expect(await controls(page)).toEqual([]);
  });

  test("is the settings, or the palette, over everything else", async ({ page }) => {
    await open(page, MAC);
    await openShell(page);
    await page.keyboard.press("Meta+,");
    await expect(page.getByTestId("settings")).toBeVisible();
    await page.keyboard.press("Meta+w");
    await expect(page.getByTestId("settings")).toHaveCount(0);
    await expect(page.locator(ROW)).toHaveCount(1);
    await expect.poll(() => holder(page)).toBe("Terminal input");
    await page.keyboard.press("Meta+Shift+p");
    await expect(page.getByTestId("palette-field")).toBeFocused();
    await page.keyboard.press("Meta+w");
    await expect(page.getByTestId("palette-field")).toHaveCount(0);
    await expect(page.locator(ROW)).toHaveCount(1);
    await expect.poll(() => holder(page)).toBe("Terminal input");
  });

  for (const platform of PLATFORMS) {
    test(`is the editor's tab in editor mode, from the agent's terminal too, on ${platform.name}`, async ({ page }) => {
      await open(page, platform);
      const agent = await startSession(page);
      await page.keyboard.press(`${platform.mod}+Shift+e`);
      await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "editing");
      await page.locator(TREE).getByText("README.md", { exact: true }).dblclick();
      await page.locator(TREE).getByText("Cargo.toml", { exact: true }).dblclick();
      await expect(page.getByTestId("editor-tab")).toHaveCount(2);
      await expect.poll(() => closeName(page)).toBe("Close Tab");
      await page.keyboard.press(`${platform.mod}+2`);
      await expect.poll(() => holder(page)).toBe("Terminal input");
      if (platform === LINUX) {
        // The agent keeps Ctrl+W.
        const from = await writes(page);
        await page.keyboard.press("Control+w");
        await expect.poll(() => sent(page, from)).toEqual({ [agent]: "\x17" });
        await expect(page.getByTestId("editor-tab")).toHaveCount(2);
      }
      await page.keyboard.press(platform.inTerminal);
      await expect(page.getByTestId("editor-tab")).toHaveCount(1);
      // From the tree, the plain chord on either platform.
      await page.locator(TREE).focus();
      await page.keyboard.press(platform.close);
      await expect(page.getByTestId("editor-tab")).toHaveCount(0);
      expect(await controls(page)).toEqual([]);
    });
  }

  test("is the same from the File menu's Close as from the chord", async ({ page }) => {
    await open(page, MAC);
    await openShell(page);
    await page.evaluate(() => (window as unknown as { __menuAction: (a: string) => void }).__menuAction("file.close"));
    await expect(page.locator(ROW)).toHaveCount(0);
    expect(await controls(page)).toEqual([]);
  });
});

for (const platform of PLATFORMS)
  test(`says in the Keys table which chord closes from a terminal, on ${platform.name}`, async ({ page }) => {
    await open(page, platform);
    await page.keyboard.press(`${platform.mod}+,`);
    await page.getByTestId("settings-tab-keys").click();
    await expect(page.getByTestId("chord-file.close")).toHaveText(platform === MAC ? "⌘W" : "Ctrl+W");
    if (platform === MAC) await expect(page.getByTestId("chord-also")).toHaveCount(0);
    else await expect(page.getByTestId("chord-also")).toHaveText("Also Ctrl+Shift+W, which works in a terminal");
  });
