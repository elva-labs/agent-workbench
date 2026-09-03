import { expect, test, type Page } from "@playwright/test";

/**
 * The agent pane, driven by a fake core.
 *
 * `window.__WORKBENCH_CORE__` is the seam `src/lib/core.ts` already checks, so
 * these tests exercise the real terminal, the real write queue and the real
 * exit policy without emulating Tauri's IPC internals. The Rust side is covered
 * by `cargo test`, and the two meeting is covered by running the app.
 */

const AGENT = "section[data-pane='agent']";
const SESSIONS = "section[data-pane='sessions']";
const MOD = "ControlOrMeta";
const KEYBOARD = `${AGENT} .xterm-helper-textarea`;
const PROJECT = "/home/ada/dev/demo";

interface FakeOptions {
  /** Leave unset to open the app with no project, as a first run would. */
  project?: string | null;
  binary?: string | null;
  failSpawn?: string | null;
}

declare global {
  interface Window {
    __fake: {
      writes: string[];
      resizes: { cols: number; rows: number }[];
      spawns: { agent: string; project: string; cols: number; rows: number }[];
      killed: string[];
      titles: string[];
      picked: string | null;
      output: ((bytes: Uint8Array) => void) | null;
      enders: ((ended: unknown) => void)[];
      failSpawn: string | null;
      binary: string | null;
      emit: (text: string) => void;
      end: (code: number | null, clean: boolean) => void;
      buffer: () => string;
    };
  }
}

async function installFakeCore(page: Page, options: FakeOptions = {}) {
  await page.addInitScript(
    ({ project, binary, failSpawn }) => {
      const fake: Window["__fake"] = {
        writes: [],
        resizes: [],
        spawns: [],
        killed: [],
        titles: [],
        picked: null,
        output: null,
        enders: [],
        failSpawn: failSpawn ?? null,
        binary: binary === undefined ? "/usr/local/bin/claude" : binary,
        emit(text) {
          fake.output?.(new TextEncoder().encode(text));
        },
        end(code, clean) {
          for (const handler of fake.enders) handler({ id: "pty-1", code, clean });
        },
        buffer() {
          const term = (window as unknown as { __WORKBENCH_TERMINAL__?: any })
            .__WORKBENCH_TERMINAL__;
          if (!term) return "";
          const active = term.buffer.active;
          const lines: string[] = [];
          for (let i = 0; i < active.length; i++) {
            lines.push(active.getLine(i)?.translateToString(true) ?? "");
          }
          return lines.join("\n").trim();
        },
      };
      window.__fake = fake;

      if (project) {
        localStorage.setItem(
          "workbench.project",
          JSON.stringify({ current: project, recent: [project] }),
        );
      } else {
        localStorage.removeItem("workbench.project");
      }

      let spawnId = 0;
      (window as unknown as { __WORKBENCH_CORE__: unknown }).__WORKBENCH_CORE__ = {
        detect: async () => ({
          id: "claude-code",
          path: fake.binary,
          caps: null,
          fromLoginShell: true,
        }),
        pickProject: async () => fake.picked,
        projectInfo: async (path: string) => ({
          path,
          name: path.split("/").filter(Boolean).pop() ?? path,
          repository: path,
          isGit: true,
        }),
        setWindowTitle: async (title: string) => {
          fake.titles.push(title);
        },
        spawn: async (spawnOptions: any, onOutput: (bytes: Uint8Array) => void) => {
          if (fake.failSpawn) throw new Error(fake.failSpawn);
          fake.spawns.push(spawnOptions);
          fake.output = onOutput;
          return `pty-${++spawnId}`;
        },
        write: async (_id: string, data: string) => {
          fake.writes.push(data);
        },
        resize: async (_id: string, cols: number, rows: number) => {
          fake.resizes.push({ cols, rows });
        },
        kill: async (id: string) => {
          fake.killed.push(id);
        },
        onSessionEnded: async (handler: (ended: unknown) => void) => {
          fake.enders.push(handler);
          return () => {};
        },
      };
    },
    { project: options.project ?? null, binary: options.binary, failSpawn: options.failSpawn },
  );
}

const buffer = (page: Page) => page.evaluate(() => window.__fake.buffer());
const typed = (page: Page) => page.evaluate(() => window.__fake.writes.join(""));
const spawnCount = (page: Page) => page.evaluate(() => window.__fake.spawns.length);
const running = (page: Page) => expect(page.locator(AGENT)).toContainText("running");

