import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Builder, Key, type WebDriver } from "selenium-webdriver";

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
/** The daemon, for a "remote" that is this machine: the app is told to run
    it directly where it would run ssh. */
export const DAEMON = resolve(
  ROOT,
  "src-tauri/target/debug",
  process.platform === "win32"
    ? "agent-workbench-remote.exe"
    : "agent-workbench-remote",
);

const BIN =
  process.env.WORKBENCH_BIN ??
  join(
    ROOT,
    "src-tauri/target/debug",
    process.platform === "win32" ? "agent-workbench.exe" : "agent-workbench",
  );
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
echo "in $PWD"
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
echo in %CD%
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
      writeFileSync(
        join(bin, `${name}.cmd`),
        FAKE_AGENT_CMD(name.toUpperCase()),
      );
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
    ? {
        ...process.env,
        HOME: home,
        PATH: `${bin};${process.env.PATH ?? ""}`,
        WORKBENCH_REMOTE_COMMAND: `${DAEMON} serve`,
      }
    : {
        ...process.env,
        HOME: home,
        SHELL: join(bin, "login-shell"),
        WORKBENCH_REMOTE_COMMAND: `${DAEMON} serve`,
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

/** The app as a process: whether it is still there, and what it said. */
interface Started {
  child: ChildProcess;
  /** Set once the process is gone, however it went. */
  exited?: { code: number | null; signal: NodeJS.Signals | null };
  /** Everything it wrote, for the report when it does not come up. */
  said: string[];
}

/** Starts the binary, echoing its output through and keeping a copy, so
    a failure can say whether the app died or is merely silent. */
function start(env: NodeJS.ProcessEnv): Started {
  const child = spawn(BIN, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  const started: Started = { child, said: [] };
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      started.said.push(chunk.toString());
    });
  }
  child.on("error", (error) =>
    started.said.push(`could not start ${BIN}: ${error.message}\n`),
  );
  child.on("exit", (code, signal) => {
    started.exited = { code, signal };
  });
  return started;
}

