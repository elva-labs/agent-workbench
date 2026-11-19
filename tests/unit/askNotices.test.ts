import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attention, resetAttention } from "$lib/attention.svelte";
import { bareAddress, heedAsks, openAsks, program, resetAskNotices } from "$lib/askNotices.svelte";
import { conductor, resetConductor, type Ask as ConductAsk } from "$lib/conductor.svelte";
import { handleOf, launch, listenIntegrated, resetIntegrated } from "$lib/integrated.svelte";
import { announce, clicked, notify, resetNotify } from "$lib/notify.svelte";
import { byKey, create, onWaiting, reset as resetSessions, sessions, type Session } from "$lib/sessions.svelte";
import { resetSettingsTools, settingsAsk, type Ask as SettingsAsk } from "$lib/settingsTools.svelte";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { resetSenders } from "$lib/senders.svelte";
import { fakeIntegrated, type FakeIntegrated } from "../fakeIntegrated";

// A question that waits on the user is told of through the system when it
// comes while the window is behind: once, by who asks and what for, and
// taken away once it is answered or gone.

const A = "/home/ada/dev/one";

let fake: FakeIntegrated;
let stop = () => {};
let told: { title: string; body: string; name: string }[] = [];
let taken: string[] = [];
let chimes = 0;

async function integrated(title: string): Promise<Session> {
  const row = create(A, null, "claude-code", null, null, null, null, undefined, "integrated");
  await launch(row.key);
  const session = byKey(row.key)!;
  session.title = title;
  return session;
}

async function startedBy(starter: Session, title: string): Promise<Session> {
  const row = create(A, null, "claude-code", null, null, null, null, undefined, "integrated");
  conductor.startedBy[row.key] = starter.token;
  await launch(row.key);
  const session = byKey(row.key)!;
  session.title = title;
  return session;
}

/** What the page does whenever the questions change. */
const look = () => heedAsks(openAsks());

