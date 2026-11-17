import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { conductor, resetConductor } from "$lib/conductor.svelte";
import { dockedFor, roundDockedIn } from "$lib/docked.svelte";
import { handleOf, launch, listenIntegrated, resetIntegrated } from "$lib/integrated.svelte";
import { byKey, create, reset as resetSessions, sessions, started, type Session } from "$lib/sessions.svelte";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { resetSenders } from "$lib/senders.svelte";
import { fakeIntegrated, type FakeIntegrated } from "../fakeIntegrated";
import Dock from "$lib/components/conversation/Dock.svelte";

// What an integrated session's dock holds: its own requests, then those of
// the sessions it started, each answered in the session it belongs to.

const A = "/home/ada/dev/one";

let fake: FakeIntegrated;
let stop = () => {};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An integrated session, up and running. */
async function integrated(title: string): Promise<Session> {
  const row = create(A, null, "claude-code", null, null, null, null, undefined, "integrated");
  await launch(row.key);
  const session = byKey(row.key)!;
  session.title = title;
  return session;
}

/** An integrated session the starter started, up and running. */
async function startedBy(starter: Session, title: string, step: string | null = null): Promise<Session> {
  const row = create(A, null, "claude-code", null, null, null, null, undefined, "integrated");
  conductor.startedBy[row.key] = starter.token;
  if (step !== null) conductor.places[row.key] = { step, kind: "work", piece: null, round: null, work: null };
  await launch(row.key);
  const session = byKey(row.key)!;
  session.title = title;
  return session;
}

/** A terminal session the starter started, running. */
function terminalBy(starter: Session, title: string): Session {
  const row = create(A, null, "claude-code", null, null, null, null, undefined, "terminal");
  conductor.startedBy[row.key] = starter.token;
  started(row.key, `pty-${title}`, `id-${title}`);
  const session = byKey(row.key)!;
  session.title = title;
  return session;
}

const answers = () => fake.calls.filter((call) => call.method === "answer");

