import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Key, type WebDriver } from "selenium-webdriver";
import {
  DAEMON,
  launch,
  openProjects,
  textOf,
  waitForPaneText,
  type App,
} from "./harness";

/**
 * The embedded browser in the real app, under WebKitGTK.
 *
 * A tab's page is a native view of its own, which the WebDriver session,
 * attached to the window's own page, cannot see into. Where it sits and
 * what it shows are read from the X server's picture of the screen instead,
 * a pixel at a time, and clicks and keys reach it through the X server, the
 * way a person's would. That makes this file Linux's alone.
 */

const MAGENTA = "FF00FF";
const CYAN = "00FFFF";
const SESSIONS = "section[data-pane='sessions']";

/** A page filled with one colour, a link in its corner, and its title
    telling the last key it was given. */
const page = (title: string, colour: string, link: string) => `<!doctype html>
<html><head><title>${title}</title>
<style>html, body { margin: 0; height: 100%; background: #${colour}; }
a { display: block; width: 120px; height: 40px; font: 32px sans-serif; }</style></head>
<body><a id="next" href="${link}">next</a>
<script>addEventListener("keydown", (e) => { document.title = "key " + e.key; });</script>
</body></html>`;

const PAGES: Record<string, string> = {
  "/a.html": page("Page A", MAGENTA, "b.html"),
  "/b.html": page("Page B", CYAN, "a.html"),
};

let app: App;
let repo: string;
let server: Server;
let site: string;
let shots: string;

const X_ENV = { ...process.env, DISPLAY: process.env.DISPLAY ?? ":99" };

function xdotool(args: string[]): string {
  return execFileSync("xdotool", args, { env: X_ENV }).toString();
}

/** Where the window's content starts on the screen: the largest window
    carrying the app's title, since the toolkit may make smaller ones. */
function windowOrigin(): { x: number; y: number } {
  const ids = xdotool(["search", "--name", "Agent Workbench"]).trim().split("\n");
  let best = { x: 0, y: 0, area: -1 };
  for (const id of ids) {
    const shell = xdotool(["getwindowgeometry", "--shell", id]);
    const read = (name: string) => Number(new RegExp(`${name}=(\\d+)`).exec(shell)?.[1] ?? 0);
    const area = read("WIDTH") * read("HEIGHT");
    if (area > best.area) best = { x: read("X"), y: read("Y"), area };
  }
  return { x: best.x, y: best.y };
}

/** The colours at points of the window's content, as hex, read from one
    picture of the screen. */
function colours(points: [number, number][]): string[] {
  const origin = windowOrigin();
  const file = join(shots, "screen.png");
  execFileSync("import", ["-window", "root", file], { env: X_ENV });
  const format = points
    .map(([x, y]) => `%[hex:p{${Math.round(origin.x + x)},${Math.round(origin.y + y)}}]`)
    .join(" ");
  return execFileSync("convert", [file, "-format", format, "info:"]).toString().trim().split(" ");
}

