import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

// Find in an integrated session's conversation, in WebKit as well as
// Chromium: the bar over the thread, the count, the marks painted over the
// text, and the folds and turns find brings into view. The handle of the
// first session the fake starts is int-1.

const H = "int-1";

function agent(page: Page, script: string) {
  return page.evaluate(`(() => { const f = window.__integrated; ${script} })()`);
}

async function openIntegrated(page: Page, settings: Record<string, unknown> = {}) {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"], ...settings } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

/** A turn about a cache: a message, a reply, an edit and a command whose
    output names it, folded into one line, and a last word. */
async function aboutTheCache(page: Page) {
  await page.getByTestId("composer-input").fill("The cache is built again on every start. Keep it between runs.");
  await page.keyboard.press("Enter");
  await agent(
    page,
    `f.startTurn("${H}");
     f.emit("${H}", { type: "text", block: "t-1", parent: null, text: "The **cache** lives only in memory, so a restart throws it away. I'll keep it in the app's data folder, with a version so an old cache is never trusted.", done: true });
     f.tool("${H}", "Edit", { file_path: "${PROJECT}/src/store.rs" }, "", { kind: "edit", changes: [{ path: "${PROJECT}/src/store.rs", kind: "update", to: null, content: null, truncated: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-let kept = None;", "+let kept = read();", "+write(kept);"] }] }] });
     f.tool("${H}", "Bash", { command: "cargo test -p core store" }, "running 2 tests\\ntest store::cache_reads_back_after_restart ... ok\\ntest store::refuses_an_old_version ... ok\\ntest result: ok. 2 passed", { kind: "command" });
     f.emit("${H}", { type: "text", block: "t-2", parent: null, text: "Done. The cache survives a restart, see [the notes](https://example.com/notes).", done: true });
     f.endTurn("${H}");`,
  );
  await expect(page.getByTestId("agent-text").last()).toContainText("survives a restart");
}

const findChord = (page: Page) => page.keyboard.press("ControlOrMeta+f");

/** The text of every match painted, and of the current one. */
const painted = (page: Page) =>
  page.evaluate(() => {
    const read = (name: string) => [...(CSS.highlights.get(name) ?? [])].map((range) => (range as Range).toString());
    return { hits: read("find-hit"), current: read("find-current") };
  });

/** Whether the current match is drawn inside the thread's view. */
const currentInView = (page: Page) =>
  page.evaluate(() => {
    const [range] = [...(CSS.highlights.get("find-current") ?? [])] as Range[];
    if (range === undefined) return false;
    const box = range.getBoundingClientRect();
    const view = document.querySelector("[data-testid='thread']")!.getBoundingClientRect();
    return box.height > 0 && box.top >= view.top && box.bottom <= view.bottom;
  });

test.describe("find in the conversation", () => {
  test("opens over the thread on the chord, counts and marks every match, and steps round them", async ({ page }) => {
    await openIntegrated(page);
    await aboutTheCache(page);
    const composer = page.getByTestId("composer-input");
    await composer.focus();
    await findChord(page);
    const bar = page.getByTestId("find-bar");
    const input = page.getByTestId("find-input");
    await expect(bar).toBeVisible();
    await expect(input).toBeFocused();
    // Over the top of the thread, at its right.
    const thread = (await page.getByTestId("thread").boundingBox())!;
    const box = (await bar.boundingBox())!;
    expect(box.y).toBeLessThan(thread.y + 20);
    expect(box.x + box.width).toBeGreaterThan(thread.x + thread.width - 40);

    await input.pressSequentially("cache");
    // The message, the reply twice, the command's output and the last word.
    await expect(page.getByTestId("find-count")).toHaveText("1 of 5");
    await expect.poll(async () => (await painted(page)).current).toEqual(["cache"]);
    // Only what is drawn is painted: the output is folded away.
    expect((await painted(page)).hits).toEqual(["cache", "cache", "cache"]);

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("2 of 5");
    await page.keyboard.press("Shift+Enter");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 5");
    await page.keyboard.press("Shift+Enter");
    // Back past the first is the last.
    await expect(page.getByTestId("find-count")).toHaveText("5 of 5");
    await page.keyboard.press("ControlOrMeta+g");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 5");
    await page.keyboard.press("ControlOrMeta+Shift+g");
    await expect(page.getByTestId("find-count")).toHaveText("5 of 5");
    await page.getByTestId("find-next").click();
    await expect(page.getByTestId("find-count")).toHaveText("1 of 5");
    await page.getByTestId("find-previous").click();
    await expect(page.getByTestId("find-count")).toHaveText("5 of 5");
    // The arrows leave the keyboard in the field.
    await expect(input).toBeFocused();

    // The chord again selects the words.
    await composer.focus();
    await findChord(page);
    await expect(input).toBeFocused();
    expect(await input.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, 5]);

    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    // The keyboard goes back to where it was, and the marks go.
    await expect(composer).toBeFocused();
    expect(await painted(page)).toEqual({ hits: [], current: [] });
  });

  test("says when nothing matches, and minds case only when the words hold a capital", async ({ page }) => {
    await openIntegrated(page);
    await aboutTheCache(page);
    await page.getByTestId("composer-input").focus();
    await findChord(page);
    const input = page.getByTestId("find-input");
    await input.fill("keychain");
    await expect(page.getByTestId("find-count")).toHaveText("No matches");
    await expect(page.getByTestId("find-previous")).toBeDisabled();
    await expect(page.getByTestId("find-next")).toBeDisabled();
    await input.fill("CACHE");
    await expect(page.getByTestId("find-count")).toHaveText("No matches");
    await input.fill("The cache");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    // Markdown is matched as it reads, not as it is written.
    await input.fill("**cache**");
    await expect(page.getByTestId("find-count")).toHaveText("No matches");
    await input.fill("the cache lives");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
    await expect.poll(async () => (await painted(page)).current).toEqual(["The cache lives"]);
  });

  test("opens the fold and the step that hold a match, and closes them again when find moves on or closes", async ({ page }) => {
    await openIntegrated(page);
    await aboutTheCache(page);
    await page.getByTestId("composer-input").focus();
    await findChord(page);
    await page.getByTestId("find-input").fill("cache");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 5");
    const line = page.getByTestId("work-line");
    await expect(line).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    // The fourth is in the command's output, inside the folded work.
    await expect(page.getByTestId("find-count")).toHaveText("4 of 5");
    await expect(line).toHaveAttribute("aria-expanded", "true");
    const ran = page.getByTestId("step-row").filter({ hasText: "Ran" });
    await expect(ran).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("step-output")).toBeVisible();
    await expect.poll(async () => (await painted(page)).current).toEqual(["cache"]);
    expect(
      await page.evaluate(() => {
        const [range] = [...CSS.highlights.get("find-current")!] as Range[];
        return range.startContainer.parentElement!.closest("[data-testid='step-output']") !== null;
      }),
    ).toBe(true);
    await expect.poll(() => currentInView(page)).toBe(true);
    // Moving on closes what find opened.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("5 of 5");
    await expect(line).toHaveAttribute("aria-expanded", "false");
    // Back on it opens them again, and closing the bar closes them.
    await page.keyboard.press("Shift+Enter");
    await expect(line).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(line).toHaveAttribute("aria-expanded", "false");

    // A fold the user opened stays open.
    await line.click();
    await expect(line).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId("composer-input").focus();
    await findChord(page);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText(/of 5/);
    await page.getByTestId("find-close").click();
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(line).toHaveAttribute("aria-expanded", "true");
  });

  test("keeps its count right while a reply streams, the current match where it was", async ({ page }) => {
    await openIntegrated(page);
    await aboutTheCache(page);
    await page.getByTestId("composer-input").focus();
    await findChord(page);
    await page.getByTestId("find-input").fill("cache");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("2 of 5");
    await agent(
      page,
      `f.send("${H}", crypto.randomUUID(), "And the cache's size?");
       f.startTurn("${H}");
       f.emit("${H}", { type: "text", block: "s-1", parent: null, text: "The cache", done: false });`,
    );
    await expect(page.getByTestId("find-count")).toHaveText("2 of 7");
    await agent(page, `f.emit("${H}", { type: "text", block: "s-1", parent: null, text: " stays small: each cache entry is a path.", done: false });`);
    await expect(page.getByTestId("find-count")).toHaveText("2 of 8");
    await expect(page.getByTestId("find-heard")).toHaveText("2 of 8");
  });

  test("leaves selecting, copying and links as they are", async ({ page }) => {
    await openIntegrated(page);
    await aboutTheCache(page);
    const reply = page.getByTestId("agent-text").last();
    const before = await reply.innerHTML();
    await page.getByTestId("composer-input").focus();
    await findChord(page);
    await page.getByTestId("find-input").fill("cache");
    await expect.poll(async () => (await painted(page)).hits.length).toBeGreaterThan(0);
    // Nothing is put in the page to mark a match.
    expect(await reply.innerHTML()).toBe(before);
    await reply.evaluate((node) => document.getSelection()!.selectAllChildren(node));
    expect(await page.evaluate(() => document.getSelection()!.toString())).toContain("The cache survives a restart");
    await expect(reply.locator("a[href='https://example.com/notes']")).toHaveText("the notes");
    await reply.hover();
    await page.getByTestId("agent-run").getByTestId("copy-reply").click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? []))
      .toEqual([
        "The **cache** lives only in memory, so a restart throws it away. I'll keep it in the app's data folder, with a version so an old cache is never trusted.\n\nDone. The cache survives a restart, see [the notes](https://example.com/notes).",
      ]);
  });

  test("is walked by Tab, field, arrows and close, then the thread", async ({ page }) => {
    await openIntegrated(page);
    await aboutTheCache(page);
    await page.getByTestId("composer-input").focus();
    await findChord(page);
    await page.getByTestId("find-input").fill("cache");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 5");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("find-previous")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("find-next")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("2 of 5");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("find-close")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("thread")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("find-close")).toBeFocused();
    // With nothing found the arrows are passed over.
    await page.getByTestId("find-input").fill("keychain");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("find-close")).toBeFocused();
  });

  test("leaves the chord to a terminal session", async ({ page }) => {
    await installFakeCore(page, { open: [PROJECT] });
    await page.goto("/");
    await page.getByTestId("start-agent").click();
    await expect(page.locator("section[data-pane='agent'] .xterm")).toBeVisible();
    await page.locator("section[data-pane='agent'] .xterm textarea").focus();
    await findChord(page);
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    // Nor did it go to the files' filter.
    await expect(page.locator("section[data-pane='agent'] .xterm textarea")).toBeFocused();
  });

  test("glides to a near match, and is there at once where the system asks for less motion", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 600 });
    await openIntegrated(page);
    // A long turn before, so the thread has room to scroll.
    await agent(page, `f.send("${H}", crypto.randomUUID(), "Start"); f.turn("${H}", ${JSON.stringify(Array.from({ length: 12 }, (_, at) => `Paragraph ${at} of what came first.`).join("\n\n"))});`);
    await aboutTheCache(page);
    await page.getByTestId("composer-input").focus();
    await findChord(page);
    await page.getByTestId("find-input").fill("cache");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 5");
    const thread = page.getByTestId("thread");
    await thread.evaluate((node) =>
      node.addEventListener("scroll", () => (node.dataset.scrolls = String(Number(node.dataset.scrolls ?? 0) + 1))),
    );
    /** Waits until the thread has not moved for a few frames. */
    const still = () =>
      thread.evaluate(
        (node) =>
          new Promise<void>((resolve) => {
            let last = node.scrollTop;
            let same = 0;
            const check = () => {
              same = node.scrollTop === last ? same + 1 : 0;
              last = node.scrollTop;
              if (same >= 5) resolve();
              else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          }),
      );
    /** Puts the last reply most of a screen under the middle of the view,
        and counts the scrolls from there. */
    const ready = async () => {
      await still();
      const top = await thread.evaluate((node) => {
        const text = [...node.querySelectorAll("[data-testid='agent-text']")].pop()!;
        const top = text.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
        node.scrollTop = top - node.clientHeight * 1.1;
        return node.scrollTop;
      });
      await still();
      await thread.evaluate((node) => (node.dataset.scrolls = "0"));
      return top;
    };
    const scrolls = () => thread.evaluate((node) => Number(node.dataset.scrolls));
    // Back past the first is the last, in the last reply.
    expect(await ready()).toBeGreaterThan(0);
    await page.keyboard.press("Shift+Enter");
    await expect(page.getByTestId("find-count")).toHaveText("5 of 5");
    await expect.poll(() => currentInView(page)).toBe(true);
    await still();
    expect(await scrolls()).toBeGreaterThan(2);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 5");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await ready()).toBeGreaterThan(0);
    await page.keyboard.press("Shift+Enter");
    await expect(page.getByTestId("find-count")).toHaveText("5 of 5");
    await expect.poll(() => currentInView(page)).toBe(true);
    await still();
    expect(await scrolls()).toBe(1);
  });
});

