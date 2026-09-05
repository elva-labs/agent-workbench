import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { By, Key, until } from "selenium-webdriver";
import {
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
  writeFileSync(join(repo, "lib.rs"), "fn main() { println!(\"hi\"); }\n");

  app = await launch();
}, 120_000);

afterAll(async () => {
  await app?.stop();
});

describe("the real app", () => {
  it("comes up with three panes filling the window", async () => {
    const { driver } = app;
    await driver.wait(until.elementLocated(By.css("section[data-pane='agent']")), 20_000);
    await driver.manage().window().setRect({ width: 1440, height: 900 });
    await new Promise((r) => setTimeout(r, 500));

    const heights: Record<string, number> = await driver.executeScript(() => {
      const out: Record<string, number> = {};
      for (const pane of document.querySelectorAll<HTMLElement>("section[data-pane]")) {
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
    await driver.findElement(By.css("[data-testid='agent-option'][data-agent='claude-code']")).click();
    await waitForText(driver, "FAKE CLAUDE --session-id");
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
      throw new Error(`${(failure as Error).message}\nThe terminal showed:\n${screen}\nThe sessions pane showed:\n${rows}`);
    }
  });

  // The chord reaches the settings whether the native menu's accelerator
  // takes it or the webview does.
  it("opens the settings on the chord, with the menu in place", async () => {
    const { driver } = app;
    const key = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    await driver.actions().keyDown(key).sendKeys(",").keyUp(key).perform();
    await driver.wait(until.elementLocated(By.css("[data-testid='settings']")), 10_000);
    await driver.findElement(By.css("[data-testid='settings-close']")).click();
    await driver.wait(async () => (await driver.findElements(By.css("[data-testid='settings']"))).length === 0, 5_000);
  });

  // Lines search runs git grep in the real repository.
  it("finds lines inside the files", async () => {
    const { driver } = app;
    await driver.findElement(By.css("[data-testid='mode-lines']")).click();
    const field = await driver.findElement(By.css("[data-testid='search-field']"));
    await field.sendKeys("println");
    await waitForPaneText(driver, "[data-testid='search-results']", "println");
    await waitForPaneText(driver, "[data-testid='search-results']", "lib.rs");
    await driver.findElement(By.css("[data-testid='search-hit']")).click();
    await waitForPaneText(driver, "[data-testid='viewer']", "println");
    await field.clear();
    await driver.findElement(By.css("[data-testid='mode-files']")).click();
    await driver.findElement(By.css("[data-testid='viewer'] .close")).click();
  });

  it("offers codex too, and runs it", async () => {
    const { driver } = app;
    await driver.findElement(By.css("[data-testid='new-session']")).click();
    const options = await driver.findElements(By.css("[data-testid='agent-option']"));
    expect(options).toHaveLength(2);
    await options[1].click();
    await waitForText(driver, "FAKE CODEX");
    const tags = await driver.findElements(By.css("[data-testid='agent-tag']"));
    const texts = await Promise.all(tags.map((tag) => tag.getText()));
    expect(texts).toEqual(["claude", "codex"]);
  });
});
