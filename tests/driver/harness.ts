import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Builder, type WebDriver } from "selenium-webdriver";

/**
 * The real app under WebDriver.
 *
 * `tauri-driver` bridges the W3C protocol to the platform's own WebView
 * driver: WebKitWebDriver on Linux, Edge WebDriver on Windows. This tier is
 * what runs the actual binary: the core, the pty, git2 and the watcher, under
 * the renderer the app ships with rather than under Chromium.
 *
 * The agent under test is a shell script called `claude` (and one called
 * `codex`) that echoes its arguments and then whatever it is told. It sits
 * in a directory that a fake login shell puts first on PATH, because the core
 * asks the login shell for its environment rather than trusting its own.
 */

const ROOT = resolve(__dirname, "../..");
const BIN =
  process.env.WORKBENCH_BIN ??
  join(ROOT, "src-tauri/target/debug", process.platform === "win32" ? "agent-workbench.exe" : "agent-workbench");
const DRIVER_PORT = 4444;

export interface App {
  driver: WebDriver;
  /** A HOME of its own, so nothing the app persists leaks between runs. */
  home: string;
  /** Where the fake agents live. */
  bin: string;
  stop: () => Promise<void>;
}

/** A tool that prints its arguments, then echoes each line it is given
    until told to exit. What a pty test needs from an agent. */
const FAKE_AGENT = (name: string) => `#!/bin/sh
echo "FAKE ${name} $*"
while IFS= read -r line; do
  case "$line" in
    exit) exit 0 ;;
    crash) exit 3 ;;
  esac
  echo "echo: $line"
done
`;

/** Stands in for the user's login shell: the same shell, with the fake
    agents first on PATH, whatever the real profile does to it. */
const FAKE_SHELL = (bin: string) => `#!/bin/sh
PATH="${bin}:$PATH"
export PATH
exec /bin/sh "$@"
`;

export function fixtures(): { home: string; bin: string } {
  const home = mkdtempSync(join(tmpdir(), "workbench-home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const name of ["claude", "codex"]) {
    const path = join(bin, name);
    writeFileSync(path, FAKE_AGENT(name.toUpperCase()));
    chmodSync(path, 0o755);
  }
  const shell = join(bin, "login-shell");
  writeFileSync(shell, FAKE_SHELL(bin));
  chmodSync(shell, 0o755);
  return { home, bin };
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

async function waitForPort(port: number, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`nothing listening on ${port} after ${ms}ms`);
}

export async function launch(): Promise<App> {
  const { home, bin } = fixtures();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SHELL: join(bin, "login-shell"),
    // WebKitGTK's compositor has no GPU to talk to under Xvfb.
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
  };

  const tauriDriver: ChildProcess = spawn("tauri-driver", ["--port", String(DRIVER_PORT)], {
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForPort(DRIVER_PORT, 15_000);

  const driver = await new Builder()
    .usingServer(`http://127.0.0.1:${DRIVER_PORT}/`)
    .withCapabilities({
      browserName: "wry",
      "tauri:options": { application: BIN },
    })
    .build();

  return {
    driver,
    home,
    bin,
    stop: async () => {
      await driver.quit().catch(() => {});
      tauriDriver.kill();
    },
  };
}

/** Points the app at projects, the way a restart would find them. */
export async function openProjects(driver: WebDriver, paths: string[]) {
  await driver.executeScript(
    (paths: string[]) => {
      localStorage.setItem(
        "workbench.workspace",
        JSON.stringify({ open: paths, active: paths[0] ?? null, recent: paths }),
      );
      location.reload();
    },
    paths,
  );
  await driver.wait(async () => {
    const ready = await driver.executeScript(
      () => document.querySelector("section[data-pane='agent']") !== null,
    );
    return ready === true;
  }, 20_000);
}

/** The rendered text of an element. WebDriver's own getText leaves out
    text the user cannot select, and the tree is deliberately that. */
export function textOf(driver: WebDriver, selector: string): Promise<string> {
  return driver.executeScript(
    (selector: string) => document.querySelector<HTMLElement>(selector)?.innerText ?? "",
    selector,
  ) as Promise<string>;
}

export async function waitForPaneText(driver: WebDriver, selector: string, needle: string, ms = 15_000) {
  await driver.wait(async () => (await textOf(driver, selector)).includes(needle), ms, `no "${needle}" in ${selector}`);
}

/** What the active session's terminal shows, as text. */
export function screenText(driver: WebDriver, key?: string): Promise<string> {
  return driver.executeScript(
    (key: string | undefined) => {
      const registry = (window as unknown as { __WORKBENCH_TERMINALS__?: Record<string, any> })
        .__WORKBENCH_TERMINALS__;
      if (!registry) return "";
      const term = key ? registry[key] : Object.values(registry).at(-1);
      if (!term) return "";
      const active = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < active.length; i++) {
        lines.push(active.getLine(i)?.translateToString(true) ?? "");
      }
      return lines.join("\n").trim();
    },
    key,
  ) as Promise<string>;
}

export async function waitForText(driver: WebDriver, needle: string, ms = 20_000) {
  await driver.wait(async () => (await screenText(driver)).includes(needle), ms, `no "${needle}" on screen`);
}

/** Types into whatever has the keyboard, which after focusing a terminal is
    xterm's own textarea. */
export async function type(driver: WebDriver, text: string) {
  const focused = await driver.switchTo().activeElement();
  await focused.sendKeys(text);
}
