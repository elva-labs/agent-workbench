import { expect, test, type Page } from "@playwright/test";

/**
 * Sessions, driven by a fake core.
 *
 * `window.__WORKBENCH_CORE__` is the seam `src/lib/core.ts` already checks, so
 * these tests exercise the real terminals, the real write queue and the real
 * exit policy without emulating Tauri's IPC internals. The Rust side is covered
 * by `cargo test`, and the two meeting is covered by running the app.
 */

const AGENT = "section[data-pane='agent']";
const SESSIONS = "section[data-pane='sessions']";
const MOD = "ControlOrMeta";
const KEYBOARD = `${AGENT} .xterm-helper-textarea`;
const ONE = "/home/ada/dev/one";
const TWO = "/home/ada/dev/two";

interface FakeOptions {
  /** Projects the window opens with. Empty is a first run. */
  open?: string[];
  binary?: string | null;
  failSpawn?: string | null;
}

declare global {
  interface Window {
    __fake: {
      writes: string[];
      resizes: { cols: number; rows: number }[];
      spawns: { agent: string; project: string; session?: string }[];
      killed: string[];
      titles: string[];
      picked: string | null;
      outputs: Record<string, (bytes: Uint8Array) => void>;
      enders: ((ended: unknown) => void)[];
      failSpawn: string | null;
      binary: string | null;
      emit: (ptyId: string, text: string) => void;
      end: (ptyId: string, code: number | null, clean: boolean) => void;
      buffer: () => string;
      bufferOf: (sessionKey: string) => string;
    };
  }
}

async function installFakeCore(page: Page, options: FakeOptions = {}) {
  await page.addInitScript(
    ({ open, binary, failSpawn }) => {
      const read = (term: any) => {
        if (!term) return "";
        const active = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < active.length; i++) {
          lines.push(active.getLine(i)?.translateToString(true) ?? "");
        }
        return lines.join("\n").trim();
      };
      const registry = () =>
        (window as unknown as { __WORKBENCH_TERMINALS__?: Record<string, any> })
          .__WORKBENCH_TERMINALS__ ?? {};

      const fake: Window["__fake"] = {
        writes: [],
        resizes: [],
        spawns: [],
        killed: [],
        titles: [],
        picked: null,
        outputs: {},
        enders: [],
        failSpawn: failSpawn ?? null,
        binary: binary === undefined ? "/usr/local/bin/claude" : binary,
        emit(ptyId, text) {
          fake.outputs[ptyId]?.(new TextEncoder().encode(text));
        },
        end(ptyId, code, clean) {
          for (const handler of fake.enders) handler({ id: ptyId, code, clean });
        },
        // The visible terminal, found the way a person would: the one on screen.
        buffer() {
          const visible = document.querySelector(
            "[data-testid='terminal']:not(.hidden)",
          ) as HTMLElement | null;
          const key = visible?.dataset.session;
          return key ? read(registry()[key]) : "";
        },
        bufferOf: (key) => read(registry()[key]),
      };
      window.__fake = fake;

      if (open.length > 0) {
        localStorage.setItem(
          "workbench.workspace",
          JSON.stringify({ open, active: open[0], recent: open }),
        );
      } else {
        localStorage.removeItem("workbench.workspace");
      }

      let ptyCount = 0;
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
          const id = `pty-${++ptyCount}`;
          fake.spawns.push(spawnOptions);
          fake.outputs[id] = onOutput;
          return id;
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

        // These tests are about sessions, so the repository is empty. The
        // changes pane still asks, and would break the page if it threw.
        transcripts: async () => [],
        gitStatus: async () => [],
        gitFiles: async () => [],
        gitDiff: async () => ({ lines: [], binary: false, truncated: false }),
        gitContent: async () => ({ lines: [], binary: false, truncated: false }),
        gitWatch: async () => {},
        onGitChanged: async () => () => {},
      };
    },
    { open: options.open ?? [], binary: options.binary, failSpawn: options.failSpawn },
  );
}

const buffer = (page: Page) => page.evaluate(() => window.__fake.buffer());
const typed = (page: Page) => page.evaluate(() => window.__fake.writes.join(""));
const spawns = (page: Page) => page.evaluate(() => window.__fake.spawns);
const spawnCount = (page: Page) => page.evaluate(() => window.__fake.spawns.length);
const killed = (page: Page) => page.evaluate(() => window.__fake.killed);
const running = (page: Page) => expect(page.locator(AGENT)).toContainText("running");
const rows = (page: Page) => page.locator("[data-testid='session-row']");