/** Clicks the window's content at a point, through the X server. */
function click(x: number, y: number) {
  const origin = windowOrigin();
  xdotool([
    "mousemove",
    String(Math.round(origin.x + x)),
    String(Math.round(origin.y + y)),
    "click",
    "1",
  ]);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function bodyBox(driver: WebDriver): Promise<Box> {
  return driver.executeScript(() => {
    const box = document.querySelector("[data-testid='browser-body']")!.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }) as Promise<Box>;
}

/** Inside the body near each corner and at its middle, and just outside
    it to the left and above, which is the app's own page. */
function probes(box: Box): { inside: [number, number][]; outside: [number, number][] } {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  return {
    inside: [
      [box.x + 6, box.y + 60],
      [right - 6, box.y + 60],
      [box.x + box.width / 2, box.y + box.height / 2],
      [box.x + 6, bottom - 6],
      [right - 6, bottom - 6],
    ],
    outside: [
      [box.x - 6, box.y + box.height / 2],
      [box.x + box.width / 2, box.y - 6],
    ],
  };
}

/** Waits until the page's colour fills the body and stops at its edges. */
async function waitForPageOverBody(driver: WebDriver, colour: string) {
  let seen = "";
  await driver.wait(
    async () => {
      const box = await bodyBox(driver);
      const { inside, outside } = probes(box);
      const read = colours([...inside, ...outside]);
      seen = `body ${JSON.stringify(box)} read ${read.join(",")}`;
      return (
        read.slice(0, inside.length).every((hex) => hex === colour) &&
        read.slice(inside.length).every((hex) => hex !== colour)
      );
    },
    10_000,
  ).catch(() => {
    throw new Error(`the page did not fill the body: ${seen}`);
  });
}

async function waitForPageGone(driver: WebDriver, colour: string) {
  let seen = "";
  await driver.wait(
    async () => {
      const box = await bodyBox(driver).catch(() => null);
      if (box === null) return true;
      const read = colours(probes(box).inside);
      seen = read.join(",");
      return read.every((hex) => hex !== colour);
    },
    10_000,
  ).catch(() => {
    throw new Error(`the page still shows: ${seen}`);
  });
}

/** Types an address into the address field and takes it with Enter, the
    way the field's own handler reads a person's. */
async function go(driver: WebDriver, address: string) {
  await driver.wait(
    async () =>
      (await driver.executeScript(
        () => document.querySelector("[data-testid='browser-address']") !== null,
      )) === true,
    10_000,
    "no address field",
  );
  await driver.executeScript((address: string) => {
    const field = document.querySelector<HTMLInputElement>("[data-testid='browser-address']")!;
    field.focus();
    field.value = address;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  }, address);
}

function activeTabText(driver: WebDriver): Promise<string> {
  return textOf(driver, "[data-testid='browser-tab'].active");
}

async function waitForTitle(driver: WebDriver, title: string) {
  await driver.wait(
    async () => (await activeTabText(driver)).includes(title),
    10_000,
    `no tab titled "${title}"`,
  );
}

function disabled(driver: WebDriver, testid: string): Promise<boolean> {
  return driver.executeScript(
    (testid: string) =>
      document.querySelector<HTMLButtonElement>(`[data-testid='${testid}']`)?.disabled ?? null,
    testid,
  ) as Promise<boolean>;
}

function focusReadout(driver: WebDriver): Promise<string> {
  return textOf(driver, "[data-testid='focus-readout']");
}

/** One call on the agent's tool server, answered with its text. */
function tool(name: string, args: Record<string, unknown>): string {
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ];
  return execFileSync(DAEMON, ["mcp"], {
    cwd: repo,
    env: { ...process.env, HOME: app.home },
    input: messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
  }).toString();
}

