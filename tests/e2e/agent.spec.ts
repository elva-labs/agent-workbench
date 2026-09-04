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
      /** Links handed to the system browser. */
      opened: string[];
      picked: string | null;
      outputs: Record<string, (bytes: Uint8Array) => void>;
      enders: ((ended: unknown) => void)[];
      failSpawn: string | null;
      binary: string | null;
      /** What the core says the agent's working directory is. */
      cwd: string | null;
      /** The app's handler for files dragged over the window. */
      drag: ((drag: unknown) => void) | null;
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
        opened: [],
        picked: null,
        outputs: {},
        enders: [],
        failSpawn: failSpawn ?? null,
        binary: binary === undefined ? "/usr/local/bin/claude" : binary,
        cwd: null,
        drag: null,
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
        openUrl: async (url: string) => {
          fake.opened.push(url);
        },
        spawn: async (spawnOptions: any, onOutput: (bytes: Uint8Array) => void) => {
          if (fake.failSpawn) throw new Error(fake.failSpawn);
          const id = `pty-${++ptyCount}`;
          fake.spawns.push(spawnOptions);
          fake.outputs[id] = onOutput;
          return { ptyId: id, sessionId: spawnOptions.session ?? `session-${ptyCount}` };
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
        ptyCwd: async () => fake.cwd,
        onSessionEnded: async (handler: (ended: unknown) => void) => {
          fake.enders.push(handler);
          return () => {};
        },
        onFileDrag: async (handler: (drag: unknown) => void) => {
          fake.drag = handler;
          return () => {};
        },

        // These tests are about sessions, so the repository is empty. The
        // changes pane still asks, and would break the page if it threw.
        transcripts: async () => [],
        hookStatus: async () => ({ installed: false, settings: "", events: "" }),
        hookInstall: async () => ({ installed: true, settings: "", events: "" }),
        hookUninstall: async () => ({ installed: false, settings: "", events: "" }),
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

  // Claude Code names the session in the terminal title, glyph and all.
  test("calls the session what the agent calls it", async ({ page }) => {
    await running(page);
    await expect(rows(page).first()).toContainText("session 1");
    await page.evaluate(() =>
      window.__fake.emit("pty-1", "\x1b]0;\u2733 fix-activity-tracking-bugs\x07"),
    );
    await expect(rows(page).first()).toContainText("fix-activity-tracking-bugs");
    await expect(rows(page).first()).not.toContainText("session 1");
  });

  // Cmd+click on a link is the terminal convention; a plain click stays
  // the program's, which may be using the mouse itself.
  test("opens a link on mod+click, and not on a plain click", async ({ page }) => {
    await running(page);
    await page.evaluate(() =>
      window.__fake.emit("pty-1", "Created: https://example.com/issues/6932 \r\n"),
    );
    await expect.poll(() => buffer(page)).toContain("example.com");

    const term = page.locator(`${AGENT} [data-testid='terminal']`);
    const box = await term.boundingBox();
    if (!box) throw new Error("no terminal");
    // Row 0, a few cells into the URL. Cells are measured from the padding
    // edge: xterm's element carries the 8px inset.
    const cell = await page.evaluate(() => {
      const t = (window as unknown as { __WORKBENCH_TERMINALS__?: Record<string, any> })
        .__WORKBENCH_TERMINALS__?.["s1"];
      const size = t?._core._renderService.dimensions.css.cell;
      return size ? { w: size.width, h: size.height } : null;
    });
    if (!cell) throw new Error("no cell size");
    const x = box.x + 12 + cell.w * 20;
    const y = box.y + 8 + cell.h / 2;

    await page.mouse.click(x, y);
    expect(await page.evaluate(() => window.__fake.opened)).toEqual([]);

    await page.keyboard.down(MOD);
    await page.mouse.click(x, y);
    await page.keyboard.up(MOD);
    await expect
      .poll(() => page.evaluate(() => window.__fake.opened))
      .toEqual(["https://example.com/issues/6932"]);
  });

  test("switches session from the keyboard and lands in the agent", async ({ page }) => {
    await running(page);
    await page.getByTestId("new-session").click();
    await expect(rows(page)).toHaveCount(2);

    await page.keyboard.press(`${MOD}+1`);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
    await expect(page.locator("[data-testid='session-row']").first()).toContainText("session 1");
    await expect(page.locator(".session.on")).toContainText("session 1");
    // Typing goes into the terminal without a click.
    await page.keyboard.type("x");
    await expect.poll(() => typed(page)).toContain("x");
  });

  test("steps between sessions with a chord, from anywhere", async ({ page }) => {
    await running(page);
    await page.getByTestId("new-session").click();
    await expect(page.locator(".session.on")).toContainText("session 2");
    await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
    await expect(page.locator(".session.on")).toContainText("session 1");
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    await expect(page.locator(".session.on")).toContainText("session 2");
  });

  test("hands the keyboard back to the agent on Escape from a list pane", async ({ page }) => {
    await running(page);
    await page.keyboard.press(`${MOD}+1`);
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: sessions");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("focus-readout")).toHaveText("focus: agent");
  });

  // A dropped file is its path, typed where the pointer is. Claude Code reads
  // a pasted path, and shows an image file as an attachment.
  test("types the paths of files dropped on it", async ({ page }) => {
    await running(page);
    const term = page.locator(`${AGENT} [data-testid='terminal']`);
    const box = await term.boundingBox();
    if (!box) throw new Error("no terminal");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.evaluate(([x, y]) => window.__fake.drag?.({ type: "over", x, y }), [x, y]);
    await expect(term).toHaveClass(/target/);

    await page.evaluate(
      ([x, y]) =>
        window.__fake.drag?.({
          type: "drop",
          paths: ["/Users/ada/Screen Shot.png", "/Users/ada/notes.md"],
          x,
          y,
        }),
      [x, y],
    );
    await expect(term).not.toHaveClass(/target/);
    await expect
      .poll(() => typed(page))
      .toContain("/Users/ada/Screen\\ Shot.png /Users/ada/notes.md ");
  });

  test("takes a drop on the pane's chrome as a drop on the agent", async ({ page }) => {
    await running(page);
    await page.evaluate(() =>
      window.__fake.drag?.({ type: "drop", paths: ["/tmp/x.txt"], x: 2, y: 2 }),
    );
    await expect.poll(() => typed(page)).toContain("/tmp/x.txt ");
  });

  // The agent moves into a worktree; the changes pane follows, and says so.
  test("follows the session into a worktree", async ({ page }) => {
    await running(page);
    const changes = page.locator("section[data-pane='changes']");
    await expect(changes).not.toContainText("worktree");

    await page.evaluate(() => {
      window.__fake.cwd = "/home/ada/dev/one/.claude/worktrees/feature";
    });
    await expect(changes).toContainText("worktree feature", { timeout: 6000 });
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

  // The last row is the one the prompt lives on. It has to be inside the
  // pane at every height, not just the ones that happen to divide evenly.
  test("keeps the last row inside the pane at any height", async ({ page }) => {
    await running(page);
    for (const height of [900, 811, 723, 677]) {
      await page.setViewportSize({ width: 1200, height });
      await page.waitForTimeout(100);
      const host = await page.locator(`${AGENT} [data-testid='terminal']`).boundingBox();
      const screen = await page.locator(`${AGENT} .xterm-screen`).boundingBox();
      expect(host).not.toBeNull();
      expect(screen).not.toBeNull();
      expect(screen!.y + screen!.height).toBeLessThanOrEqual(host!.y + host!.height - 8);
      expect(screen!.y).toBeGreaterThanOrEqual(host!.y + 8);
    }
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
