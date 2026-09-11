import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { By, Key, until } from "selenium-webdriver";
import {
  DAEMON,
  launch,
  openProjects,
  screenText,
  textOf,
  type,
  waitForPaneText,
  waitForText,
  type App,
} from "./harness";

const SESSIONS = "section[data-pane='sessions']";
const TREE = "[data-testid='file-tree']";
const CHANGES = "section[data-pane='changes']";
/** The plugin source the tier adds: a directory with one plugin in it,
    kept here as the fixture it is. */
const PLUGIN_SOURCE = resolve(__dirname, "plugin");
/** The plugin's row in the settings. `plugin-row` is the pane's word for a
    row of a section too, so every locator says which it means. */
const SETTINGS_PLUGIN =
  "[data-testid='settings'] [data-testid='plugin-row'][data-plugin='driverboard']";

/**
 * The real binary, driven. Each `it` builds on the last: one app, one
 * project, in the order a user would go.
 */

let app: App;
let repo: string;

function git(args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "workbench-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "ada@example.com"]);
  git(["config", "user.name", "Ada"]);
  writeFileSync(join(repo, "README.md"), "# demo\n");
  writeFileSync(join(repo, "lib.rs"), "fn main() {}\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "start"]);
  // A change to see in the pane.
  writeFileSync(join(repo, "lib.rs"), 'fn main() { println!("hi"); }\n');

  app = await launch();
}, 120_000);

afterAll(async () => {
  await app?.stop();
});