beforeEach(async () => {
  resetSessions();
  resetIntegrated();
  resetConductor();
  resetSettingsTools();
  resetWorkspace();
  resetAgent();
  resetAttention();
  resetNotify();
  resetAskNotices();
  resetSenders();
  localStorage.clear();
  told = [];
  taken = [];
  chimes = 0;
  applyDetect(
    { id: "claude-code", path: "/usr/local/bin/claude", caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
    true,
  );
  workspace.open.push({ path: A, name: "one", repository: A, isGit: true });
  fake = fakeIntegrated();
  (window as unknown as { __CHORD_CORE__: unknown }).__CHORD_CORE__ = {
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
    notify: async (title: string, body: string, name: string) => {
      told.push({ title, body, name });
    },
    unnotify: async (name: string) => {
      taken.push(name);
    },
    chime: async () => {
      chimes += 1;
    },
  };
  stop = await listenIntegrated();
  attention.focused = false;
});

afterEach(() => {
  stop();
  onWaiting(null);
  delete (window as unknown as { __CHORD_CORE__?: unknown }).__CHORD_CORE__;
});

describe("a question from a session another started, while the window is behind", () => {
  it("is one notification saying which session asks and for what", async () => {
    const starter = await integrated("Fix the slow startup");
    const cache = await startedBy(starter, "Fix the cache");
    look();
    fake.ask(handleOf(cache.key)!, "Bash", { command: "cargo test\nand more" });
    look();
    look();
    expect(told).toEqual([
      { title: "one · Fix the cache", body: "Asks to use Bash to run cargo", name: told[0].name },
    ]);
  });

  it("goes, on a click, to the session that started it, where it docks", async () => {
    const starter = await integrated("Fix the slow startup");
    const cache = await startedBy(starter, "Fix the cache");
    const other = await integrated("Elsewhere");
    sessions.active = other.key;
    fake.ask(handleOf(cache.key)!, "Bash", { command: "ls" });
    look();
    clicked(told[0].name);
    expect(sessions.active).toBe(starter.key);
  });

  it("is taken away once answered, and not told of again", async () => {
    const starter = await integrated("Fix the slow startup");
    const cache = await startedBy(starter, "Fix the cache");
    const request = fake.ask(handleOf(cache.key)!, "Bash", { command: "ls" });
    look();
    fake.answer(handleOf(cache.key)!, request, "allow" as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    look();
    expect(taken).toEqual([told[0].name]);
    expect(told).toHaveLength(1);
  });

  it("is a notification for each of two asked at once", async () => {
    const starter = await integrated("Fix the slow startup");
    const cache = await startedBy(starter, "Fix the cache");
    fake.ask(handleOf(cache.key)!, "Bash", { command: "ls" });
    fake.ask(handleOf(starter.key)!, "Bash", { command: "pwd" });
    look();
    expect(told.map((each) => each.title).sort()).toEqual(["one · Fix the cache", "one · Fix the slow startup"]);
    expect(new Set(told.map((each) => each.name)).size).toBe(2);
  });
});

describe("what is not told of", () => {
  it("a question asked while the window has focus, even once the window is left", async () => {
    attention.focused = true;
    const session = await integrated("Fix the cache");
    const request = fake.ask(handleOf(session.key)!, "Bash", { command: "ls" });
    look();
    attention.focused = false;
    look();
    expect(told).toEqual([]);
    fake.answer(handleOf(session.key)!, request, "allow" as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    look();
    expect(taken).toEqual([]);
  });

  it("anything, with the notifications off, but the chime when that is on", async () => {
    notify.notifications = false;
    notify.chime = true;
    const session = await integrated("Fix the cache");
    fake.ask(handleOf(session.key)!, "Bash", { command: "ls" });
    look();
    expect(told).toEqual([]);
    expect(chimes).toBe(1);
  });

  it("an integrated session's ask a second time, as the session waiting", async () => {
    onWaiting(announce);
    const session = await integrated("Fix the cache");
    fake.startTurn(handleOf(session.key)!);
    fake.ask(handleOf(session.key)!, "Bash", { command: "ls" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    look();
    expect(told.map((each) => each.body)).toEqual(["Asks to use Bash to run ls"]);
  });
});

describe("the other questions that wait on the user", () => {
  it("an agent's question, by its first question", async () => {
    const session = await integrated("Fix the cache");
    fake.question(handleOf(session.key)!, [
      { header: "Store", question: "Which store should the cache use?", options: [], multiple: false },
    ]);
    look();
    expect(told.map((each) => each.body)).toEqual(["Asks: Which store should the cache use?"]);
  });

  it("the workbench's question when a session wants to start another, put over the window", async () => {
    const caller = await integrated("Fix the slow startup");
    const other = await integrated("Elsewhere");
    sessions.active = other.key;
    conductor.asking = {
      request: { id: "call-1", arguments: { name: "Fix the cache", prompt: "Read /home/ada/dev/one/src/cache.ts and fix it" } },
      caller: "Fix the slow startup",
      outside: null,
      project: A,
      prompt: "Read /home/ada/dev/one/src/cache.ts and fix it",
      worktree: false,
      round: null,
      login: null,
      named: null,
    } as unknown as ConductAsk;
    look();
    expect(told).toEqual([
      { title: "one · Fix the slow startup", body: "Wants to start “Fix the cache”", name: told[0].name },
    ]);
    // The question is over the window: a click brings the window forward
    // and leaves the session on screen where it is.
    clicked(told[0].name);
    expect(sessions.active).toBe(other.key);
    expect(caller.key).not.toBe(other.key);
  });

  it("the workbench's question, taken away once answered", () => {
    conductor.asking = {
      request: { id: "call-1" },
      caller: "A session",
      outside: null,
      project: A,
      prompt: "",
      worktree: false,
      round: null,
      login: null,
      named: null,
    } as unknown as ConductAsk;
    look();
    expect(told.map((each) => each.body)).toEqual(["Wants to start a session"]);
    conductor.asking = null;
    look();
    expect(taken).toEqual([told[0].name]);
  });

  it("an agent's change to the settings, by what kind of change, not its reason", async () => {
    const caller = await integrated("Theme work");
    settingsAsk.asking = {
      request: { id: "set-1", tool: "settings_change", arguments: {}, cwd: A, session: caller.token },
      caller: "Theme work",
      reason: "You asked for a darker look",
      changes: [
        { field: "appearance", label: "Appearance", from: "Light", to: "Dark" },
        { field: "keys.palette", label: "Palette", from: "⌘K", to: "⌘P" },
      ],
      theme: null,
      ground: null,
      css: null,
    } as SettingsAsk;
    look();
    expect(told).toEqual([
      {
        title: "one · Theme work",
        body: "Wants to change the look and the key chords",
        name: told[0].name,
      },
    ]);
  });

  it("a command by its program alone, as its arguments may hold a secret", async () => {
    const session = await integrated("Fix the cache");
    fake.ask(handleOf(session.key)!, "Bash", { command: 'API_TOKEN=abc123 /usr/bin/curl -H "Authorization: Bearer abc123" https://x' });
    look();
    expect(told[0].body).toBe("Asks to use Bash to run curl");
    expect(program("cargo test --workspace")).toBe("cargo");
    expect(program("FOO=1 BAR=2 ./scripts/run.sh --all")).toBe("run.sh");
  });

  it("an address without its query or fragment, which may carry a token", async () => {
    const session = await integrated("Fix the cache");
    fake.ask(handleOf(session.key)!, "WebFetch", { url: "https://ada:pw@api.example.com/v1/items?token=abc#frag", prompt: "read" });
    look();
    expect(told[0].body).toBe("Asks to fetch https://api.example.com/v1/items");
    expect(bareAddress("list_issues")).toBe("list_issues");
    expect(bareAddress("file:///tmp/a.txt?x=1")).toBe("file:///tmp/a.txt");
  });

  it("a long line, cut to one line of the notification", async () => {
    const session = await integrated("Fix the cache");
    fake.ask(handleOf(session.key)!, "Bash", { command: "x".repeat(300) });
    look();
    expect(Array.from(told[0].body)).toHaveLength(100);
    expect(told[0].body.endsWith("…")).toBe(true);
  });
});