describe.skipIf(process.platform !== "linux")("the browser on Linux", () => {
  beforeAll(async () => {
    shots = mkdtempSync(join(tmpdir(), "workbench-screen-"));
    repo = mkdtempSync(join(tmpdir(), "workbench-browser-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "ada@example.com"]);
    git(["config", "user.name", "Ada"]);
    writeFileSync(join(repo, "README.md"), "# demo\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "start"]);

    server = createServer((request, response) => {
      const body = PAGES[request.url ?? ""];
      response.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      response.end(body ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    site = `http://localhost:${(server.address() as AddressInfo).port}`;

    app = await launch();
    const { driver } = app;
    await driver.manage().window().setRect({ width: 1440, height: 900 });
    await openProjects(driver, [repo]);
    await waitForPaneText(driver, SESSIONS, repo.split("/").pop()!);
  }, 120_000);

  afterAll(async () => {
    await app?.stop();
    server?.close();
    if (shots) rmSync(shots, { recursive: true, force: true });
  });

  it("lays a page over the viewer's body, and the window's own page keeps its size", async () => {
    const { driver } = app;
    const height = await driver.executeScript(() => window.innerHeight);

    await driver.executeScript(() => {
      document.querySelector<HTMLElement>("[data-testid='browser-fold']")!.click();
      document.querySelector<HTMLElement>("[data-testid='browser-fold-new-tab']")!.click();
    });
    await go(driver, `${site}/a.html`);
    await waitForTitle(driver, "Page A");

    await waitForPageOverBody(driver, MAGENTA);
    expect(await driver.executeScript(() => window.innerHeight)).toBe(height);
  });

  it("follows the viewer when the window is resized", async () => {
    const { driver } = app;
    await driver.manage().window().setRect({ width: 1100, height: 760 });
    await waitForPageOverBody(driver, MAGENTA);
    await driver.manage().window().setRect({ width: 1440, height: 900 });
    await waitForPageOverBody(driver, MAGENTA);
  });

  it("hides the page while a dialog is over it, and puts it back after", async () => {
    const { driver } = app;
    await driver.executeScript(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    await driver.wait(
      async () => (await textOf(driver, "[data-testid='settings']")) !== "",
      10_000,
    );
    await waitForPageGone(driver, MAGENTA);

    await driver.actions().sendKeys(Key.ESCAPE).perform();
    await driver.wait(
      async () => (await textOf(driver, "[data-testid='settings']")) === "",
      10_000,
    );
    await waitForPageOverBody(driver, MAGENTA);
  });

  it("greys back and forward until there is somewhere to go", async () => {
    const { driver } = app;
    expect(await disabled(driver, "browser-back")).toBe(true);
    expect(await disabled(driver, "browser-forward")).toBe(true);

    await go(driver, `${site}/b.html`);
    await waitForTitle(driver, "Page B");
    await driver.wait(async () => !(await disabled(driver, "browser-back")), 10_000);
    expect(await disabled(driver, "browser-forward")).toBe(true);

    await driver.executeScript(() =>
      document.querySelector<HTMLElement>("[data-testid='browser-back']")!.click(),
    );
    await waitForTitle(driver, "Page A");
    await driver.wait(async () => !(await disabled(driver, "browser-forward")), 10_000);
    expect(await disabled(driver, "browser-back")).toBe(true);
    await waitForPageOverBody(driver, MAGENTA);
  });

  it("takes a click inside the page, and counts it as the changes pane's", async () => {
    const { driver } = app;
    await driver.executeScript(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    await driver.wait(async () => (await focusReadout(driver)) === "focus: agent", 10_000);

    const box = await bodyBox(driver);
    click(box.x + 20, box.y + 20);
    await waitForTitle(driver, "Page B");
    await waitForPageOverBody(driver, CYAN);
    expect(await focusReadout(driver)).toBe("focus: changes");
  });

  it("leaves the page its own keys and takes the app's chords back", async () => {
    const { driver } = app;
    const box = await bodyBox(driver);
    click(box.x + box.width / 2, box.y + box.height / 2);

    xdotool(["key", "x"]);
    await waitForTitle(driver, "key x");

    // Ctrl on its own is the page's; the chord it starts is the app's.
    xdotool(["key", "ctrl+2"]);
    await driver.wait(async () => (await focusReadout(driver)) === "focus: agent", 10_000);
    expect(await activeTabText(driver)).not.toContain("key 2");

    click(box.x + box.width / 2, box.y + box.height / 2);
    await driver.wait(async () => (await focusReadout(driver)) === "focus: changes", 10_000);
    xdotool(["key", "Escape"]);
    await driver.wait(
      async () =>
        (await driver.executeScript(
          () => document.querySelector("[data-testid='viewer'][data-view='browser']") === null,
        )) === true,
      10_000,
      "Escape in the page did not close the viewer",
    );
    expect(await textOf(driver, "[data-testid='browser-section']")).not.toContain("key Escape");
    await waitForPageGone(driver, CYAN);
  });

  it("says a host that does not resolve could not be found, and keeps saying so", async () => {
    const { driver } = app;
    await driver.executeScript(() =>
      document
        .querySelector<HTMLElement>("[data-testid='browser-fold-row'] button.media-row")!
        .click(),
    );
    await go(driver, "no-such-host.invalid");
    await waitForPaneText(driver, "[data-testid='browser-failed']", "could not be found", 10_000);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await textOf(driver, "[data-testid='browser-failed']")).toContain(
      "could not be found",
    );

    // Refused at once, which WebKitGTK can report before the check does.
    await go(driver, "localhost:1");
    await waitForPaneText(driver, "[data-testid='browser-failed']", "is not answering", 10_000);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await textOf(driver, "[data-testid='browser-failed']")).toContain("is not answering");

    expect(tool("browser_open", { url: "https://no-such-host.invalid/" })).toContain(
      "did not load",
    );
  });

  it("answers the tools that read a page with not supported", async () => {
    expect(tool("browser_open", { url: `${site}/a.html` })).toContain("Opened tab");
    expect(tool("browser_snapshot", {})).toContain("not supported");
  });
});