describe("the real app", () => {
  it("comes up with three panes filling the window", async () => {
    const { driver } = app;
    await driver.wait(
      until.elementLocated(By.css("section[data-pane='agent']")),
      20_000,
    );
    await driver.manage().window().setRect({ width: 1440, height: 900 });
    await new Promise((r) => setTimeout(r, 500));

    const heights: Record<string, number> = await driver.executeScript(() => {
      const out: Record<string, number> = {};
      for (const pane of document.querySelectorAll<HTMLElement>(
        "section[data-pane]",
      )) {
        out[pane.dataset.pane!] = pane.getBoundingClientRect().height;
      }
      out.window = window.innerHeight;
      return out;
    });
    // The panes divide the window between them, above the status bar.
    expect(heights.window).toBeGreaterThan(800);
    for (const pane of ["sessions", "agent", "changes"]) {
      expect(heights[pane], pane).toBeGreaterThan(heights.window - 120);
    }
  });

  it("opens a repository and lists what changed in it", async () => {
    const { driver } = app;
    await openProjects(driver, [repo]);
    await waitForPaneText(driver, SESSIONS, repo.split(/[\\/]/).pop()!);
    await waitForPaneText(driver, TREE, "lib.rs");
    expect(await textOf(driver, TREE)).not.toContain("README.md");
  });

  it("starts the agent in a pty, in the project, with the id it was given", async () => {
    const { driver } = app;
    // Both fakes are on PATH, so the row opens into the choice first.
    await driver.findElement(By.css("[data-testid='new-session']")).click();
    await driver
      .findElement(
        By.css("[data-testid='agent-option'][data-agent='claude-code']"),
      )
      .click();
    // The first pty the app opens is the slow one: on a Windows runner the
    // console host, cmd.exe and the scan of a freshly written script all
    // come cold, and one night that took past twenty seconds. Later spawns
    // in the same run come up in under a second.
    await waitForText(
      driver,
      "FAKE CLAUDE --session-id",
      process.platform === "win32" ? 90_000 : 20_000,
    );
    await waitForText(driver, "in ");
    const text = await screenText(driver);
    expect(text).toMatch(/--session-id [0-9a-f-]{36}/);
    // Where it was started, in its own words. A path cmd.exe refuses puts
    // it in the Windows directory instead.
    expect(text).toMatch(new RegExp(`in .*${repo.split(/[\\/]/).pop()}`));
    await waitForPaneText(driver, SESSIONS, "running");
  });

  it("sends what you type through and shows what comes back", async () => {
    const { driver } = app;
    await type(driver, "hello there\n");
    await waitForText(driver, "echo: hello there");
  });

  it("sees the agent's own edit through the watcher", async () => {
    const { driver } = app;
    writeFileSync(join(repo, "README.md"), "# demo\n\nedited\n");
    await waitForPaneText(driver, TREE, "README.md");
  });

  it("reports the exit code when the agent dies", async () => {
    const { driver } = app;
    await type(driver, "crash\n");
    // The overlay is only there once the session stops, and how long the
    // agent takes to die is the platform's business: wait for it to appear
    // rather than expecting it the instant the newline is through. When it
    // does not, the screen says whether the word even reached the agent.
    try {
      const status = await driver.wait(
        until.elementLocated(By.css("[data-testid='agent-status']")),
        15_000,
      );
      await driver.wait(until.elementTextContains(status, "code 3"), 15_000);
    } catch (failure) {
      const screen = await screenText(driver);
      const rows = await textOf(driver, SESSIONS);
      throw new Error(
        `${(failure as Error).message}\nThe terminal showed:\n${screen}\nThe sessions pane showed:\n${rows}`,
      );
    }
  });

  // The chord reaches the settings whether the native menu's accelerator
  // takes it or the webview does.
  it("opens the settings on the chord, with the menu in place", async () => {
    const { driver } = app;
    const key = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    await driver.actions().keyDown(key).sendKeys(",").keyUp(key).perform();
    await driver.wait(
      until.elementLocated(By.css("[data-testid='settings']")),
      10_000,
    );
    await driver.findElement(By.css("[data-testid='settings-close']")).click();
    await driver.wait(
      async () =>
        (await driver.findElements(By.css("[data-testid='settings']")))
          .length === 0,
      5_000,
    );
  });

  // Lines search runs git grep in the real repository.
  it("finds lines inside the files", async () => {
    const { driver } = app;
    await driver.findElement(By.css("[data-testid='mode-lines']")).click();
    const field = await driver.findElement(
      By.css("[data-testid='search-field']"),
    );
    await field.sendKeys("println");
    await waitForPaneText(driver, "[data-testid='search-results']", "println");
    await waitForPaneText(driver, "[data-testid='search-results']", "lib.rs");
    await driver.findElement(By.css("[data-testid='search-hit']")).click();
    await waitForPaneText(driver, "[data-testid='viewer']", "println");
    await field.clear();
    await driver.findElement(By.css("[data-testid='mode-files']")).click();
    await driver.findElement(By.css("[data-testid='viewer'] .close")).click();
  });

  // The agent's show tool, through the daemon as the agent would call it:
  // one JSON-RPC exchange on its stdin, and the viewer opens on the lines.
  it("opens the viewer where the agent's show tool pointed", async () => {
    const { driver } = app;
    await openProjects(driver, [repo]);
    await waitForPaneText(driver, SESSIONS, repo.split(/[\\/]/).pop()!);
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
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "show",
          arguments: {
            path: "README.md",
            from: 1,
            to: 2,
            note: "The top of it.",
          },
        },
      },
    ];
    const said = execFileSync(DAEMON, ["mcp"], {
      cwd: repo,
      env: { ...process.env, HOME: app.home },
      input:
        messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
    }).toString();
    expect(said).toContain("Shown:");
    await driver.wait(
      until.elementLocated(By.css("[data-testid='viewer-note']")),
      10_000,
    );
    expect(await textOf(driver, "[data-testid='viewer-note']")).toBe(
      "The top of it.",
    );
    await driver.wait(
      async () =>
        (await driver.findElements(By.css("[data-testid='viewer'] tr.target")))
          .length === 2,
      10_000,
    );

    // The selection tool reads back what the show tool put on screen, from
    // the record the app keeps where the daemon looks.
    const asked = execFileSync(DAEMON, ["mcp"], {
      cwd: repo,
      env: { ...process.env, HOME: app.home },
      input:
        [
          messages[0],
          messages[1],
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "selection", arguments: {} },
          },
        ]
          .map((message) => JSON.stringify(message))
          .join("\n") + "\n",
    }).toString();
    expect(asked).toContain(
      "The user is looking at README.md in the viewer, the file as it is, lines 1 to 2 highlighted.",
    );
    await driver.findElement(By.css("[data-testid='viewer'] .close")).click();
  });

  it("types the agent's command into a new terminal", async () => {
    const { driver } = app;
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
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "terminal",
          arguments: { command: "echo workbench-typed" },
        },
      },
    ];
    const said = execFileSync(DAEMON, ["mcp"], {
      cwd: repo,
      env: { ...process.env, HOME: app.home },
      input:
        messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
    }).toString();
    expect(said).toContain("Typed into a new terminal");
    await driver.wait(
      until.elementLocated(By.css("section[data-pane='terminal']")),
      10_000,
    );
    // The shell echoes what was typed at its prompt; nothing ran.
    await waitForText(driver, "echo workbench-typed");
    expect(await screenText(driver)).not.toMatch(/^workbench-typed$/m);
    // Run it, then start something that stays: the processes section
    // counts it under the shell and lists it when opened.
    await type(driver, "\n");
    await type(driver, "sleep 30 &\n");
    await driver.wait(
      async () =>
        /\(\d+\)/.test(await textOf(driver, "[data-testid='processes-fold']")),
      15_000,
    );
    await driver.executeScript(() =>
      document
        .querySelector<HTMLButtonElement>("[data-testid='processes-fold']")
        ?.click(),
    );
    // Read through the page: WebDriver's own text reader leaves out a
    // row's caption, as it leaves out the tree.
    await driver.wait(
      async () =>
        (
          (await driver.executeScript(() =>
            [
              ...document.querySelectorAll<HTMLElement>(
                "[data-testid='process-row']",
              ),
            ].map((row) => row.innerText),
          )) as string[]
        ).some((text) => text.includes("sleep")),
      10_000,
    );
    await driver.executeScript(() =>
      document
        .querySelector<HTMLButtonElement>("[data-testid='processes-fold']")
        ?.click(),
    );
    // Leave things as they were: the shell closed, the panel hidden. The
    // row's close button shows on hover, which the driver does not do.
    for (const id of ["close-terminal", "hide-terminal"]) {
      await driver.executeScript(
        (id: string) =>
          document
            .querySelector<HTMLButtonElement>(`[data-testid='${id}']`)
            ?.click(),
        id,
      );
    }
    await driver.wait(
      async () =>
        (await driver.findElements(By.css("[data-testid='close-terminal']")))
          .length === 0,
      10_000,
    );
  });

  it("opens the diff where the agent's diff tool pointed", async () => {
    const { driver } = app;
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
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "diff",
          arguments: { path: "lib.rs", note: "It says hi now." },
        },
      },
    ];
    const said = execFileSync(DAEMON, ["mcp"], {
      cwd: repo,
      env: { ...process.env, HOME: app.home },
      input:
        messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
    }).toString();
    expect(said).toContain("Opened the diff of");
    await driver.wait(
      until.elementLocated(By.css("[data-testid='viewer'][data-view='diff']")),
      10_000,
    );
    expect(await textOf(driver, "[data-testid='viewer-note']")).toBe(
      "It says hi now.",
    );
    await driver.findElement(By.css("[data-testid='viewer'] .close")).click();
  });

  // The present tool the same way: a real PNG in the repository, presented
  // through the daemon, opens in the viewer and lands on the media list.
  it("opens the modal where the agent's present tool pointed", async () => {
    const { driver } = app;
    writeFileSync(
      join(repo, "shot.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      ),
    );
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
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "present",
          arguments: { files: ["shot.png"], caption: "One pixel." },
        },
      },
    ];
    const said = execFileSync(DAEMON, ["mcp"], {
      cwd: repo,
      env: { ...process.env, HOME: app.home },
      input:
        messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
    }).toString();
    expect(said).toContain("Presented 1 file.");
    await driver.wait(
      until.elementLocated(By.css("[data-testid='media-stack']")),
      10_000,
    );
    expect(await textOf(driver, "[data-testid='media-caption']")).toBe(
      "One pixel.",
    );
    await driver.wait(
      until.elementLocated(By.css("[data-testid='media-file'] img")),
      10_000,
    );
    // Rendered text, which the fold's style sets in capitals.
    expect(
      (await textOf(driver, "[data-testid='media-fold']")).toLowerCase(),
    ).toContain("media (1)");
    await driver.findElement(By.css("[data-testid='viewer'] .close")).click();
  });

  // The whole of the plugin system, end to end: a directory added as a
  // source in the settings, its plugin turned on and running as a process
  // of node's, the rows it sends drawn under the tree, its actions taken
  // from a row and from a section's header, the page it sends opened, its
  // tool offered to the agent through the daemon and answered by the
  // process, and everything of its gone when it is turned off.
  //
  // Before the remote: the remote here is the daemon on this machine, with
  // this home, and both cores read the same log of tool calls. A call is
  // answered by whichever reaches it first, and only one of them has the
  // plugin.
  it("runs a plugin, draws its rows and offers its tool to the agent", async () => {
    const { driver } = app;
    // The project on screen, whose rows these are.
    await openProjects(driver, [repo]);
    await waitForPaneText(driver, SESSIONS, repo.split(/[\\/]/).pop()!);

    const chord = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    // The chord opens the settings and never closes them, so one that
    // landed while the page was still coming back from the reload costs a
    // second press and nothing else.
    const openSettings = async () => {
      for (let attempt = 0; ; attempt += 1) {
        await driver
          .actions()
          .keyDown(chord)
          .sendKeys(",")
          .keyUp(chord)
          .perform();
        try {
          await driver.wait(
            until.elementLocated(By.css("[data-testid='settings']")),
            5_000,
          );
          return;
        } catch (failure) {
          if (attempt >= 3) throw failure;
        }
      }
    };
    const closeSettings = async () => {
      await driver
        .findElement(By.css("[data-testid='settings-close']"))
        .click();
      await driver.wait(
        async () =>
          (await driver.findElements(By.css("[data-testid='settings']")))
            .length === 0,
        10_000,
      );
    };
    const pluginState = () =>
      textOf(driver, `${SETTINGS_PLUGIN} [data-testid='plugin-state']`);
    // The rows of the section under the tree, read through the page: the
    // driver's own text reader leaves out a row's caption, as it leaves
    // out the tree.
    const sectionRows = () =>
      driver.executeScript(
        (selector: string) =>
          [...document.querySelectorAll<HTMLElement>(selector)].map((row) => ({
            text: row.innerText,
            state: row.querySelector<HTMLElement>(".dot")?.dataset.state ?? "",
          })),
        `${CHANGES} [data-testid='plugin-row']`,
      ) as Promise<{ text: string; state: string }[]>;
    const waitForRow = (needle: string) =>
      driver.wait(
        async () =>
          (await sectionRows()).some((row) => row.text.includes(needle)),
        15_000,
        `no row saying "${needle}"`,
      );
    const click = (selector: string) =>
      driver.executeScript(
        (selector: string) =>
          document.querySelector<HTMLButtonElement>(selector)?.click(),
        selector,
      );

    // The source: a directory on this machine, added by path.
    await openSettings();
    await driver
      .findElement(By.css("[data-testid='plugin-location']"))
      .sendKeys(PLUGIN_SOURCE);
    await driver.findElement(By.css("[data-testid='plugin-add']")).click();
    await driver.wait(
      until.elementLocated(By.css("[data-testid='plugin-source']")),
      20_000,
    );
    expect(await textOf(driver, "[data-testid='plugin-source']")).toContain(
      "directory",
    );
    await driver.wait(
      async () => (await textOf(driver, SETTINGS_PLUGIN)).includes("1.2.3"),
      10_000,
      "the source listed no plugin",
    );
    // What turning it on would mean, before it has run.
    expect(await pluginState()).toContain(
      "1 tool, 1 section, a wide view, runs node",
    );

    // On, after the question that comes with it, and started.
    await driver
      .findElement(By.css(`${SETTINGS_PLUGIN} [data-testid='plugin-on']`))
      .click();
    await driver.findElement(By.css("[data-testid='plugin-agree']")).click();
    await driver.wait(
      async () => {
        const state = await pluginState();
        return state.includes("starting") || state.includes("running");
      },
      30_000,
      "the plugin was never started",
    );
    await closeSettings();

    // The plugin's own word that it is up: its section under the tree,
    // counted in the header while folded.
    await driver.wait(
      async () =>
        (await textOf(driver, `${CHANGES} [data-testid='plugin-fold']`))
          .toLowerCase()
          .includes("driver board (2)"),
      60_000,
      "the plugin's section never arrived",
    );
    expect(await sectionRows()).toHaveLength(0);
    await click(`${CHANGES} [data-testid='plugin-fold']`);
    await driver.wait(
      async () => (await sectionRows()).length === 2,
      10_000,
      "the section did not open on its rows",
    );
    const rows = await sectionRows();
    expect(rows[0].text).toContain("ready");
    expect(rows[0].text).toContain("the fixture is up");
    expect(rows[0].state).toBe("ok");
    expect(rows[1].text).toContain("notes");
    expect(rows[1].state).toBe("waiting");

    // A row's own action, echoed back as the row's label. The actions
    // show on hover, which the driver does not do.
    await click(
      `${CHANGES} [data-testid='plugin-row'][data-row='notes']` +
        " [data-testid='plugin-row-action'][data-action='echo']",
    );
    await waitForRow("did echo on notes with nothing");

    // The header's action, which asks for a line before it runs.
    await click(
      `${CHANGES} [data-testid='plugin-section-action'][data-action='note']`,
    );
    await driver.wait(
      until.elementLocated(By.css("[data-testid='action-input']")),
      10_000,
    );
    expect(
      (await textOf(driver, "[data-testid='action-input']")).toLowerCase(),
    ).toContain("note");
    await driver
      .findElement(By.css("[data-testid='action-text']"))
      .sendKeys("from the dialog");
    await driver.findElement(By.css("[data-testid='action-run']")).click();
    await driver.wait(
      async () =>
        (await driver.findElements(By.css("[data-testid='action-input']")))
          .length === 0,
      10_000,
    );
    await waitForRow("did note on the header with from the dialog");

    // The page the plugin sends, in the viewer beside the tree.
    await click(
      `${CHANGES} [data-testid='plugin-section-action'][data-action='page']`,
    );
    await driver.wait(
      until.elementLocated(By.css("[data-testid='plugin-view-open']")),
      15_000,
    );
    await driver
      .findElement(By.css("[data-testid='plugin-view-open']"))
      .click();
    await driver.wait(
      until.elementLocated(
        By.css("[data-testid='viewer'][data-view='plugin']"),
      ),
      10_000,
    );
    expect(await textOf(driver, "[data-testid='plugin-view-name']")).toBe(
      "driverboard",
    );
    await driver.wait(
      until.elementLocated(By.css("[data-testid='plugin-page']")),
      10_000,
    );
    await driver.findElement(By.css("[data-testid='viewer'] .close")).click();

    // The tool, as the agent meets it: under the plugin's name on the
    // tool server, and answered by the process a call away.
    const handshake = [
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
    ];
    const ask = (message: unknown) =>
      execFileSync(DAEMON, ["mcp"], {
        cwd: repo,
        env: { ...process.env, HOME: app.home },
        input:
          [...handshake, message]
            .map((message) => JSON.stringify(message))
            .join("\n") + "\n",
      }).toString();
    const listed = ask({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(listed).toContain("driverboard_ping");
    expect(listed).toContain("Answers with what it was given.");
    const answered = ask({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "driverboard_ping",
        arguments: { text: "over the wire" },
      },
    });
    expect(answered).toContain("pong: over the wire");

    // Off again. The settings ask the core for its sources as they open,
    // so the row is its latest word: the process is up, at the version it
    // greeted with.
    await openSettings();
    await driver.wait(
      async () => (await pluginState()).includes("running 1.2.3"),
      30_000,
      "the settings never said the plugin was running",
    );
    await driver
      .findElement(By.css(`${SETTINGS_PLUGIN} [data-testid='plugin-off']`))
      .click();
    await driver.wait(
      async () => (await pluginState()).includes("off"),
      30_000,
      "the plugin never went off",
    );
    await closeSettings();
    await driver.wait(
      async () =>
        (
          await driver.findElements(
            By.css(`${CHANGES} [data-testid='plugin-section']`),
          )
        ).length === 0,
      20_000,
      "the section stayed under the tree",
    );
  }, 120_000);

  // A project on another machine: the path names the host, the app runs
  // the daemon there (here, the daemon itself) and everything else is the
  // same. The agent starts on the remote, its bytes come back, the watcher
  // there reports the edit, and the crash arrives as an ended session. A
  // remote path is POSIX, so not from a Windows checkout.
  it.skipIf(process.platform === "win32")(
    "opens a project on a remote and runs the agent there",
    async () => {
      const { driver } = app;
      const remote = `ssh://test${repo}`;
      await openProjects(driver, [remote]);
      await waitForPaneText(driver, SESSIONS, repo.split(/[\\/]/).pop()!);
      // The row is there before the agents are detected again after the
      // reload; the button follows the detection.
      await driver
        .wait(
          until.elementLocated(By.css("[data-testid='new-session']")),
          10_000,
        )
        .click();
      await driver
        .findElement(
          By.css("[data-testid='agent-option'][data-agent='claude-code']"),
        )
        .click();
      await waitForText(driver, "FAKE CLAUDE --session-id");
      await waitForText(driver, "in ");
      expect(await screenText(driver)).toMatch(
        new RegExp(`in .*${repo.split(/[\\/]/).pop()}`),
      );
      await type(driver, "over the wire\n");
      await waitForText(driver, "echo: over the wire");

      writeFileSync(join(repo, "NOTES.md"), "remote\n");
      await waitForPaneText(driver, TREE, "NOTES.md");

      await type(driver, "crash\n");
      const status = await driver.wait(
        until.elementLocated(By.css("[data-testid='agent-status']")),
        15_000,
      );
      await driver.wait(until.elementTextContains(status, "code 3"), 15_000);

      // The terminal panel's shell is on the remote too, in the project.
      const key = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
      await driver.actions().keyDown(key).sendKeys("j").keyUp(key).perform();
      await driver.wait(
        until.elementLocated(By.css("[data-testid='terminal']")),
        10_000,
      );
      await type(driver, "echo shell-in-$PWD\n");
      await waitForText(driver, `shell-in-${repo}`);
      await driver.actions().keyDown(key).sendKeys("j").keyUp(key).perform();
    },
  );

  it("offers codex too, and runs it", async () => {
    const { driver } = app;
    // A claude session first, so the tags have two kinds to tell apart
    // whatever the tests before left in the list.
    await driver.findElement(By.css("[data-testid='new-session']")).click();
    let options = await driver.findElements(
      By.css("[data-testid='agent-option']"),
    );
    expect(options).toHaveLength(2);
    await options[0].click();
    await waitForText(driver, "FAKE CLAUDE");
    await driver.findElement(By.css("[data-testid='new-session']")).click();
    options = await driver.findElements(By.css("[data-testid='agent-option']"));
    await options[1].click();
    await waitForText(driver, "FAKE CODEX");
    const tags = await driver.findElements(By.css("[data-testid='agent-tag']"));
    const texts = await Promise.all(tags.map((tag) => tag.getText()));
    expect(texts.slice(-2)).toEqual(["claude", "codex"]);
  });
});