beforeEach(async () => {
  resetSessions();
  resetIntegrated();
  resetConductor();
  resetWorkspace();
  resetAgent();
  localStorage.clear();
  resetSenders();
  applyDetect(
    { id: "claude-code", path: "/usr/local/bin/claude", caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
    true,
  );
  workspace.open.push({ path: A, name: "one", repository: A, isGit: true });
  fake = fakeIntegrated();
  (window as unknown as { __WORKBENCH_CORE__: unknown }).__WORKBENCH_CORE__ = {
    integratedStart: async (options: Parameters<FakeIntegrated["start"]>[0]) => fake.start(options),
    integratedSend: async (id: string, message: string, text: string) => fake.send(id, message, text),
    integratedAnswer: async (id: string, request: string, choice: never, message?: string) =>
      fake.answer(id, request, choice, message),
    integratedReply: async (id: string, request: string, given: string[][] | null) => fake.reply(id, request, given),
    integratedStop: async (id: string) => fake.stop(id),
    onIntegratedEvent: async (handler: Parameters<FakeIntegrated["subscribe"]>[0]) => fake.subscribe(handler),
    projectInfo: async (path: string) => ({ path, name: "one", repository: path, isGit: true }),
    transcriptsMany: async (projects: string[]) => projects.map(() => []),
    kill: async () => {},
    setWindowTitle: async () => {},
  };
  stop = await listenIntegrated();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  delete (window as unknown as { __WORKBENCH_CORE__?: unknown }).__WORKBENCH_CORE__;
});

describe("what a session's dock holds", () => {
  it("takes its own requests first, then its started sessions' in the order they asked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    // The conversations' clock and the rows' are the one the test moves.
    resetIntegrated(() => Date.now());
    stop();
    stop = await listenIntegrated();
    const starter = await integrated("Fix the slow startup");
    const cache = await startedBy(starter, "Fix the cache", "Work");
    const links = terminalBy(starter, "Fix the links");
    const later = await startedBy(starter, "Palette filter");
    const first = fake.ask(handleOf(cache.key)!, "Bash", { command: "cargo test" });
    vi.setSystemTime(2_000);
    links.needs = "permission";
    links.changedAt = Date.now();
    vi.setSystemTime(3_000);
    const third = fake.ask(handleOf(later.key)!, "Bash", { command: "ls" });
    vi.setSystemTime(4_000);
    const own = fake.ask(handleOf(starter.key)!, "Edit", { file_path: `${A}/a.ts` });
    expect(dockedFor(starter.key).map((entry) => [entry.kind, entry.key, entry.own])).toEqual([
      ["request", starter.key, true],
      ["request", cache.key, false],
      ["terminal", links.key, false],
      ["request", later.key, false],
    ]);
    const requests = dockedFor(starter.key).flatMap((entry) => (entry.kind === "request" ? [entry.request.request] : []));
    expect(requests).toEqual([own, first, third]);
  });

  it("holds nothing of a session it did not start, nor of one another session started", async () => {
    const starter = await integrated("Fix the slow startup");
    const other = await integrated("Someone else");
    const theirs = await startedBy(other, "Not mine");
    const alone = await integrated("On its own");
    fake.ask(handleOf(theirs.key)!, "Bash", { command: "ls" });
    fake.ask(handleOf(alone.key)!, "Bash", { command: "ls" });
    expect(dockedFor(starter.key)).toEqual([]);
    expect(dockedFor(other.key).map((entry) => entry.key)).toEqual([theirs.key]);
  });

  it("holds a terminal session's ask only while it asks, and none for a terminal starter", async () => {
    const starter = await integrated("Fix the slow startup");
    const links = terminalBy(starter, "Fix the links");
    expect(dockedFor(starter.key)).toEqual([]);
    links.needs = "permission";
    expect(dockedFor(starter.key).map((entry) => entry.kind)).toEqual(["terminal"]);
    links.needs = null;
    expect(dockedFor(starter.key)).toEqual([]);
    const terminal = terminalBy(starter, "A terminal starter");
    terminalBy(terminal, "Its child").needs = "permission";
    expect(dockedFor(terminal.key)).toEqual([]);
  });

  it("lets a request go the moment it is answered or withdrawn, wherever that was", async () => {
    const starter = await integrated("Fix the slow startup");
    const cache = await startedBy(starter, "Fix the cache");
    const handle = handleOf(cache.key)!;
    const one = fake.ask(handle, "Bash", { command: "ls" });
    const two = fake.ask(handle, "Bash", { command: "pwd" });
    expect(dockedFor(starter.key)).toHaveLength(2);
    expect(dockedFor(cache.key)).toHaveLength(2);
    // Answered in the started session's own dock.
    fake.answer(handle, one, "allow");
    expect(dockedFor(starter.key).map((entry) => entry.kind === "request" && entry.request.request)).toEqual([two]);
    fake.expire(handle, two);
    expect(dockedFor(starter.key)).toEqual([]);
    expect(dockedFor(cache.key)).toEqual([]);
  });

  it("docks a round past the limit in its session only while that session is on screen", async () => {
    const starter = await integrated("Fix the slow startup");
    sessions.active = null;
    conductor.asking = {
      request: { id: "c-9", tool: "start", arguments: {}, cwd: A, session: starter.token, caller: starter.token },
      caller: "Fix the slow startup",
      outside: null,
      project: "one",
      prompt: "Look once more",
      worktree: false,
      round: { step: "Review", work: "w", piece: "w", name: "Fix the cache", done: 4, limit: 3 },
      login: null,
      named: null,
      once: false,
    };
    expect(roundDockedIn()).toBeNull();
    expect(dockedFor(starter.key)).toEqual([]);
    sessions.active = starter.key;
    expect(roundDockedIn()).toBe(starter.key);
    expect(dockedFor(starter.key).map((entry) => entry.kind)).toEqual(["round"]);
    // A consent question is never docked.
    conductor.asking = { ...conductor.asking!, round: null };
    expect(roundDockedIn()).toBeNull();
  });
});