async function open(page: Page, options: FakeOptions = {}) {
  await installFakeCore(page, options);
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
}

test.describe("with no project", () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test("asks for a project rather than starting anything", async ({ page }) => {
    await expect(page.getByTestId("agent-status")).toContainText("Open a project");
    await expect(page.getByTestId("no-project")).toBeVisible();
    await page.waitForTimeout(300);
    expect(await spawnCount(page)).toBe(0);
  });
});

test.describe("one project", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, { open: [ONE] });
  });

  // A workbench whose purpose is running an agent opens with one running.
  test("starts a session by itself", async ({ page }) => {
    await running(page);
    await expect(page.getByTestId("agent-status")).toHaveCount(0);
    expect(await spawnCount(page)).toBe(1);
    expect((await spawns(page))[0].project).toBe(ONE);
    await expect(rows(page)).toHaveCount(1);
  });

  test("names the project in the pane and the window title", async ({ page }) => {
    await expect(page.locator(SESSIONS)).toContainText("one");
    expect((await page.evaluate(() => window.__fake.titles)).at(-1)).toContain("one");
  });

  test("writes output into the terminal", async ({ page }) => {
    await running(page);
    await page.evaluate(() => window.__fake.emit("pty-1", "rename the token cache module"));
    await expect.poll(() => buffer(page)).toContain("rename the token cache module");
  });

  test("joins chunks, including one split mid-character", async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      const full = new TextEncoder().encode("⏺ Read");
      window.__fake.outputs["pty-1"](full.slice(0, 1));
      window.__fake.outputs["pty-1"](full.slice(1));
    });
    await expect.poll(() => buffer(page)).toContain("⏺ Read");
  });

  test("sends what you type through", async ({ page }) => {
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

  test("resizes the pty when the column count changes", async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      window.__fake.resizes.length = 0;
    });
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(() => page.evaluate(() => window.__fake.resizes.length)).toBeGreaterThan(0);
  });

  test("says a session ended and offers another", async ({ page }) => {
    await running(page);
    await page.evaluate(() => window.__fake.end("pty-1", 0, true));

    await expect(page.getByTestId("agent-status")).toContainText("The session ended.");
    await expect(page.getByTestId("start-agent")).toHaveText("New session");
  });

  // Never respawn on its own: a broken install would otherwise become a loop.
  test("names the exit code on a crash and waits to be asked", async ({ page }) => {
    await running(page);
    await page.evaluate(() => window.__fake.end("pty-1", 127, false));

    await expect(page.getByTestId("agent-status")).toContainText("code 127");
    await page.waitForTimeout(400);
    expect(await spawnCount(page)).toBe(1);
  });

  test("keeps a stopped session's output on screen to be read", async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      window.__fake.emit("pty-1", "panicked at src/main.rs");
      window.__fake.end("pty-1", 101, false);
    });

    await expect(page.getByTestId("agent-status")).toContainText("code 101");
    await expect.poll(() => buffer(page)).toContain("panicked at");
  });

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

  test("recolours without respawning", async ({ page }) => {
    await running(page);
    const background = () =>
      page.evaluate(() => {
        const visible = document.querySelector(
          "[data-testid='terminal']:not(.hidden)",
        ) as HTMLElement;
        const registry = (window as any).__WORKBENCH_TERMINALS__;
        return registry[visible.dataset.session!].options.theme.background;
      });

    const before = await background();
    await page.keyboard.press(`${MOD}+Shift+T`);
    await page.keyboard.press(`${MOD}+Shift+T`);

    await expect.poll(background).not.toBe(before);
    expect(await spawnCount(page)).toBe(1);
  });
});