/** Opens the app with a project already chosen, so the agent starts by itself. */
async function withProject(page: Page, options: FakeOptions = {}) {
  await installFakeCore(page, { project: PROJECT, ...options });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
}

test.describe("with no project", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeCore(page);
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
  });

  test("asks for a project rather than offering to start", async ({ page }) => {
    await expect(page.getByTestId("agent-status")).toContainText("Open a project");
    await expect(page.getByTestId("start-agent")).toHaveCount(0);
    await expect(page.locator(AGENT)).toContainText("no project");
  });

  test("starts nothing", async ({ page }) => {
    await page.waitForTimeout(400);
    expect(await spawnCount(page)).toBe(0);
  });

  test("the sessions pane asks for one too", async ({ page }) => {
    await expect(page.getByTestId("no-project")).toBeVisible();
    await expect(page.getByTestId("open-project")).toBeVisible();
  });
});

test.describe("with a project", () => {
  test.beforeEach(async ({ page }) => {
    await withProject(page);
  });

  // A workbench whose purpose is running an agent opens with one running.
  test("starts the agent by itself", async ({ page }) => {
    await running(page);
    await expect(page.getByTestId("agent-status")).toHaveCount(0);
    expect(await spawnCount(page)).toBe(1);
  });

  test("spawns in the project, at the size the pane actually is", async ({ page }) => {
    await running(page);
    const spawn = await page.evaluate(() => window.__fake.spawns[0]);

    expect(spawn.agent).toBe("claude-code");
    expect(spawn.project).toBe(PROJECT);
    expect(spawn.cols).toBeGreaterThan(20);
    expect(spawn.rows).toBeGreaterThan(5);
  });

  test("names the project in the pane and the window title", async ({ page }) => {
    await expect(page.locator(SESSIONS)).toContainText("demo");
    const titles = await page.evaluate(() => window.__fake.titles);
    expect(titles.at(-1)).toContain("demo");
  });

  test("writes the agent's output into the terminal", async ({ page }) => {
    await running(page);
    await page.evaluate(() => window.__fake.emit("rename the token cache module"));
    await expect.poll(() => buffer(page)).toContain("rename the token cache module");
  });

  // The queue exists so a redraw costs one parse per frame rather than one per
  // chunk, and a character split across two reads has to survive the join.
  test("joins chunks, including one split mid-character", async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      const full = new TextEncoder().encode("⏺ Read");
      window.__fake.output?.(full.slice(0, 1));
      window.__fake.output?.(full.slice(1));
    });

    await expect.poll(() => buffer(page)).toContain("⏺ Read");
  });

  test("renders ANSI colour rather than printing the escapes", async ({ page }) => {
    await running(page);
    await page.evaluate(() => window.__fake.emit("\u001b[36msrc/cache/mod.rs\u001b[0m"));

    await expect.poll(() => buffer(page)).toContain("src/cache/mod.rs");
    expect(await buffer(page)).not.toContain("[36m");
  });

  test("sends what you type through to the agent", async ({ page }) => {
    await running(page);
    await page.locator(KEYBOARD).press("h");
    await page.locator(KEYBOARD).press("i");
    await expect.poll(() => typed(page)).toBe("hi");
  });

  // Ctrl+C belongs to the agent. The app claims Cmd chords and nothing else.
  test("passes Ctrl+C through rather than claiming it", async ({ page }) => {
    await running(page);
    await page.locator(KEYBOARD).press("Control+c");
    await expect.poll(() => typed(page)).toContain("\u0003");
  });

  test("resizes the pty when the window changes the column count", async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      window.__fake.resizes.length = 0;
    });

    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(() => page.evaluate(() => window.__fake.resizes.length)).toBeGreaterThan(0);

    const last = await page.evaluate(() => window.__fake.resizes.at(-1));
    expect(last!.cols).toBeGreaterThan(10);
    expect(last!.rows).toBeGreaterThan(5);
  });

  test("says the agent exited cleanly and offers a restart", async ({ page }) => {
    await running(page);
    await page.evaluate(() => window.__fake.end(0, true));

    await expect(page.getByTestId("agent-status")).toContainText("The agent exited.");
    await expect(page.getByTestId("start-agent")).toHaveText("Restart");
  });

  // Never respawn on its own: a broken install would otherwise become a loop
  // that burns CPU and hides the actual error.
  test("names the exit code on a crash and waits to be asked", async ({ page }) => {
    await running(page);
    await page.evaluate(() => window.__fake.end(127, false));

    await expect(page.getByTestId("agent-status")).toContainText("code 127");
    await page.waitForTimeout(500);
    expect(await spawnCount(page)).toBe(1);
  });

  test("restarts when asked, and clears the previous output", async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      window.__fake.emit("first run");
      window.__fake.end(0, true);
    });
    await expect.poll(() => buffer(page)).toContain("first run");

    await page.getByTestId("start-agent").click();
    await running(page);
    await expect.poll(() => buffer(page)).not.toContain("first run");
    expect(await spawnCount(page)).toBe(2);
  });

  test("reports a kill without inventing an exit code", async ({ page }) => {
    await running(page);
    await page.evaluate(() => window.__fake.end(null, false));
    await expect(page.getByTestId("agent-status")).toContainText("The agent was stopped.");
  });

  test("keeps the crashed session's output on screen to be read", async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      window.__fake.emit("panicked at src/main.rs");
      window.__fake.end(101, false);
    });

    await expect(page.getByTestId("agent-status")).toContainText("code 101");
    await expect.poll(() => buffer(page)).toContain("panicked at");
  });

  // Hidden is not unmounted: the session survives, and no respawn happens.
  test("survives being hidden and shown again while reviewing", async ({ page }) => {
    await running(page);
    await page.setViewportSize({ width: 720, height: 800 });

    await page.keyboard.press(`${MOD}+d`);
    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.locator(AGENT)).toBeHidden();

    await page.keyboard.press(`${MOD}+d`);
    await expect(page.locator(AGENT)).toBeVisible();
    await running(page);
    expect(await spawnCount(page)).toBe(1);
  });

  test("recolours the terminal when the theme changes, without respawning", async ({ page }) => {
    await running(page);

    const background = () =>
      page.evaluate(
        () =>
          (window as unknown as { __WORKBENCH_TERMINAL__: any }).__WORKBENCH_TERMINAL__.options
            .theme.background,
      );

    const before = await background();
    await page.keyboard.press(`${MOD}+Shift+T`);
    await page.keyboard.press(`${MOD}+Shift+T`);

    await expect.poll(background).not.toBe(before);
    expect(await spawnCount(page)).toBe(1);
  });

  // Switching leaves the PTY in the wrong directory, and you may be mid-task.
  test("asks before discarding a running agent to open another project", async ({ page }) => {
    await running(page);
    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("switch-confirm")).toBeVisible();
  });

  test("opens the picked project and starts an agent in it", async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      window.__fake.picked = "/home/ada/dev/other";
    });

    await page.getByTestId("open-project").click();
    await page.getByTestId("confirm-switch").click();

    await expect(page.locator(SESSIONS)).toContainText("other");
    await expect.poll(() => spawnCount(page)).toBe(2);
    const spawn = await page.evaluate(() => window.__fake.spawns.at(-1));
    expect(spawn!.project).toBe("/home/ada/dev/other");
  });

  test("stops the old agent when the project changes", async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      window.__fake.picked = "/home/ada/dev/other";
    });

    await page.getByTestId("open-project").click();
    await page.getByTestId("confirm-switch").click();

    await expect.poll(() => page.evaluate(() => window.__fake.killed.length)).toBeGreaterThan(0);
  });

  test("cancelling the confirmation leaves everything alone", async ({ page }) => {
    await running(page);
    await page.getByTestId("open-project").click();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByTestId("switch-confirm")).toHaveCount(0);
    expect(await spawnCount(page)).toBe(1);
  });
});

test.describe("when things are missing", () => {
  test("explains a missing binary and offers nothing to press", async ({ page }) => {
    await withProject(page, { binary: null });
    await expect(page.getByTestId("agent-status")).toContainText("not found on your PATH");
    await expect(page.getByTestId("start-agent")).toHaveCount(0);
    expect(await spawnCount(page)).toBe(0);
  });

  test("reports a spawn that never got started, and does not retry", async ({ page }) => {
    await withProject(page, { failSpawn: "no pty available" });
    await expect(page.getByTestId("agent-status")).toContainText("no pty available");
    await expect(page.getByTestId("start-agent")).toHaveText("Restart");

    await page.waitForTimeout(500);
    expect(await spawnCount(page)).toBe(0);
  });
});
