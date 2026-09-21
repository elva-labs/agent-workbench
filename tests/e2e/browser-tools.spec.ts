import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * The tools an agent drives the embedded browser with.
 *
 * The core carries a call on one of the browser's tools to the window as a
 * request; the window performs it against the browser store and answers.
 * Here the request is pushed straight at the handler the app registered,
 * and the answers are read back off the fake, the same way conduct.spec.ts
 * drives the conductor's tools.
 */

const CHANGES = "section[data-pane='changes']";

interface Answer {
  id: string;
  content: string | null;
  error: string | null;
}

/** A call as the core delivers one. */
async function push(
  page: Page,
  request: {
    id: string;
    tool: string;
    arguments?: Record<string, unknown>;
    session?: string | null;
  },
) {
  await page.evaluate(
    ({ project, request }) =>
      (
        window as unknown as { __browserRequest: (call: unknown) => void }
      ).__browserRequest({
        id: request.id,
        tool: request.tool,
        arguments: request.arguments ?? {},
        cwd: project,
        session: request.session ?? null,
      }),
    { project: PROJECT, request },
  );
}

const answers = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __browserAnswers?: Answer[] }).__browserAnswers ??
      [],
  );

const answerTo = async (page: Page, id: string) =>
  (await answers(page)).find((answer) => answer.id === id) ?? null;

