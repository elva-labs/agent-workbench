import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// A new shell in the terminal panel by one chord, from anywhere in the
// window: Cmd+T on macOS, Ctrl+Shift+T elsewhere, where Ctrl+T is the
// process's in a terminal. With the panel closed it opens with the new
// shell; the keyboard lands in the new shell either way. The panel's own
// control does the same and names the chord. Each walk runs as each
// platform the app tells apart, whatever the machine, in WebKit and
// Chromium.

const PLATFORMS = [
  { name: "macOS", reported: "MacIntel", mod: "Meta", chord: "Meta+t", label: "⌘T" },
  { name: "Linux", reported: "Linux x86_64", mod: "Control", chord: "Control+Shift+T", label: "Ctrl+Shift+T" },
];
type Platform = (typeof PLATFORMS)[number];

const ROW = "[data-testid='terminal-row']";
const TERMINAL = "section[data-pane='terminal']";

async function open(page: Page, platform: Platform) {
  await page.addInitScript(
    (reported) => Object.defineProperty(Navigator.prototype, "platform", { get: () => reported }),
    platform.reported,
  );
  await installFakeCore(page, { open: [PROJECT] });
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
}

/** What has the keyboard: its test id, else its label, else its tag. */
function holder(page: Page) {
  return page.evaluate(() => {
    const owner = document.activeElement as HTMLElement | null;
    if (owner === null || owner === document.body) return null;
    return owner.getAttribute("data-testid") ?? owner.getAttribute("aria-label") ?? owner.tagName.toLowerCase();
  });
}

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

/** Starts a session, with the keyboard in its terminal; its pty. */
async function startSession(page: Page) {
  await page.getByTestId("start-agent").click();
  await expect.poll(() => holder(page)).toBe("Terminal input");
  return typeInto(page, "x");
}

for (const platform of PLATFORMS) {
  test(`opens the panel with a new shell from the agent, with the keyboard in it, on ${platform.name}`, async ({ page }) => {
    await open(page, platform);
    const agent = await startSession(page);
    await expect(page.locator(TERMINAL)).toBeHidden();
    const from = await writes(page);
    await page.keyboard.press(platform.chord);
    await expect(page.locator(TERMINAL)).toBeVisible();
    await expect(page.locator(ROW)).toHaveCount(1);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: terminal");
    await expect.poll(() => holder(page)).toBe("Terminal input");
    const shell = await typeInto(page, "ls");
    expect(shell).not.toBe(agent);
    // The chord reached no pty.
    expect((await sent(page, from))[agent]).toBeUndefined();
  });

  test(`opens another shell from inside a shell, which gets nothing of the chord, on ${platform.name}`, async ({ page }) => {
    await open(page, platform);
    await page.keyboard.press(`${platform.mod}+j`);
    await expect(page.locator(ROW)).toHaveCount(1);
    await expect.poll(() => holder(page)).toBe("Terminal input");
    const first = await typeInto(page, "a");
    const from = await writes(page);
    await page.keyboard.press(platform.chord);
    await expect(page.locator(ROW)).toHaveCount(2);
    await expect(page.locator(ROW).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => holder(page)).toBe("Terminal input");
    const second = await typeInto(page, "b");
    expect(second).not.toBe(first);
    expect((await sent(page, from))[first]).toBeUndefined();
  });

  test(`leaves Ctrl+T to the shell, on ${platform.name}`, async ({ page }) => {
    await open(page, platform);
    await page.keyboard.press(`${platform.mod}+j`);
    await expect.poll(() => holder(page)).toBe("Terminal input");
    const shell = await typeInto(page, "a");
    const from = await writes(page);
    await page.keyboard.press("Control+t");
    await expect.poll(() => sent(page, from)).toEqual({ [shell]: "\x14" });
    await expect(page.locator(ROW)).toHaveCount(1);
  });

  test(`names the chord on the panel's own control, which does the same, on ${platform.name}`, async ({ page }) => {
    await open(page, platform);
    await page.keyboard.press(`${platform.mod}+j`);
    await expect(page.locator(ROW)).toHaveCount(1);
    const control = page.getByTestId("new-terminal");
    await expect(control).toHaveAttribute("aria-label", "New shell");
    await expect(control).toHaveAttribute("title", `New shell (${platform.label})`);
    await control.click();
    await expect(page.locator(ROW)).toHaveCount(2);
    await expect.poll(() => holder(page)).toBe("Terminal input");
  });
}

test("opens a new shell from the editor, and from the commands palette", async ({ page }) => {
  await open(page, PLATFORMS[0]);
  await page.keyboard.press("Meta+Shift+e");
  await expect(page.getByTestId("shell")).toHaveAttribute("data-mode", "editing");
  await page.locator("[data-testid='file-tree']").getByText("README.md", { exact: true }).dblclick();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+t");
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect.poll(() => holder(page)).toBe("Terminal input");
  // Nothing was typed into the file.
  await expect(page.getByTestId("editor-tab-dirty")).toHaveCount(0);

  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.type("new shell");
  await expect(page.locator("[data-testid='palette-row'][aria-selected='true']").first()).toContainText("New shell");
  await expect(page.locator("[data-testid='palette-row'][aria-selected='true']").first()).toContainText("⌘T");
  await page.keyboard.press("Enter");
  await expect(page.locator(ROW)).toHaveCount(2);
  await expect.poll(() => holder(page)).toBe("Terminal input");
});

test("lists the chord in the Keys settings, and follows it when moved", async ({ page }) => {
  await open(page, PLATFORMS[0]);
  await page.keyboard.press("Meta+,");
  await page.getByTestId("settings-tab-keys").click();
  const chord = page.getByTestId("chord-terminal.new");
  await expect(chord).toHaveText("⌘T");
  await chord.click();
  await page.keyboard.press("Meta+Alt+t");
  await expect(chord).toHaveText("⌘⌥T");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toHaveCount(0);
  await page.keyboard.press("Meta+t");
  await expect(page.locator(TERMINAL)).toBeHidden();
  await page.keyboard.press("Meta+Alt+t");
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(page.getByTestId("new-terminal")).toHaveAttribute("title", "New shell (⌘⌥T)");
});
