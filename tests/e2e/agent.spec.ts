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
const MOD = "ControlOrMeta";
const KEYBOARD = `${AGENT} .xterm-helper-textarea`;

declare global {
  interface Window {
    __fake: {
      writes: string[];
      resizes: { cols: number; rows: number }[];
      spawns: { agent: string; cols: number; rows: number }[];
      killed: string[];
      output: ((bytes: Uint8Array) => void) | null;
      enders: ((ended: unknown) => void)[];
      detect: { id: string; path: string | null; caps: null; fromLoginShell: boolean };
      failSpawn: string | null;
      emit: (text: string) => void;
      end: (code: number | null, clean: boolean) => void;
      buffer: () => string;
    };
  }
}

async function installFakeCore(page: Page) {
  await page.addInitScript(() => {
    const fake: Window["__fake"] = {
      writes: [],
      resizes: [],
      spawns: [],
      killed: [],
      output: null,
      enders: [],
      detect: {
        id: "claude-code",
        path: "/usr/local/bin/claude",
        caps: null,
        fromLoginShell: true,
      },
      failSpawn: null,
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
    (window as unknown as { __WORKBENCH_CORE__: unknown }).__WORKBENCH_CORE__ = {
      detect: async () => fake.detect,
      spawn: async (options: any, onOutput: (bytes: Uint8Array) => void) => {
        if (fake.failSpawn) throw new Error(fake.failSpawn);
        fake.spawns.push(options);
        fake.output = onOutput;
        return "pty-1";
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
  });
}

const buffer = (page: Page) => page.evaluate(() => window.__fake.buffer());
const typed = (page: Page) => page.evaluate(() => window.__fake.writes.join(""));
const spawnCount = (page: Page) => page.evaluate(() => window.__fake.spawns.length);

test.beforeEach(async ({ page }) => {
  await installFakeCore(page);
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
});

test("offers to start once the binary is found", async ({ page }) => {
  const status = page.getByTestId("agent-status");
  await expect(status).toContainText("Ready.");
  await expect(status).toContainText("/usr/local/bin/claude");
  await expect(page.getByTestId("start-agent")).toHaveText("Start");
});

test("explains a missing binary and offers nothing to press", async ({ page }) => {
  await page.addInitScript(() => {
    const patch = () => {
      if (window.__fake) window.__fake.detect = { ...window.__fake.detect, path: null };
      else queueMicrotask(patch);
    };
    patch();
  });
  await page.reload();

  await expect(page.getByTestId("agent-status")).toContainText("not found on your PATH");
  await expect(page.getByTestId("start-agent")).toHaveCount(0);
});

test("starts, and the status overlay gets out of the way", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await expect(page.locator(AGENT)).toContainText("running");
  await expect(page.getByTestId("agent-status")).toHaveCount(0);
});

test("spawns with the size the pane actually is", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  const spawn = await page.evaluate(() => window.__fake.spawns[0]);

  expect(spawn.agent).toBe("claude-code");
  expect(spawn.cols).toBeGreaterThan(20);
  expect(spawn.rows).toBeGreaterThan(5);
});

test("writes the agent's output into the terminal", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await page.evaluate(() => window.__fake.emit("rename the token cache module"));

  await expect.poll(() => buffer(page)).toContain("rename the token cache module");
});

// The queue exists so a redraw costs one parse per frame rather than one per
// chunk, and a character split across two reads has to survive the join.
test("joins chunks, including one split mid-character", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await page.evaluate(() => {
    const full = new TextEncoder().encode("⏺ Read");
    window.__fake.output?.(full.slice(0, 1));
    window.__fake.output?.(full.slice(1));
  });

  await expect.poll(() => buffer(page)).toContain("⏺ Read");
});

test("renders ANSI colour rather than printing the escapes", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await page.evaluate(() => window.__fake.emit("\u001b[36msrc/cache/mod.rs\u001b[0m"));

  await expect.poll(() => buffer(page)).toContain("src/cache/mod.rs");
  expect(await buffer(page)).not.toContain("[36m");
});