test.describe("the browser's tools", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeCore(page);
    await page.goto("/");
    await expect(page.locator(CHANGES)).toBeVisible();
  });

  test("browser_open opens a tab, shows it, and answers with its id and url", async ({ page }) => {
    await push(page, {
      id: "b-1",
      tool: "browser_open",
      arguments: { url: "https://example.com" },
      session: "session-1",
    });

    await expect(page.getByTestId("mode-readout")).toHaveText("reviewing");
    await expect(page.getByTestId("browser-tab")).toHaveCount(1);
    await expect.poll(() => answerTo(page, "b-1")).not.toBeNull();
    const answer = (await answerTo(page, "b-1"))!;
    expect(answer.error).toBeNull();
    expect(answer.content).toContain("Opened tab 1");
    expect(answer.content).toContain("example.com");
  });

  test("browser_open with no url is refused", async ({ page }) => {
    await push(page, { id: "b-2", tool: "browser_open", arguments: {} });
    await expect.poll(() => answerTo(page, "b-2")).not.toBeNull();
    const answer = (await answerTo(page, "b-2"))!;
    expect(answer.content).toBeNull();
    expect(answer.error).toContain("needs a url");
  });

  test("browser_tabs lists the open tabs, and browser_close removes one", async ({ page }) => {
    await push(page, { id: "b-3", tool: "browser_open", arguments: { url: "https://a.example" } });
    await expect.poll(() => answerTo(page, "b-3")).not.toBeNull();

    await push(page, { id: "b-4", tool: "browser_tabs" });
    await expect.poll(() => answerTo(page, "b-4")).not.toBeNull();
    const listed = (await answerTo(page, "b-4"))!;
    expect(listed.content).toContain("a.example");
    expect(listed.content).toContain("active");

    await push(page, { id: "b-5", tool: "browser_close", arguments: { tab: 1 } });
    await expect.poll(() => answerTo(page, "b-5")).not.toBeNull();
    const closed = (await answerTo(page, "b-5"))!;
    expect(closed.error).toBeNull();
    await expect(page.getByTestId("browser-tab")).toHaveCount(0);
  });

  test("browser_navigate sends the tab to a new address", async ({ page }) => {
    await push(page, { id: "b-6", tool: "browser_open", arguments: { url: "https://a.example" } });
    await expect.poll(() => answerTo(page, "b-6")).not.toBeNull();

    await push(page, {
      id: "b-7",
      tool: "browser_navigate",
      arguments: { url: "https://b.example" },
    });
    await expect.poll(() => answerTo(page, "b-7")).not.toBeNull();
    expect((await answerTo(page, "b-7"))!.error).toBeNull();
    await expect(page.getByTestId("browser-tab-select")).toContainText("b.example");
  });

  test("browser_navigate with an unknown action is refused", async ({ page }) => {
    await push(page, { id: "b-8", tool: "browser_open", arguments: { url: "https://a.example" } });
    await expect.poll(() => answerTo(page, "b-8")).not.toBeNull();

    await push(page, { id: "b-9", tool: "browser_navigate", arguments: {} });
    await expect.poll(() => answerTo(page, "b-9")).not.toBeNull();
    expect((await answerTo(page, "b-9"))!.error).toContain("a url, or an action");
  });

  test("browser_snapshot, browser_click and browser_type use the ref the snapshot gave", async ({
    page,
  }) => {
    await push(page, { id: "b-10", tool: "browser_open", arguments: { url: "https://a.example" } });
    await expect.poll(() => answerTo(page, "b-10")).not.toBeNull();

    await push(page, { id: "b-11", tool: "browser_snapshot" });
    await expect.poll(() => answerTo(page, "b-11")).not.toBeNull();
    const snapshot = (await answerTo(page, "b-11"))!;
    expect(snapshot.content).toContain("ref=e1");

    await push(page, { id: "b-12", tool: "browser_click", arguments: { ref: "e1" } });
    await expect.poll(() => answerTo(page, "b-12")).not.toBeNull();
    expect((await answerTo(page, "b-12"))!.error).toBeNull();

    await push(page, {
      id: "b-13",
      tool: "browser_type",
      arguments: { ref: "e1", text: "hello", submit: true },
    });
    await expect.poll(() => answerTo(page, "b-13")).not.toBeNull();
    expect((await answerTo(page, "b-13"))!.error).toBeNull();

    // A stale ref, the snapshot did not give, is refused rather than acted on.
    await push(page, { id: "b-14", tool: "browser_click", arguments: { ref: "gone" } });
    await expect.poll(() => answerTo(page, "b-14")).not.toBeNull();
    expect((await answerTo(page, "b-14"))!.error).toContain("no such element");
  });

  test("browser_console answers with the tab's messages", async ({ page }) => {
    await push(page, { id: "b-15", tool: "browser_open", arguments: { url: "https://a.example" } });
    await expect.poll(() => answerTo(page, "b-15")).not.toBeNull();

    await push(page, { id: "b-16", tool: "browser_console" });
    await expect.poll(() => answerTo(page, "b-16")).not.toBeNull();
    expect((await answerTo(page, "b-16"))!.content).toContain("a.example");
  });

  test("browser_screenshot answers with the file it was written to", async ({ page }) => {
    await push(page, { id: "b-17", tool: "browser_open", arguments: { url: "https://a.example" } });
    await expect.poll(() => answerTo(page, "b-17")).not.toBeNull();

    await push(page, { id: "b-18", tool: "browser_screenshot" });
    await expect.poll(() => answerTo(page, "b-18")).not.toBeNull();
    const shot = (await answerTo(page, "b-18"))!;
    expect(shot.error).toBeNull();
    expect(shot.content).toContain(".png");
  });

  test("browser_eval answers with the script's JSON result", async ({ page }) => {
    await push(page, { id: "b-19", tool: "browser_open", arguments: { url: "https://a.example" } });
    await expect.poll(() => answerTo(page, "b-19")).not.toBeNull();

    await push(page, {
      id: "b-20",
      tool: "browser_eval",
      arguments: { script: "return document.title" },
    });
    await expect.poll(() => answerTo(page, "b-20")).not.toBeNull();
    const ran = (await answerTo(page, "b-20"))!;
    expect(ran.error).toBeNull();
    expect(ran.content).toContain("a.example");
  });

  test("a call naming a tab that is not open is refused", async ({ page }) => {
    await push(page, { id: "b-21", tool: "browser_close", arguments: { tab: 42 } });
    await expect.poll(() => answerTo(page, "b-21")).not.toBeNull();
    expect((await answerTo(page, "b-21"))!.error).toContain("no tab 42");
  });

  test("a call delivered twice is answered once", async ({ page }) => {
    const request = { id: "b-22", tool: "browser_tabs" };
    await push(page, request);
    await push(page, request);
    await expect.poll(() => answerTo(page, "b-22")).not.toBeNull();
    const all = await answers(page);
    expect(all.filter((answer) => answer.id === "b-22")).toHaveLength(1);
  });
});