describe("the dock of a session that started others", () => {
  async function setup() {
    const starter = await integrated("Fix the slow startup");
    const cache = await startedBy(starter, "Fix the cache", "Work");
    sessions.active = starter.key;
    render(Dock, { sessionKey: starter.key, agent: "Claude", active: true });
    return { starter, cache };
  }

  /** A command the agent asks to run, as a call known to be one. */
  function command(handle: string, line: string, options: Parameters<FakeIntegrated["ask"]>[3] = {}): string {
    const call = fake.startTool(handle, "Bash", { command: line }, { kind: "command" });
    return fake.ask(handle, "Bash", { command: line }, { ...options, call });
  }

  /** What the dock's line says, its step tag apart. */
  const line = (testid: string) => {
    const said = screen.getByTestId(testid).querySelector(".what p")!;
    const step = said.querySelector(".steptag")?.textContent ?? null;
    const rest = [...said.childNodes]
      .filter((node) => !(node instanceof HTMLElement && node.classList.contains("steptag")))
      .map((node) => node.textContent)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    return { step, rest };
  };

  it("names the asking session and its step, says the choice acts there, and answers its own request", async () => {
    const { cache } = await setup();
    const handle = handleOf(cache.key)!;
    fake.startTurn(handle);
    const asked = command(handle, "cargo test --workspace", {
      session: "Bash(cargo test:*) for the rest of this session",
    });
    flushSync();
    expect(line("permission-dock")).toEqual({ step: "Work", rest: "Fix the cache asks to run cargo test --workspace" });
    expect(screen.getByTestId("choice-means").textContent?.trim()).toBe(
      "Allows this call in Fix the cache and remembers nothing.",
    );
    await fireEvent.pointerEnter(screen.getByTestId("choice-allowSession"));
    expect(screen.getByTestId("choice-means").textContent?.trim()).toBe(
      "Allows this call in Fix the cache and remembers Bash(cargo test:*) for the rest of that session.",
    );
    await fireEvent.pointerEnter(screen.getByTestId("choice-cancel"));
    expect(screen.getByTestId("choice-means").textContent?.trim()).toBe("Refuses this call and stops Fix the cache's turn.");
    expect(screen.getByTestId("dock-open")).toHaveTextContent("Open");
    await fireEvent.click(screen.getByTestId("choice-allow"));
    await settle();
    expect(answers()).toEqual([
      { method: "answer", id: handleOf(cache.key), request: asked, choice: "allow", message: null },
    ]);
    flushSync();
    expect(screen.queryByTestId("permission-dock")).toBeNull();
  });

  it("names a subagent inside the started session by both", async () => {
    const { cache } = await setup();
    const handle = handleOf(cache.key)!;
    fake.startTurn(handle);
    const task = fake.startTool(handle, "Task", { description: "Check every link", prompt: "go" }, { kind: "agent" });
    fake.emit(handle, {
      type: "permissionAsked",
      request: "sub-1",
      call: null,
      parent: task,
      tool: "Bash",
      input: { command: "lychee docs/" },
      truncated: false,
      description: null,
      path: null,
      choices: [{ choice: "allow", remembers: null, message: false }],
    });
    flushSync();
    expect(line("permission-dock")).toEqual({
      step: "Work",
      rest: "The subagent for “Check every link” in Fix the cache asks to use Bash to run lychee docs/",
    });
    expect(screen.getByTestId("permission-dock")).toHaveAttribute(
      "aria-label",
      "The subagent for “Check every link” in Fix the cache is waiting for you",
    );
  });

  it("takes its own request first while the user is not at the dock, and says who waits next", async () => {
    const { starter, cache } = await setup();
    fake.startTurn(handleOf(cache.key)!);
    fake.startTurn(handleOf(starter.key)!);
    command(handleOf(cache.key)!, "cargo test");
    flushSync();
    expect(screen.getByTestId("dock-session")).toHaveTextContent("Fix the cache");
    command(handleOf(starter.key)!, "rm -rf build");
    flushSync();
    expect(screen.queryByTestId("dock-session")).toBeNull();
    expect(screen.getByTestId("permission-dock")).toHaveTextContent("Claude asks to run rm -rf build");
    expect(screen.getByTestId("dock-more")).toHaveTextContent("1 more waiting, from Fix the cache");
  });

  it("keeps the request shown while the user is at the dock, whatever arrives", async () => {
    const { starter, cache } = await setup();
    fake.startTurn(handleOf(cache.key)!);
    fake.startTurn(handleOf(starter.key)!);
    const theirs = command(handleOf(cache.key)!, "cargo test");
    flushSync();
    await fireEvent.pointerOver(screen.getByTestId("choice-allow"));
    command(handleOf(starter.key)!, "rm -rf build");
    flushSync();
    expect(screen.getByTestId("dock-session")).toHaveTextContent("Fix the cache");
    expect(screen.getByTestId("dock-more")).toHaveTextContent("1 more waiting, from Claude");
    await fireEvent.click(screen.getByTestId("choice-allow"));
    await settle();
    expect(answers().map((call) => [call.id, (call as { request: string }).request])).toEqual([[handleOf(cache.key), theirs]]);
    flushSync();
    expect(screen.queryByTestId("dock-session")).toBeNull();
    expect(screen.getByTestId("permission-dock")).toHaveTextContent("Claude asks to run rm -rf build");
  });

  it("keeps the request shown while the keyboard is in the dock", async () => {
    const { starter, cache } = await setup();
    fake.startTurn(handleOf(cache.key)!);
    command(handleOf(cache.key)!, "cargo test");
    flushSync();
    screen.getByTestId("choice-allow").focus();
    flushSync();
    fake.startTurn(handleOf(starter.key)!);
    command(handleOf(starter.key)!, "rm -rf build");
    flushSync();
    expect(screen.getByTestId("dock-session")).toHaveTextContent("Fix the cache");
    screen.getByTestId("choice-allow").blur();
    await settle();
    flushSync();
    expect(screen.getByTestId("permission-dock")).toHaveTextContent("Claude asks to run rm -rf build");
  });

  it("takes no answer for a moment from a request that took another's place", async () => {
    const { starter, cache } = await setup();
    const handle = handleOf(cache.key)!;
    const first = fake.ask(handle, "Bash", { command: "ls" });
    flushSync();
    // The user is at the dock, so what arrives waits behind what is shown.
    await fireEvent.pointerOver(screen.getByTestId("choice-allow"));
    // The same id in two sessions, as Codex numbers its requests.
    fake.emit(handleOf(starter.key)!, {
      type: "permissionAsked",
      request: first,
      call: null,
      parent: null,
      tool: "Bash",
      input: { command: "rm -rf /" },
      truncated: false,
      description: null,
      path: null,
      choices: [{ choice: "allow", remembers: null, message: false }, { choice: "deny", remembers: null, message: false }],
    });
    flushSync();
    expect(screen.getByTestId("dock-session")).toHaveTextContent("Fix the cache");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Withdrawn just as the user clicks: the next takes its place.
    fake.expire(handle, first);
    flushSync();
    expect(screen.getByTestId("permission-dock")).toHaveTextContent("Claude asks to use Bash to run rm -rf /");
    expect(screen.getByTestId("choice-allow")).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(screen.getByTestId("choice-allow"));
    await fireEvent.keyDown(screen.getByTestId("choice-allow"), { key: "1" });
    expect(answers()).toEqual([]);
    vi.advanceTimersByTime(500);
    flushSync();
    expect(screen.getByTestId("choice-allow")).not.toHaveAttribute("aria-disabled");
    await fireEvent.click(screen.getByTestId("choice-allow"));
    expect(answers().map((call) => [call.id, (call as { request: string }).request])).toEqual([[handleOf(starter.key), first]]);
  });

  it("cuts a long name everywhere it says it, and counts what it cuts on the line", async () => {
    const { starter, cache } = await setup();
    const long = `Fix the cache ${"x".repeat(4200)}`;
    cache.title = long;
    const left = Array.from(long).length - 160;
    command(handleOf(cache.key)!, "rm -rf ~/.ssh");
    flushSync();
    const dock = screen.getByTestId("permission-dock");
    expect(Array.from(screen.getByTestId("dock-session").textContent!)).toHaveLength(161);
    expect(dock.querySelector(".what [data-testid='permission-cut']")?.textContent?.trim()).toBe(`and ${left} more characters`);
    expect(dock).toHaveTextContent("asks to run rm -rf ~/.ssh");
    expect(screen.getByTestId("choice-means").textContent!.length).toBeLessThan(250);
    expect(dock.getAttribute("aria-label")!.length).toBeLessThan(200);
    expect(screen.getByTestId("choice-allow").getAttribute("title")!.length).toBeLessThan(250);
    // Waiting behind the starter's own, it is named cut in "from".
    command(handleOf(starter.key)!, "ls");
    flushSync();
    expect(screen.getByTestId("dock-more").textContent!.length).toBeLessThan(200);
    expect(screen.getByTestId("dock-more").getAttribute("title")!.length).toBeLessThan(200);
  });

  it("cuts a long name on the way to a terminal session too", async () => {
    const { starter } = await setup();
    const links = terminalBy(starter, `Fix the links ${"y".repeat(4200)}`);
    links.needs = "permission";
    flushSync();
    expect(screen.getByTestId("dock-open-terminal").textContent!.length).toBeLessThan(200);
    expect(screen.getByTestId("terminal-dock").getAttribute("aria-label")!.length).toBeLessThan(250);
  });

  it("takes no answer for a moment from a request that comes just after the dock emptied", async () => {
    const { starter, cache } = await setup();
    const palette = await startedBy(starter, "Palette filter");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    command(handleOf(cache.key)!, "cargo test");
    flushSync();
    await fireEvent.click(screen.getByTestId("choice-allow"));
    flushSync();
    expect(screen.queryByTestId("permission-dock")).toBeNull();
    // The next comes a moment later, its first choice where the last was.
    vi.advanceTimersByTime(100);
    const next = command(handleOf(palette.key)!, "ls");
    flushSync();
    expect(screen.getByTestId("dock-session")).toHaveTextContent("Palette filter");
    expect(screen.getByTestId("choice-allow")).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(screen.getByTestId("choice-allow"));
    expect(answers()).toHaveLength(1);
    vi.advanceTimersByTime(500);
    flushSync();
    await fireEvent.click(screen.getByTestId("choice-allow"));
    expect(answers().at(-1)).toMatchObject({ id: handleOf(palette.key), request: next });
  });

  it("takes an answer at once from a request that comes well after the dock emptied", async () => {
    const { starter, cache } = await setup();
    const palette = await startedBy(starter, "Palette filter");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    command(handleOf(cache.key)!, "cargo test");
    flushSync();
    await fireEvent.click(screen.getByTestId("choice-allow"));
    flushSync();
    vi.advanceTimersByTime(600);
    command(handleOf(palette.key)!, "ls");
    flushSync();
    expect(screen.getByTestId("choice-allow")).not.toHaveAttribute("aria-disabled");
  });

  it("says a rule kept for good is kept in the asking session's folder, for every session there", async () => {
    const { cache } = await setup();
    fake.startTurn(handleOf(cache.key)!);
    command(handleOf(cache.key)!, "cargo test", { always: "Bash(cargo test:*) in this project's uncommitted local settings" });
    flushSync();
    await fireEvent.pointerEnter(screen.getByTestId("choice-allowAlways"));
    expect(screen.getByTestId("choice-means").textContent?.trim()).toBe(
      "Allows this call in Fix the cache and remembers Bash(cargo test:*) in one's uncommitted local settings, for every session in one.",
    );
  });

  it("keeps the keyboard on a request whose answer is on its way", async () => {
    const { cache } = await setup();
    fake.holdAnswers();
    command(handleOf(cache.key)!, "cargo test");
    flushSync();
    const allow = screen.getByTestId("choice-allow");
    allow.focus();
    await fireEvent.keyDown(allow, { key: "1" });
    flushSync();
    // Waiting for the agent: not disabled, so the keyboard stays, and a
    // second press answers nothing.
    expect(allow).toHaveAttribute("aria-disabled", "true");
    expect(allow).not.toHaveAttribute("disabled");
    expect(document.activeElement).toBe(allow);
    await fireEvent.keyDown(allow, { key: "1" });
    expect(answers()).toHaveLength(1);
    fake.releaseAnswers();
    flushSync();
    expect(screen.queryByTestId("permission-dock")).toBeNull();
  });

  it("offers only the way to a started session that runs in a terminal", async () => {
    const { starter } = await setup();
    const links = terminalBy(starter, "Fix the links");
    links.needs = "permission";
    flushSync();
    const dock = screen.getByTestId("terminal-dock");
    expect(line("terminal-dock")).toEqual({ step: null, rest: "Fix the links asks for a permission in its terminal" });
    expect(dock.querySelectorAll("[data-choice]")).toHaveLength(1);
    expect(screen.getByTestId("dock-open-terminal")).toHaveTextContent("Open Fix the links");
    expect(dock).toHaveTextContent("It runs in a terminal, so it is answered there.");
    await fireEvent.click(screen.getByTestId("dock-open-terminal"));
    expect(sessions.active).toBe(links.key);
    links.needs = null;
    flushSync();
    expect(screen.queryByTestId("terminal-dock")).toBeNull();
  });

  it("answers a started session's question in that session", async () => {
    const { cache } = await setup();
    const asked = fake.question(handleOf(cache.key)!, [
      { header: "Stage", question: "Which stage?", options: [{ label: "dev", description: "" }], multiple: false },
    ]);
    flushSync();
    expect(line("question-dock")).toEqual({ step: "Work", rest: "Fix the cache asks you" });
    await fireEvent.click(screen.getByTestId("question-option"));
    await settle();
    expect(fake.calls.filter((call) => call.method === "reply")).toEqual([
      { method: "reply", id: handleOf(cache.key), request: asked, answers: [["dev"]] },
    ]);
  });
});