test("sends what you type through to the agent", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await page.locator(KEYBOARD).press("h");
  await page.locator(KEYBOARD).press("i");

  await expect.poll(() => typed(page)).toBe("hi");
});

// Ctrl+C belongs to the agent. The app claims Cmd chords and nothing else.
test("passes Ctrl+C through rather than claiming it", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await page.locator(KEYBOARD).press("Control+c");

  await expect.poll(() => typed(page)).toContain("\u0003");
});

test("resizes the pty when the window changes the column count", async ({ page }) => {
  await page.getByTestId("start-agent").click();
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
  await page.getByTestId("start-agent").click();
  await page.evaluate(() => window.__fake.end(0, true));

  await expect(page.getByTestId("agent-status")).toContainText("The agent exited.");
  await expect(page.getByTestId("start-agent")).toHaveText("Restart");
});

// Never respawn on its own: a broken install would otherwise become a loop
// that burns CPU and hides the actual error.
test("names the exit code on a crash and waits to be asked", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await page.evaluate(() => window.__fake.end(127, false));

  await expect(page.getByTestId("agent-status")).toContainText("code 127");
  await expect(page.getByTestId("start-agent")).toHaveText("Restart");

  await page.waitForTimeout(500);
  expect(await spawnCount(page)).toBe(1);
});

test("reports a kill without inventing an exit code", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await page.evaluate(() => window.__fake.end(null, false));

  await expect(page.getByTestId("agent-status")).toContainText("The agent was stopped.");
});

test("keeps the crashed session's output on screen to be read", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await page.evaluate(() => {
    window.__fake.emit("panicked at src/main.rs");
    window.__fake.end(101, false);
  });

  await expect(page.getByTestId("agent-status")).toContainText("code 101");
  await expect.poll(() => buffer(page)).toContain("panicked at");
});

test("restarting clears the previous session's output", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await page.evaluate(() => {
    window.__fake.emit("first run");
    window.__fake.end(0, true);
  });
  await expect.poll(() => buffer(page)).toContain("first run");

  await page.getByTestId("start-agent").click();
  await expect(page.locator(AGENT)).toContainText("running");
  await expect.poll(() => buffer(page)).not.toContain("first run");
  expect(await spawnCount(page)).toBe(2);
});

test("reports a spawn that never got started", async ({ page }) => {
  await page.evaluate(() => {
    window.__fake.failSpawn = "no pty available";
  });
  await page.getByTestId("start-agent").click();

  await expect(page.getByTestId("agent-status")).toContainText("no pty available");
  await expect(page.getByTestId("start-agent")).toHaveText("Restart");
});

// Hidden is not unmounted: the session survives, and no respawn happens.
test("survives being hidden and shown again while reviewing", async ({ page }) => {
  await page.getByTestId("start-agent").click();
  await page.setViewportSize({ width: 720, height: 800 });

  await page.keyboard.press(`${MOD}+d`);
  await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
  await expect(page.locator(AGENT)).toBeHidden();

  await page.keyboard.press(`${MOD}+d`);
  await expect(page.locator(AGENT)).toBeVisible();
  await expect(page.locator(AGENT)).toContainText("running");
  expect(await spawnCount(page)).toBe(1);
});

test("recolours the terminal when the theme changes, without respawning", async ({ page }) => {
  await page.getByTestId("start-agent").click();

  const background = () =>
    page.evaluate(
      () =>
        (window as unknown as { __WORKBENCH_TERMINAL__: any }).__WORKBENCH_TERMINAL__.options.theme
          .background,
    );

  const before = await background();
  await page.keyboard.press(`${MOD}+Shift+T`);
  await page.keyboard.press(`${MOD}+Shift+T`);

  await expect.poll(background).not.toBe(before);
  expect(await spawnCount(page)).toBe(1);
});