test.describe("several sessions in one project", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, { open: [ONE] });
    await running(page);
    await page.getByTestId("new-session").click();
    await expect(rows(page)).toHaveCount(2);
  });

  test("adds a second without stopping the first", async ({ page }) => {
    expect(await spawnCount(page)).toBe(2);
    expect(await killed(page)).toEqual([]);
    await expect(page.locator(SESSIONS)).toContainText("session 1");
    await expect(page.locator(SESSIONS)).toContainText("session 2");
  });

  // The whole point of the model.
  test("switching back leaves both alive, each with its own scrollback", async ({ page }) => {
    await page.evaluate(() => {
      window.__fake.emit("pty-1", "first session output");
      window.__fake.emit("pty-2", "second session output");
    });
    await expect.poll(() => buffer(page)).toContain("second session output");

    await rows(page).first().click();
    await expect.poll(() => buffer(page)).toContain("first session output");
    expect(await buffer(page)).not.toContain("second session output");

    expect(await killed(page)).toEqual([]);
    expect(await spawnCount(page)).toBe(2);
  });

  test("typing goes to the session you are looking at", async ({ page }) => {
    await rows(page).first().click();
    await page.locator(`${AGENT} [data-testid='terminal']:not(.hidden) .xterm-helper-textarea`).press("a");
    await expect.poll(() => typed(page)).toBe("a");
  });

  test("one crashing leaves the other running", async ({ page }) => {
    await page.evaluate(() => window.__fake.end("pty-1", 1, false));

    await expect(page.locator(SESSIONS)).toContainText("stopped");
    await running(page);
  });

  test("closing one stops only that one", async ({ page }) => {
    await page.locator("[data-testid='close-session']").first().click();

    await expect(rows(page)).toHaveCount(1);
    expect(await killed(page)).toEqual(["pty-1"]);
    await running(page);
  });
});

test.describe("several projects", () => {
  test.beforeEach(async ({ page }) => {
    await open(page, { open: [ONE, TWO] });
  });

  test("opens both and starts a session in the one you are looking at", async ({ page }) => {
    await running(page);
    await expect(page.locator(SESSIONS)).toContainText("one");
    await expect(page.locator(SESSIONS)).toContainText("two");
    expect(await spawnCount(page)).toBe(1);
  });

  // No confirm dialog: switching project destroys nothing, so there is nothing
  // to warn about.
  test("switching project leaves the other project's sessions alive", async ({ page }) => {
    await running(page);
    await page.evaluate(() => window.__fake.emit("pty-1", "work in one"));
    await expect.poll(() => buffer(page)).toContain("work in one");

    await page.locator(SESSIONS).getByText("two", { exact: true }).click();
    await expect.poll(() => spawnCount(page)).toBe(2);
    expect(await killed(page)).toEqual([]);

    await page.locator(SESSIONS).getByText("one", { exact: true }).click();
    await expect.poll(() => buffer(page)).toContain("work in one");
    expect(await killed(page)).toEqual([]);
    expect(await spawnCount(page)).toBe(2);
  });

  test("never asks before switching, because nothing is lost", async ({ page }) => {
    await running(page);
    await page.locator(SESSIONS).getByText("two", { exact: true }).click();
    await expect(page.getByTestId("switch-confirm")).toHaveCount(0);
  });

  test("closing a project stops its sessions and keeps the rest", async ({ page }) => {
    await running(page);
    await page.locator(SESSIONS).getByText("two", { exact: true }).click();
    await expect.poll(() => spawnCount(page)).toBe(2);

    await page.locator("[data-testid='close-project']").first().click();

    await expect.poll(() => killed(page)).toEqual(["pty-1"]);
    await expect(page.locator("[data-testid='close-project']")).toHaveCount(1);
    // Closing does not forget it: it drops back to the recent list.
    await expect(page.locator(SESSIONS)).toContainText("~/dev/one");
    await running(page);
  });

  test("opens a picked project and starts a session in it", async ({ page }) => {
    await running(page);
    await page.evaluate(() => {
      window.__fake.picked = "/home/ada/dev/three";
    });

    await page.getByTestId("open-project").click();
    await expect(page.locator(SESSIONS)).toContainText("three");
    await expect.poll(() => spawnCount(page)).toBe(2);
    expect((await spawns(page)).at(-1)!.project).toBe("/home/ada/dev/three");
  });
});

test.describe("when things are missing", () => {
  test("explains a missing binary and starts nothing", async ({ page }) => {
    await open(page, { open: [ONE], binary: null });
    await expect(page.getByTestId("agent-status")).toContainText("not found on your PATH");
    expect(await spawnCount(page)).toBe(0);
  });

  test("reports a spawn that never got started, and does not retry", async ({ page }) => {
    await open(page, { open: [ONE], failSpawn: "no pty available" });
    await expect(page.getByTestId("agent-status")).toContainText("no pty available");

    await page.waitForTimeout(400);
    expect(await spawnCount(page)).toBe(0);
  });
});
