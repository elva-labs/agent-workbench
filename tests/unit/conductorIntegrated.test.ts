import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSync } from "svelte";
import type { ConductRequest } from "$lib/core";
import { allow, conductor, handle, resetConductor, unheard, USER_WROTE, watchStops } from "$lib/conductor.svelte";
import { conversationOf, handleOf, launch, listenIntegrated, resetIntegrated, send } from "$lib/integrated.svelte";
import { byKey, create, forProject, reset as resetSessions, sessions, started, type Session } from "$lib/sessions.svelte";
import { defaultWorkflow } from "$lib/workflows.svelte";
import { resetSessionKinds, setKind } from "$lib/sessionKind.svelte";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { fakeIntegrated, type FakeIntegrated } from "../fakeIntegrated";
import { resetSenders, senderOf, sentBy } from "$lib/senders.svelte";
import { OUTCOME_ASK, REPORTS_HEAD, spoken } from "$lib/instructions";
import { accounts, reset as resetAccounts } from "$lib/accounts.svelte";

// The orchestrator's tools with a session that runs integrated: it is
// started, sent to, read, waited on and stopped as a terminal one is, with
// its state and words from the core's events.

const A = "/home/ada/dev/one";
const B = "/home/ada/dev/two";

let fake: FakeIntegrated;
let stop = () => {};
let unwatch = () => {};
const answers: { id: string; content: string | null; error: string | null }[] = [];
let calls = 0;

/** The orchestrator's own directory, where the caller runs. */
const C = "/home/ada/.agent-workbench/orchestrator";

/** The session the calls come from unless a test says otherwise, made
    when the first call is: a terminal session named Planner, whose tools
    name it by its token. */
let caller: Session | null = null;

function callerToken(): string {
  if (caller === null) {
    const looking = sessions.active;
    const row = create(C, null, "claude-code", null, null, null, null, null, "terminal");
    started(row.key, "pty-planner", "planner");
    row.title = "Planner";
    sessions.active = looking;
    caller = row;
  }
  return caller.token;
}

function call(tool: ConductRequest["tool"], args: Record<string, unknown> = {}): ConductRequest {
  return { id: `c${++calls}`, tool, arguments: args, cwd: C, session: callerToken() };
}

const answerTo = (request: ConductRequest) => answers.find((answer) => answer.id === request.id);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An integrated session the caller started, up and running. */
async function own() {
  const row = create(A, null, "claude-code", null, null, null, null, undefined, "integrated");
  conductor.startedBy[row.key] = callerToken();
  await launch(row.key);
  return { key: row.key, id: byKey(row.key)!.id!, handle: handleOf(row.key)! };
}