async function waitForDebugger(app: Started, port: number, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (app.exited) break;
    if (await debuggerUp(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Whichever it was, say which: an app that died and one that is running
  // with no port open are different problems, and the log is all a CI
  // runner leaves behind.
  const fate = app.exited
    ? `the app exited with code ${app.exited.code}` +
      (app.exited.signal ? ` (${app.exited.signal})` : "")
    : `the app is still running as pid ${app.child.pid} after ${ms}ms`;
  const socket = (await portOpen(port))
    ? "accepts connections but does not answer HTTP"
    : "is not open at all";
  const output = app.said.join("").trim();
  throw new Error(
    `the WebView2 debugger never answered on ${port}: ${fate}; the port ${socket}.\n` +
      (output ? `The app said:\n${output}\n` : "The app printed nothing.\n") +
      webview2Report(),
  );
}

/** Whether this process runs elevated, at high integrity, which is how a
    GitHub runner runs a job and how a developer's shell usually does not. */
function elevated(): boolean {
  try {
    // By path: under Git Bash, which is what runs this on CI, a bare
    // `whoami` is coreutils' and knows no /groups.
    const whoami = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "whoami.exe",
    );
    const groups = execFileSync(whoami, ["/groups"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return groups.includes("S-1-16-12288");
  } catch {
    return false;
  }
}

const POLICY =
  "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments";

/** Puts the browser switches where an elevated host will read them.

    Elevated, WebView2 ignores every WEBVIEW2_* variable, with
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS named first, and honours the HKLM
    policy instead, keyed by the executable's name. Writing HKLM takes the
    elevation that makes this necessary. Gives back the undo. */
function policySwitches(exe: string, switches: string): () => void {
  execFileSync(
    "reg",
    ["add", POLICY, "/v", exe, "/t", "REG_SZ", "/d", switches, "/f"],
    { stdio: "ignore" },
  );
  return () => {
    try {
      execFileSync("reg", ["delete", POLICY, "/v", exe, "/f"], {
        stdio: "ignore",
      });
    } catch {
      // Already gone.
    }
  };
}

/** The whole tree, because the app is the parent of WebView2's own
    processes and killing it alone leaves them holding the profile. */
function killTree(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } catch {
    // Already gone, which is the outcome either way.
  }
}

/** Removes the run's profile once WebView2 has let go of it. taskkill
    returns before the handles are released, so the first tries meet
    EBUSY; and a cleanup that throws would replace whatever error the run
    was actually about, which is how one runner log said nothing useful. */
async function removeProfile(profile: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  process.stderr.write(
    `could not remove ${profile}: something still holds it\n`,
  );
}

/** What WebView2 is actually doing, for when the port never opens. The
    browser process's command line says whether the switch reached it and
    which profile it took; netstat says what it is listening on. Every
    msedgewebview2.exe is listed, its type and the switches that matter. */
function webview2Report(): string {
  const lines: string[] = [];
  try {
    const processes = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        'Get-CimInstance Win32_Process -Filter "Name=\'msedgewebview2.exe\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [pid, ...rest] = line.trim().split(" ");
        const command = rest.join(" ");
        const type = /--type=(\S+)/.exec(command)?.[1] ?? "browser";
        const switches =
          command.match(
            /--(?:remote-debugging\S*|user-data-dir=(?:"[^"]*"|\S*))/g,
          ) ?? [];
        return `  ${pid} ${type} ${switches.join(" ")}`;
      });
    lines.push(
      processes.length
        ? `msedgewebview2.exe processes:\n${processes.join("\n")}`
        : "No msedgewebview2.exe is running.",
    );
  } catch (error) {
    lines.push(
      `could not list WebView2 processes: ${(error as Error).message}`,
    );
  }
  try {
    const listening = execFileSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .filter((line) => /LISTENING/.test(line))
      .map((line) => `  ${line.trim()}`);
    lines.push(`Listening, per netstat:\n${listening.join("\n")}`);
  } catch (error) {
    lines.push(`could not run netstat: ${(error as Error).message}`);
  }
  return lines.join("\n");
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
  // A profile of this run's own, so nothing the webview persists leaks
  // between runs, and so the tests never touch the real app's. It lives
  // under the real local app data, next to where the app would put its
  // own, not under the run's temp HOME: WebView2 is particular about where
  // its profile goes, and the runner's temp is on another drive.
  const profile = join(
    process.env.LOCALAPPDATA ?? tmpdir(),
    "agent-workbench-driver",
    basename(home),
  );
  const switches = `--remote-debugging-port=${debugPort}`;
  const env = {
    ...environment(home, bin),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: switches,
    WEBVIEW2_USER_DATA_FOLDER: profile,
  };
  // The variable is enough at standard integrity. Elevated, as on a CI
  // runner, WebView2 ignores it and reads the machine policy instead.
  const unsetPolicy = elevated()
    ? policySwitches(basename(BIN), switches)
    : () => {};

  const edge: ChildProcess = spawn(edgedriver, [`--port=${DRIVER_PORT}`], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const app = start(env);
  const stopAll = async () => {
    killTree(app.child.pid);
    killTree(edge.pid);
    unsetPolicy();
    await removeProfile(profile);
  };

  try {
    await waitForPort(DRIVER_PORT, 15_000);
    // Generous, but inside the test's own beforeAll budget of two minutes
    // with the driver's wait above: a report after the wait is worth more
    // than a quick one, and none at all, when vitest kills the hook first,
    // is worth nothing.
    await waitForDebugger(app, debugPort, 90_000);

    const driver = await new Builder()
      .usingServer(`http://127.0.0.1:${DRIVER_PORT}/`)
      .withCapabilities({
        browserName: "MicrosoftEdge",
        // Only the address. msedgedriver 152 rejects the documented
        // webviewOptions as an unrecognised option, and attaching does not
        // need it.
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
        await stopAll();
      },
    };
  } catch (failure) {
    await stopAll();
    throw failure;
  }
}

/** Linux: `tauri-driver` starts the binary through WebKitWebDriver. */
async function bridge(home: string, bin: string): Promise<App> {
  const env = environment(home, bin);
  const args = ["--port", String(DRIVER_PORT)];
  if (process.env.TAURI_NATIVE_DRIVER)
    args.push("--native-driver", process.env.TAURI_NATIVE_DRIVER);
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
  // The call lands while the page may still be changing under the previous
  // test, and the driver has answered it with "no such element" once in a
  // long while: asked again a moment later, it goes through.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await driver.executeScript((paths: string[]) => {
        localStorage.setItem(
          "workbench.workspace",
          JSON.stringify({
            open: paths,
            active: paths[0] ?? null,
            recent: paths,
          }),
        );
        location.reload();
      }, paths);
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
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
    (selector: string) =>
      document.querySelector<HTMLElement>(selector)?.innerText ?? "",
    selector,
  ) as Promise<string>;
}

