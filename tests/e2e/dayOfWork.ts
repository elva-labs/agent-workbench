import { expect, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore, type GitFixture } from "./fake";
import { longHistory } from "./longHistory";

/**
 * A workspace the size of a day's work, for the measurements run in
 * WebKit: ten projects open, past sessions listed under the first, agents
 * in five of the others with terminals full of coloured output, and two
 * conversations as long as real ones kept for days, the second in front.
 */

export const PROJECTS = [
  PROJECT,
  ...["api", "web", "infra", "docs", "mobile", "billing", "search", "ops", "design"].map((name) => `/home/ada/dev/${name}`),
];
export const LONG = ["past-long-a", "past-long-b"];
export const PAST = 28;
const TERMINALS = 5;

/** A screen of a coding agent's output, coloured in runs as a TUI draws it. */
function output(lines: number, seed: number): string {
  const words = "reading src lib theme svelte paint background css terminal session project build test ok".split(" ");
  const out: string[] = [];
  for (let line = 0; line < lines; line++) {
    let text = "";
    for (let run = 0; run < 6; run++) {
      const colour = 31 + ((line + run + seed) % 7);
      text += `\x1b[${colour}m${words[(line * 7 + run * 3 + seed) % words.length]}\x1b[0m ${words[(line + run) % words.length]} `;
    }
    out.push(text);
  }
  return out.join("\r\n");
}

/** Opens the workspace with the given settings, and with `bare` only the
    projects and their rows: no terminals and no conversations. Every past
    session is listed, not the latest two and a fold counting the rest. */
export async function openDayOfWork(
  page: Page,
  options: { settings: Record<string, unknown>; bare?: boolean; fixture?: GitFixture },
) {
  const { settings, bare = false, fixture } = options;
  const now = Math.floor(Date.now() / 1000);
  const transcripts = [
    ...LONG.map((id, at) => ({ id, modified: now - 60 - at, size: 100, title: `Long conversation ${at + 1}` })),
    ...Array.from({ length: PAST }, (_, at) => ({
      id: `past-${at + 1}`,
      modified: now - 3600 * (at + 2),
      size: 100,
      title: `Earlier work ${at + 1}`,
    })),
  ];
  await installFakeCore(page, { open: PROJECTS, settings, transcripts, fixture });
  await page.addInitScript(
    ({ project, ids }) => localStorage.setItem("workbench.mine", JSON.stringify({ [project]: ids })),
    { project: PROJECT, ids: transcripts.map((transcript) => transcript.id) },
  );
  await page.goto("/");
  await expect(page.locator("section[data-pane='agent']")).toBeVisible();
  await expect(page.getByTestId("past-session").first()).toBeVisible();
  if (!bare) await populate(page, settings);
  await page.locator(`[data-row="more:${PROJECT}"]`).click({ timeout: 30_000 });
  await expect(page.getByTestId("past-session")).toHaveCount(PAST + (bare ? LONG.length : 0));
}

async function populate(page: Page, settings: Record<string, unknown>) {
  // Terminals in five of the projects, each full of coloured output.
  const terminals = () =>
    page.evaluate(() => Object.keys((window as unknown as { __WORKBENCH_TERMINALS__?: object }).__WORKBENCH_TERMINALS__ ?? {}).length);
  for (let at = 0; at < TERMINALS; at++) {
    await page.locator(`[data-row="project:${PROJECTS[at + 1]}"]`).getByTestId("project-new-session").click({ timeout: 30_000 });
    await expect.poll(terminals).toBe(at + 1);
  }
  await page.evaluate(
    ({ screens }) => {
      const w = window as unknown as { __spawns: { ptyId: string }[]; __say: (id: string, text: string) => void };
      w.__spawns.forEach((spawn, at) => w.__say(spawn.ptyId, screens[at % screens.length]));
    },
    { screens: [0, 1, 2, 3, 4].map((at) => output(160, at)) },
  );

  // Two conversations as long as real ones kept for days, resumed in the
  // window's own view: sessions of the agent run integrated from here on.
  const start = Date.now() - 4 * 24 * 3_600_000;
  for (const id of LONG) {
    await page.evaluate(`window.__integrated.transcript("${id}", (${longHistory})({ start: ${start} }))`);
  }
  await page.evaluate(
    ({ key, settings }) => {
      const next = { ...JSON.parse(localStorage.getItem(key) ?? "{}"), ...settings, integrated: ["claude-code"] };
      localStorage.setItem(key, JSON.stringify(next));
      (window as unknown as { __settingsChanged: (settings: unknown) => void }).__settingsChanged({
        appearance: "system",
        look: "modern",
        palette: "teal",
        terminalFont: "system",
        interfaceFont: "system",
        keys: {},
        hooks: { everywhere: true, overrides: {} },
        themes: {},
        ...next,
      });
    },
    { key: SETTINGS_FILE, settings },
  );
  // Past sessions are listed under the project on screen alone.
  await page.locator(`[data-row="project:${PROJECT}"] .project-row`).click({ timeout: 30_000 });
  for (const [at, id] of LONG.entries()) {
    await page.locator(`[data-row="past:${id}"]`).click({ timeout: 30_000 });
    await expect(page.locator("[data-testid='conversation']")).toHaveCount(at + 1);
    await expect(page.locator("[data-testid='conversation'].active [data-testid='run-began']")).toBeVisible();
  }
}