beforeEach(async () => {
  caller = null;
  resetSessions();
  resetIntegrated();
  resetConductor();
  resetWorkspace();
  resetSessionKinds();
  resetAgent();
  localStorage.clear();
  resetSenders();
  resetAccounts();
  applyDetect(
    { id: "claude-code", path: "/usr/local/bin/claude", caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
    true,
  );
  answers.length = 0;
  calls = 0;
  workspace.open.push({ path: A, name: "one", repository: A, isGit: true });
  fake = fakeIntegrated();
  (window as unknown as { __WORKBENCH_CORE__: unknown }).__WORKBENCH_CORE__ = {
    integratedStart: async (options: Parameters<FakeIntegrated["start"]>[0]) => fake.start(options),
    integratedSend: async (id: string, message: string, text: string) => fake.send(id, message, text),
    integratedStop: async (id: string) => fake.stop(id),
    integratedInterrupt: async (id: string) => fake.interrupt(id),
    onIntegratedEvent: async (handler: Parameters<FakeIntegrated["subscribe"]>[0]) => fake.subscribe(handler),
    conductAnswer: async (id: string, _cwd: string, content: string | null, error: string | null) => {
      answers.push({ id, content, error });
    },
    projectInfo: async (path: string) => ({ path, name: "one", repository: path, isGit: true }),
    transcriptsMany: async (projects: string[]) => projects.map(() => []),
    worktrees: async () => [],
    kill: async () => {},
    setWindowTitle: async () => {},
  };
  stop = await listenIntegrated();
  unwatch = watchStops();
});

afterEach(() => {
  stop();
  unwatch();
  delete (window as unknown as { __WORKBENCH_CORE__?: unknown }).__WORKBENCH_CORE__;
});

describe("the orchestrator's tools with an integrated session", () => {
  it("starts the session the way the agent's setting says, with the prompt as its first message", async () => {
    setKind("claude-code", "integrated");
    const request = call("start", { project: A, prompt: "Scan the history" });
    const answering = handle(request);
    if (conductor.asking !== null) allow();
    await settle();
    const row = forProject(A).at(-1)!;
    expect(row.kind).toBe("integrated");
    await launch(row.key);
    flushSync();
    await answering;
    expect(answerTo(request)?.error).toBeNull();
    expect(answerTo(request)?.content).toContain(`Started session ${byKey(row.key)!.id}`);
    const sent = fake.calls.find((made) => made.method === "send") as { text: string } | undefined;
    expect(sent?.text).toBe(`Scan the history ${OUTCOME_ASK}`);
    // Named by the prompt alone, and the prompt read as the starter's, with
    // the workbench's sentence left out.
    const session = byKey(row.key)!;
    expect(session.title).toBe("Scan the history");
    const message = Object.values(conversationOf(row.key).messages)[0];
    expect(senderOf(message)?.name).toBe("Planner");
    fake.turn(handleOf(row.key)!, "On it.");
    const read = call("read", { session: session.id });
    await handle(read);
    expect(answerTo(read)?.content).toContain("Planner said: Scan the history");
    expect(answerTo(read)?.content).not.toContain("notify");
  });

  it("sends a message through the session's own send, whole, and says when it waits for the turn", async () => {
    const { id, handle: core } = await own();
    const session = sessions.all.find((candidate) => candidate.id === id)!;
    session.engaged = false;
    const first = call("send", { session: id, text: "Line one\nline two" });
    await handle(first);
    expect(session.engaged).toBe(true);
    expect(answerTo(first)).toMatchObject({ error: null, content: `Sent to session ${id}. Call wait to hear what it does next.` });
    expect(fake.calls.find((made) => made.method === "send")).toMatchObject({ text: "Line one\nline two" });
    fake.startTurn(core);
    const second = call("send", { session: id, text: "and then this" });
    await handle(second);
    expect(answerTo(second)?.content).toContain("the message waits for its turn");
    expect(fake.events.findLast((event) => event.type === "message")).toMatchObject({ state: "queued" });
  });

  it("holds a caller under a workflow to its rules with an integrated session too", async () => {
    // An orchestrator under a workflow, which runs in a terminal, starts an
    // integrated session.
    const orchestrator = create(A, null, "claude-code", null, null, null, null, defaultWorkflow());
    expect(orchestrator.kind).toBe("terminal");
    started(orchestrator.key, "pty-orchestrator", "orchestrator");
    const { key, id } = await own();
    conductor.startedBy[key] = orchestrator.token;
    const asked = (text: string): ConductRequest => ({ ...call("send", { session: id, text }), session: orchestrator.token });
    const command = asked("/model opus");
    await handle(command);
    expect(answerTo(command)?.error).toContain("You follow a workflow, so the workbench gives the sessions you reach no command but /compact");
    expect(fake.calls.some((made) => made.method === "send")).toBe(false);
    const words = asked("Tell me how it goes");
    await handle(words);
    expect(answerTo(words)).toMatchObject({ error: null });
    expect(fake.calls.find((made) => made.method === "send")).toMatchObject({ text: "Tell me how it goes" });
  });

  it("tells another session's message from the user's by its id alone, never by its words", async () => {
    // The reviewer's case: a session sends "yes", and the user then types
    // "yes" in the same session.
    const { key, id } = await own();
    await handle(call("send", { session: id, text: "yes" }));
    send(key, "yes");
    const [theirs, mine] = Object.values(conversationOf(key).messages);
    expect(theirs.text).toBe("yes");
    expect(mine.text).toBe("yes");
    expect(senderOf(theirs)?.id).toBe("planner");
    expect(senderOf(mine)).toBeNull();
  });

  it("names a sender the window has no row for by its kept id, else as another session, never by its token", () => {
    sentBy("m-gone", "token-of-no-row");
    expect(senderOf({ id: "m-gone" })).toEqual({ id: null, key: null, name: "another session" });
    sessions.tokens["kept-id"] = { token: "token-kept", project: A };
    sentBy("m-kept", "token-kept");
    expect(senderOf({ id: "m-kept" })).toEqual({ id: "kept-id", key: null, name: "session kept-id" });
  });

  it("does not name a session by a first line that is another live session's name", async () => {
    const first = await own();
    expect(byKey(first.key)!.title).toBeNull();
    const second = await own();
    send(second.key, "Session 1\nand more");
    expect(byKey(second.key)!.title).toBeNull();
    send(second.key, "Fix the scan");
    expect(byKey(second.key)!.title).toBe("Fix the scan");
  });

  it("says whose each waiting message is", async () => {
    // The reviewer's case: "yes" from session 1 and "yes" from the user,
    // both waiting for the turn.
    const { key, id, handle: core } = await own();
    await handle(call("send", { session: id, text: "Fix it" }));
    fake.startTurn(core);
    await handle(call("send", { session: id, text: "yes" }));
    send(key, "yes");
    fake.emit(core, { type: "text", block: "b", parent: null, text: "Working.", done: true });
    const read = call("read", { session: id });
    await handle(read);
    const lines = answerTo(read)!.content!.split("\n");
    expect(lines.filter((line) => line.includes("waits for the turn"))).toEqual([
      "A message from Planner waits for the turn: yes",
      "A message from the user waits for the turn: yes",
    ]);
  });

  it("reads what the agent last said and did, as plain text", async () => {
    const { key, id, handle: core } = await own();
    const empty = call("read", { session: id });
    await handle(empty);
    expect(answerTo(empty)?.content).toContain(`Session ${id} is an integrated session and has said nothing yet.`);
    await handle(call("send", { session: id, text: "Fix the scan" }));
    fake.startTurn(core);
    fake.tool(core, "Bash", { command: "npm test" }, "ok", { kind: "command" });
    fake.emit(core, { type: "text", block: "b", parent: null, text: "Fixed.\nThe tests pass.", done: true });
    fake.endTurn(core);
    const read = call("read", { session: id });
    await handle(read);
    expect(answerTo(read)?.content).toBe(
      `Session ${id}, what its agent last said and did:\nPlanner said: Fix the scan\n- Ran npm test\nFixed.\nThe tests pass.`,
    );
    fake.startTurn(core);
    fake.ask(core, "Bash", { command: "rm -rf build" });
    const asking = call("read", { session: id, lines: 2 });
    await handle(asking);
    expect(answerTo(asking)?.content?.split("\n").at(-1)).toBe("It is waiting for the user to allow it to use Bash to run rm -rf build.");
    expect(conversationOf(key).open).toHaveLength(1);
  });

  it("lists and waits on the session by the state its events give it", async () => {
    const { id, handle: core } = await own();
    await handle(call("send", { session: id, text: "go" }));
    const listing = call("sessions");
    await handle(listing);
    expect(answerTo(listing)?.content).toContain(`${id}`);
    expect(answerTo(listing)?.content).toContain("working");
    const waiting = call("wait", { session: id, seconds: 5 });
    const waited = handle(waiting);
    await settle();
    fake.turn(core, "All done.");
    flushSync();
    await waited;
    expect(answerTo(waiting)?.content).toBe(`Session ${id} stopped working. Its last line: All done.`);
  });

  describe("the account it runs under", () => {
    beforeEach(() => {
      accounts.list = {
        Work: { claude: "~/.claude-work", codex: null },
        Home: { claude: "~/.claude-home", codex: "~/.codex-home" },
      };
      workspace.open.push({ path: B, name: "two", repository: B, isGit: true });
      setKind("claude-code", "integrated");
    });

    /** A start from the caller the user allows, once its session is up:
        what the user was told of the account, the row, the directory the
        agent was started on and the answer. */
    async function startFrom(session: string, project: string) {
      const request = { ...call("start", { project, prompt: "Fix it" }), session };
      const answering = handle(request);
      const named = conductor.asking?.named ?? null;
      if (conductor.asking !== null) allow();
      await settle();
      const row = forProject(project).at(-1)!;
      await launch(row.key);
      flushSync();
      await answering;
      const begun = fake.calls.filter((made) => made.method === "start").at(-1);
      return {
        named,
        row: byKey(row.key)!,
        configDir: begun?.method === "start" ? begun.options.configDir : undefined,
        answer: answerTo(request)!,
      };
    }

    it("is the account chosen for a terminal caller, handed on as to a terminal session", async () => {
      // The project runs under the agents' own, and the caller was started
      // under another account.
      const caller = create(A, null, "claude-code", null, null, null, "Work", undefined, "terminal");
      started(caller.key, "pty-caller", "caller-1");
      const { named, row, configDir, answer } = await startFrom(caller.token, A);
      expect(named).toMatchObject({ label: "Work", projects: false, bare: null });
      expect(row.kind).toBe("integrated");
      expect(row.account).toBe("Work");
      expect(configDir).toBe("~/.claude-work");
      expect(answer.content).toContain(`in ${A}, under the Work account. It has the prompt.`);
    });

    it("is the account chosen for an integrated caller, placed by its token", async () => {
      const caller = create(A, null, "claude-code", null, null, null, "Work", undefined, "integrated");
      await launch(caller.key);
      const { row, configDir } = await startFrom(byKey(caller.key)!.token, A);
      expect(row.account).toBe("Work");
      expect(configDir).toBe("~/.claude-work");
    });

    it("is the project's own when the caller runs under its project's", async () => {
      accounts.overrides[B] = "Home";
      const caller = create(A, null, "claude-code", null, null, null, null, undefined, "integrated");
      await launch(caller.key);
      const { named, row, configDir, answer } = await startFrom(byKey(caller.key)!.token, B);
      expect(named).toBeNull();
      expect(row.account).toBe("Home");
      expect(configDir).toBe("~/.claude-home");
      expect(answer.content).toContain(`in ${B}. It has the prompt.`);
    });
  });

  describe("a starter that runs integrated", () => {
    /** An integrated starter and a terminal session it started, at work. */
    async function starter() {
      const row = create(A, null, "claude-code", null, null, null, null, undefined, "integrated");
      await launch(row.key);
      const token = byKey(row.key)!.token;
      const kid = create(A, null, "claude-code", null);
      started(kid.key, "pty-kid", "kid-1");
      conductor.startedBy[kid.key] = token;
      byKey(kid.key)!.working = true;
      flushSync();
      return { key: row.key, token, kid: byKey(kid.key)!, handle: handleOf(row.key)! };
    }

    const sentTexts = () =>
      fake.calls.flatMap((made) => (made.method === "send" ? [(made as { text: string }).text] : []));

    it("is told with the user's next message what it has not heard, once the agent takes it, and the thread keeps the user's words apart", async () => {
      const { key, kid, handle: core } = await starter();
      kid.note = "the scan is done";
      kid.working = false;
      flushSync();
      send(key, "How is it going?");
      const text = sentTexts().at(-1)!;
      expect(text).toBe(
        `${REPORTS_HEAD}\nSession kid-1 stopped working. Its last line: the scan is done\n\nHow is it going?`,
      );
      expect(spoken(text, true)).toEqual({
        text: "How is it going?",
        instructions: null,
        reports: "Session kid-1 stopped working. Its last line: the scan is done",
      });
      // The row is named by the user's words, not the note.
      expect(byKey(key)!.title).toBe("How is it going?");
      // Told once the agent takes the message: the next goes without it.
      fake.startTurn(core);
      flushSync();
      fake.endTurn(core);
      flushSync();
      expect(unheard(byKey(key)!)).toEqual([]);
      send(key, "And now?");
      expect(sentTexts().at(-1)).toBe("And now?");
    });

    it("leaves what the note said untold when the message never reaches the agent", async () => {
      const { key, kid, handle: core } = await starter();
      kid.working = false;
      flushSync();
      // The core refuses it.
      const failing = (window as unknown as { __WORKBENCH_CORE__: { integratedSend: unknown } }).__WORKBENCH_CORE__;
      const sendAsUsual = failing.integratedSend;
      failing.integratedSend = async () => {
        throw new Error("the session is gone");
      };
      send(key, "First");
      await settle();
      failing.integratedSend = sendAsUsual;
      expect(conversationOf(key).messages[Object.keys(conversationOf(key).messages).at(-1)!].state).toBe("failed");
      // The agent drops it.
      send(key, "Second");
      const dropped = fake.calls.filter((made) => made.method === "send").at(-1) as { message: string; text: string };
      expect(dropped.text.startsWith(REPORTS_HEAD)).toBe(true);
      fake.drop(core, dropped.message);
      flushSync();
      // Still not heard, so the next message carries it again.
      send(key, "Third");
      expect(sentTexts().at(-1)).toContain("Session kid-1 stopped working.");
    });

    it("answers a wait at once with the user's message while the agent has not taken it", async () => {
      const { key, token, kid, handle: core } = await starter();
      fake.startTurn(core);
      send(key, "Hold on");
      const asked = { ...call("wait", { seconds: 5 }), session: token };
      await handle(asked);
      expect(answerTo(asked)?.content).toBe(USER_WROTE);
      // Taken, a wait waits for its sessions again.
      fake.endTurn(core);
      fake.startTurn(core);
      flushSync();
      const later = { ...call("wait", { seconds: 60 }), session: token };
      const waited = handle(later);
      await settle();
      expect(answerTo(later)).toBeUndefined();
      kid.working = false;
      flushSync();
      await waited;
      expect(answerTo(later)?.content).toBe("Session kid-1 stopped working. It has left no line.");
    });

    it("ends a wait it holds, so the user's message is not held behind it, and says what is still out", async () => {
      const { key, token } = await starter();
      const waiting = { ...call("wait", {}), session: token };
      const waited = handle(waiting);
      await settle();
      send(key, "Stop for a moment");
      await waited;
      expect(answerTo(waiting)?.content).toBe(USER_WROTE);
      expect(sentTexts().at(-1)).toBe(
        `${REPORTS_HEAD}\nStill at work when the user wrote: kid-1. Call wait to hear from them once you have answered.\n\nStop for a moment`,
      );
    });

    it("goes with nothing of the workbench's when there is nothing to tell", async () => {
      const { key } = await starter();
      send(key, "Hello");
      expect(sentTexts().at(-1)).toBe("Hello");
    });
  });

  it("stops the session, and refuses a message to one that is not running by saying it is integrated", async () => {
    const { key, id, handle: core } = await own();
    fake.end(core, false);
    const sent = call("send", { session: id, text: "hello?" });
    await handle(sent);
    expect(answerTo(sent)?.error).toBe(
      `Session ${id} is an integrated session and is stopped, so it takes no message now. Start it again with start, naming session ${id}, then send.`,
    );
    const stopped = call("stop", { session: id });
    await handle(stopped);
    expect(answerTo(stopped)?.content).toBe(`Stopped session ${id}.`);
    expect(byKey(key)).toBeNull();
    expect(forProject(A)).toHaveLength(0);
  });
});