export async function waitForPaneText(
  driver: WebDriver,
  selector: string,
  needle: string,
  ms = 15_000,
) {
  await driver.wait(
    async () => (await textOf(driver, selector)).includes(needle),
    ms,
    `no "${needle}" in ${selector}`,
  );
}

/** What the active session's terminal shows, as text. */
export function screenText(driver: WebDriver, key?: string): Promise<string> {
  return driver.executeScript((key: string | undefined) => {
    const registry = (
      window as unknown as { __WORKBENCH_TERMINALS__?: Record<string, any> }
    ).__WORKBENCH_TERMINALS__;
    if (!registry) return "";
    const term = key ? registry[key] : Object.values(registry).at(-1);
    if (!term) return "";
    const active = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < active.length; i++) {
      lines.push(active.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n").trim();
  }, key) as Promise<string>;
}

export async function waitForText(
  driver: WebDriver,
  needle: string,
  ms = 20_000,
) {
  await driver.wait(
    async () => (await screenText(driver)).includes(needle),
    ms,
    `no "${needle}" on screen`,
  );
}

/** What the active session's terminal shows on the cursor's line. Typed
    input is echoed there, so this is where a keystroke shows up. */
function cursorLine(driver: WebDriver): Promise<string> {
  return driver.executeScript(() => {
    const registry = (
      window as unknown as { __WORKBENCH_TERMINALS__?: Record<string, any> }
    ).__WORKBENCH_TERMINALS__;
    const term = Object.values(registry ?? {}).at(-1);
    if (!term) return "";
    const active = term.buffer.active;
    return (
      active.getLine(active.baseY + active.cursorY)?.translateToString(true) ??
      ""
    );
  }) as Promise<string>;
}

/** Types into the active session's terminal, one key at a time.

    The terminal is given the keyboard first, so what happened to focus
    since the last keystroke does not decide where the text goes. Each key
    is sent only once the one before it has been echoed onto the cursor's
    line: WebDriver under WebView2 has delivered keys out of order whenever
    two were in flight, "helol" for "hello", and Enter ahead of the last
    letter of "crash". */
export async function type(driver: WebDriver, text: string) {
  await driver.executeScript(() => {
    const registry = (
      window as unknown as { __WORKBENCH_TERMINALS__?: Record<string, any> }
    ).__WORKBENCH_TERMINALS__;
    Object.values(registry ?? {})
      .at(-1)
      ?.focus();
  });
  const focused = await driver.switchTo().activeElement();
  let line = "";
  for (const key of text) {
    if (key === "\n") {
      await focused.sendKeys(Key.ENTER);
      line = "";
      continue;
    }
    line += key;
    await focused.sendKeys(key);
    const typed = line;
    await driver.wait(
      async () => (await cursorLine(driver)).endsWith(typed),
      10_000,
      `"${typed}" never echoed`,
    );
  }
}
