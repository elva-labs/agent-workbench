import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Builder, type WebDriver } from "selenium-webdriver";

/**
 * The real app under WebDriver.
 *
 * On Linux `tauri-driver` bridges the W3C protocol to WebKitWebDriver, which
 * starts the binary itself. Windows takes the other route, `attach()` below.
 * Either way this tier runs the actual binary: the core, the pty, git2 and
 * the watcher, under the renderer the app ships with rather than Chromium.
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

const WINDOWS = process.platform === "win32";

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

/** The same tool as a batch file, which is how npm installs a command on
    Windows and what the core has to run through cmd. */
const FAKE_AGENT_CMD = (name: string) => `@echo off
echo FAKE ${name} %*
:loop
set line=
set /p line=
if "%line%"=="exit" exit /b 0
if "%line%"=="crash" exit /b 3
echo echo: %line%
goto loop
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
    if (WINDOWS) {
      writeFileSync(join(bin, `${name}.cmd`), FAKE_AGENT_CMD(name.toUpperCase()));
      continue;
    }
    const path = join(bin, name);
    writeFileSync(path, FAKE_AGENT(name.toUpperCase()));
    chmodSync(path, 0o755);
  }
  if (!WINDOWS) {
    const shell = join(bin, "login-shell");
    writeFileSync(shell, FAKE_SHELL(bin));
    chmodSync(shell, 0o755);
  }
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

/** The environment the binary is started in.

    On Windows the core takes the environment it was started with, so the
    fake agents go on PATH here; elsewhere the fake login shell puts them
    there, and HOME is where both agents' indexes are looked for.

    HOME alone: `home_directory()` reads it before USERPROFILE, and moving
    USERPROFILE off the real profile stops WebView2 opening its debugging
    port at all, which is the one thing this tier cannot do without. */
function environment(home: string, bin: string): NodeJS.ProcessEnv {
  return WINDOWS
    ? { ...process.env, HOME: home, PATH: `${bin};${process.env.PATH ?? ""}` }
    : {
        ...process.env,
        HOME: home,
        SHELL: join(bin, "login-shell"),
        // WebKitGTK's compositor has no GPU to talk to under Xvfb.
        WEBKIT_DISABLE_COMPOSITING_MODE: "1",
        WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      };
}

/** A port nothing is on, asked of the OS and given straight back. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

/** Whether the WebView2 debugger is answering yet. */
async function debuggerUp(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDebugger(port: number, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await debuggerUp(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the WebView2 debugger never answered on ${port}`);
}

/** The whole tree, because the app is the parent of WebView2's own
    processes and killing it alone leaves them holding the profile. */
function killTree(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // Already gone, which is the outcome either way.
  }
}

/**
 * Windows: the app first, the driver attached to it.
 *
 * Edge WebDriver cannot start this app the way it starts a browser. It
 * passes `--remote-debugging-port` and `--user-data-dir` and then waits for
 * a `DevToolsActivePort` file in that directory -- and WebView2 never writes
 * that file, whether the flags reach it as flags or as the two environment
 * variables its runtime honours. It is a Chrome-browser courtesy, not a
 * WebView2 one, so no amount of forwarding produces it.
 *
 * So we start the binary ourselves with the debugger open, and hand Edge
 * WebDriver `debuggerAddress` to attach to what is already running. That
 * skips `tauri-driver`, whose only job on Windows was the launch that
 * cannot work; the driver it wraps does the rest unchanged.
 */
async function attach(home: string, bin: string): Promise<App> {
  const edgedriver = process.env.TAURI_NATIVE_DRIVER ?? "msedgedriver";
  const debugPort = await freePort();
  const env = {
    ...environment(home, bin),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    // Inside this run's HOME, so a run leaves no profile behind.
    WEBVIEW2_USER_DATA_FOLDER: join(home, "webview2"),
  };

  const edge: ChildProcess = spawn(edgedriver, [`--port=${DRIVER_PORT}`], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const app: ChildProcess = spawn(BIN, [], { env, stdio: ["ignore", "inherit", "inherit"] });

  try {
    await waitForPort(DRIVER_PORT, 15_000);
    await waitForDebugger(debugPort, 60_000);

    const driver = await new Builder()
      .usingServer(`http://127.0.0.1:${DRIVER_PORT}/`)
      .withCapabilities({
        browserName: "MicrosoftEdge",
        "ms:edgeOptions": { debuggerAddress: `127.0.0.1:${debugPort}` },
      })
      .build();

    return {
      driver,
      home,
      bin,
      stop: async () => {
        // Attached, so quitting the session detaches rather than closing
        // the app: it is ours to stop.
        await driver.quit().catch(() => {});
        killTree(app.pid);
        killTree(edge.pid);
      },
    };
  } catch (failure) {
    killTree(app.pid);
    killTree(edge.pid);
    throw failure;
  }
}

/** Linux: `tauri-driver` starts the binary through WebKitWebDriver. */
async function bridge(home: string, bin: string): Promise<App> {
  const env = environment(home, bin);
  const args = ["--port", String(DRIVER_PORT)];
  if (process.env.TAURI_NATIVE_DRIVER) args.push("--native-driver", process.env.TAURI_NATIVE_DRIVER);
  const tauriDriver: ChildProcess = spawn("tauri-driver", args, {
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

export async function launch(): Promise<App> {
  const { home, bin } = fixtures();
  return WINDOWS ? attach(home, bin) : bridge(home, bin);
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