test.describe("find in a long conversation", () => {
  const PAST = "past-long";
  const TURNS = 300;

  /** A past conversation of `TURNS` turns; one early turn's command output
      holds the only "needle", and one early reply the only "haystack". */
  const long = (start: number) => {
    const items: unknown[] = [];
    let at = start;
    for (let turn = 1; turn <= TURNS; turn++) {
      const message = `m-${turn}`;
      items.push({ at, event: { type: "message", message, state: "sent", error: null, text: `Question ${turn}`, images: [] } });
      items.push({ at, event: { type: "turnStarted", messages: [message] } });
      const call = `c-${turn}`;
      items.push({ at, event: { type: "toolStarted", call, parent: null, name: "Bash", kind: "command" } });
      items.push({ at, event: { type: "toolInput", call, parent: null, delta: null, input: { command: `ls part-${turn}` }, truncated: false } });
      const output = turn === 4 ? "a.ts\nthe needle.ts\nb.ts" : "a.ts\nb.ts";
      items.push({ at, event: { type: "toolFinished", call, parent: null, output, error: false, truncated: false, changes: [] } });
      const text = turn === 6 ? `Reply ${turn}, a haystack.` : `Reply ${turn}.`;
      items.push({ at, event: { type: "text", block: `b-${turn}`, parent: null, text, done: true } });
      items.push({ at, event: { type: "turnEnded", outcome: "done", error: null, totalCostUsd: null, durationMs: 1000, usage: null } });
      at += 60_000;
    }
    return items;
  };

  async function openLong(page: Page) {
    const now = Date.now();
    await installFakeCore(page, {
      open: [PROJECT],
      settings: { integrated: ["claude-code"] },
      transcripts: [{ id: PAST, modified: Math.floor(now / 1000) - 60, size: 100, title: "Question 1" }],
    });
    await page.addInitScript(
      ({ project, past }) => localStorage.setItem("workbench.mine", JSON.stringify({ [project]: [past] })),
      { project: PROJECT, past: PAST },
    );
    await page.goto("/");
    await agent(page, `f.transcript("${PAST}", ${JSON.stringify(long(now - TURNS * 60_000 - 3_600_000))});`);
    await page.getByTestId("past-session").click();
    await expect(page.getByTestId("agent-text").last()).toContainText(`Reply ${TURNS}.`);
  }

  test("finds a match in a turn not drawn, and inside its fold, and brings it into view", async ({ page }) => {
    await openLong(page);
    await expect(page.getByText("Reply 6, a haystack.")).toHaveCount(0);
    await page.getByTestId("composer-input").focus();
    await findChord(page);
    await page.getByTestId("find-input").fill("haystack");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
    await expect(page.getByText("Reply 6, a haystack.")).toBeInViewport();
    await expect.poll(() => currentInView(page)).toBe(true);
    // Only the turns near it are drawn.
    expect(await page.getByTestId("agent-run").count()).toBeLessThan(40);

    await page.getByTestId("find-input").fill("needle");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
    const output = page.getByTestId("step-output").filter({ hasText: "the needle.ts" });
    await expect(output).toBeInViewport();
    await expect.poll(async () => (await painted(page)).current).toEqual(["needle"]);
    await expect.poll(() => currentInView(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("step-output")).toHaveCount(0);
    // The thread stays where find left it, far from its foot.
    expect(await page.getByTestId("thread").evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeGreaterThan(5000);
    await expect(page.getByTestId("jump-latest")).toHaveCount(0);
  });

  test("counts every turn, drawn or not, and steps from the last to the first", async ({ page }) => {
    await openLong(page);
    await page.getByTestId("composer-input").focus();
    await findChord(page);
    await page.getByTestId("find-input").fill("question 29");
    // Question 29, and 290 to 299.
    await expect(page.getByTestId("find-count")).toHaveText(/ of 11$/);
    await page.getByTestId("find-input").fill("reply");
    await expect(page.getByTestId("find-count")).toHaveText(new RegExp(` of ${TURNS}$`));
    // From the foot of the view, the first match is near the last; from
    // the last, the next is the first, three hundred turns up.
    const count = page.getByTestId("find-count");
    for (;;) {
      const now = await count.textContent();
      if (now === `${TURNS} of ${TURNS}`) break;
      await page.keyboard.press("Enter");
      await expect(count).not.toHaveText(now!);
    }
    await page.keyboard.press("Enter");
    await expect(count).toHaveText(`1 of ${TURNS}`);
    await expect(page.getByText("Reply 1.", { exact: true })).toBeInViewport();
  });
});
