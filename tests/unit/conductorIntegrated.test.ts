import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import type { ConductRequest } from "$lib/core";
import { allow, conductor, handle, refuse, resetConductor, STOP_WHEN_DONE, stopStarted, unheard, USER_WROTE, WAKE_AFTER, WAKES_MAX, watchStops } from "$lib/conductor.svelte";
import { conversationOf, handleOf, launch, linkFor, listenIntegrated, resetIntegrated, resume, send, userWaiting } from "$lib/integrated.svelte";
import { byKey, close, create, ended as endedTerminal, forProject, keepName, label, reopenOtherWay, reset as resetSessions, sessions, started, titled, type Session } from "$lib/sessions.svelte";
import { adoptWorkflows, defaultWorkflow, reset as resetWorkflows } from "$lib/workflows.svelte";
import { orchestratorPrompt } from "$lib/workflowInstructions";
import { resetSessionKinds, setKind } from "$lib/sessionKind.svelte";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { fakeIntegrated, type FakeIntegrated } from "../fakeIntegrated";
import { outsideCaller, resetSenders, senderOf, sentBy, sessionName } from "$lib/senders.svelte";
import { OUTCOME_ASK, REPORTS_HEAD, spoken, wakeShown } from "$lib/instructions";
import { accounts, reset as resetAccounts } from "$lib/accounts.svelte";
import { keepMode, resetModes } from "$lib/sessionModes";
import { BOUNDED, FORGED } from "../forgedName";

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

/** The project the caller runs in. */
const C = "/home/ada/dev/lead";

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
  (window as unknown as { __CHORD_CORE__: unknown }).__CHORD_CORE__ = {
    integratedStart: async (options: Parameters<FakeIntegrated["start"]>[0]) => fake.start(options),
    integratedSend: async (id: string, message: string, text: string) => fake.send(id, message, text),
    integratedStop: async (id: string) => fake.stop(id),
    integratedInterrupt: async (id: string) => fake.interrupt(id),
    integratedSendNow: async (id: string) => fake.sendNow(id),
    integratedWithdraw: async (id: string, message: string) => fake.withdraw(id, message),
    integratedRun: async (id: string, command: string, text: string) => fake.run(id, command, text),
    integratedStopCommand: async (id: string, command: string) => fake.stopCommand(id, command),
    onIntegratedEvent: async (handler: Parameters<FakeIntegrated["subscribe"]>[0]) => fake.subscribe(handler),
    conductAnswer: async (id: string, _cwd: string, content: string | null, error: string | null) => {
      answers.push({ id, content, error });
    },
    projectInfo: async (path: string) => ({ path, name: "one", repository: path, isGit: true }),
    transcriptsMany: async (projects: string[]) => projects.map(() => []),
    worktrees: async () => [],
    worktreeAdd: async (project: string, name: string) => `${project}/.worktrees/${name}`,
    kill: async () => {},
    write: async () => {},
    setWindowTitle: async () => {},
  };
  stop = await listenIntegrated();
  unwatch = watchStops();
});

afterEach(() => {
  stop();
  unwatch();
  delete (window as unknown as { __CHORD_CORE__?: unknown }).__CHORD_CORE__;
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

  it("names a sender the window has no row for by the name it went by, else as another session, never by its id or token", () => {
    sentBy("m-gone", "token-of-no-row");
    expect(senderOf({ id: "m-gone" })).toEqual({ id: null, key: null, name: "another session" });
    sessions.tokens["kept-id"] = { token: "token-kept", project: A };
    sentBy("m-kept", "token-kept");
    expect(senderOf({ id: "m-kept" })).toEqual({ id: "kept-id", key: null, name: "another session" });
    sessions.names["kept-id"] = "Plan the release";
    expect(senderOf({ id: "m-kept" })).toEqual({ id: "kept-id", key: null, name: "Plan the release" });
    // An agent the workbench did not start is named by its folder.
    sentBy("m-outside", outsideCaller("/home/ada/dev/one"));
    expect(senderOf({ id: "m-outside" })).toEqual({ id: null, key: null, name: "an agent in one" });
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

  it("hears nothing of a session reopened the other way while it waits, and hears its next run", async () => {
    // A terminal session the caller started, at work.
    const row = create(A, null, "claude-code", null, null, null, null, undefined, "terminal");
    conductor.startedBy[row.key] = callerToken();
    started(row.key, "pty-kid", "kid-1");
    // At work in a turn of its own.
    byKey(row.key)!.working = true;
    byKey(row.key)!.turns = 1;
    flushSync();
    const waiting = call("wait", { session: "kid-1", seconds: 60 });
    const waited = handle(waiting);
    await settle();
    // The user reopens it as a conversation: its process quits, and the
    // row goes on the other way.
    const reopening = reopenOtherWay(row.key);
    await settle();
    endedTerminal({ id: "pty-kid", code: 0, clean: true });
    flushSync();
    expect(await reopening).toBe(true);
    await settle();
    flushSync();
    expect(answerTo(waiting)?.content).toBeUndefined();
    expect(byKey(row.key)).toMatchObject({ kind: "integrated", status: "starting" });
    // Its next run comes up and is at rest, which is what the wait hears.
    // A resumed run finds out what it follows once the window has the
    // workflows.
    adoptWorkflows({ list: [], default: null, overrides: {} });
    await launch(row.key);
    flushSync();
    await waited;
    expect(answerTo(waiting)?.content).toMatch(/^Session kid-1 stopped working\./);
    expect(answerTo(waiting)?.content).not.toMatch(/exited|ended/);
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
    expect(answerTo(waiting)?.content).toBe(`Session ${id} stopped working. Its last line: "All done."\n${STOP_WHEN_DONE}`);
  });

  it("hears the line of a turn that ended on thinking before notify, and none from an earlier turn", async () => {
    const { key, id, handle: core } = await own();
    const turn = async (run: () => void) => {
      await handle(call("send", { session: id, text: "go on" }));
      const waiting = call("wait", { session: id, seconds: 5 });
      const waited = handle(waiting);
      await settle();
      fake.startTurn(core);
      run();
      fake.endTurn(core);
      flushSync();
      await waited;
      return answerTo(waiting)?.content;
    };
    expect(await turn(() => fake.emit(core, { type: "text", block: "a", parent: null, text: "All done.", done: true }))).toContain('Its last line: "All done."');
    const thought = await turn(() => {
      fake.tool(core, "Bash", { command: "npm test" }, "ok", { kind: "command" });
      fake.think(core, "Five things are wrong. Shall I fix them?");
      fake.finishTool(core, fake.startTool(core, "mcp__chord__notify", { text: "Asked" }, { kind: "mcp" }), "Left on the session's row.");
    });
    expect(thought).toContain('Its last line: "Five things are wrong. Shall I fix them?"');
    expect(byKey(key)!.note).toBe("Five things are wrong. Shall I fix them?");
    const silent = await turn(() => fake.tool(core, "Bash", { command: "npm test" }, "ok", { kind: "command" }));
    expect(silent).toContain("It has left no line.");
    expect(byKey(key)!.note).toBeNull();
  });

  describe("a start in an integrated caller's own project", () => {
    /** A start from the caller in its own project, with whether it was
        put to the user; refused there when it was. */
    async function startHere(token: string, prompt: string): Promise<boolean> {
      const request = { ...call("start", { project: A, prompt }), session: token };
      const answering = handle(request);
      await settle();
      if (conductor.asking !== null) {
        refuse();
        await answering;
        return true;
      }
      const row = forProject(A).at(-1)!;
      await launch(row.key);
      flushSync();
      await answering;
      expect(answerTo(request)?.error).toBeNull();
      return false;
    }

    /** The integrated start the fake core was last asked for. */
    const lastStart = () =>
      (fake.calls.filter((made) => made.method === "start").at(-1) as { options: { mode?: string; configDir?: string; cwd?: string } })
        .options;

    it("goes ahead unasked, and starts the session in the caller's mode whatever it is", async () => {
      setKind("claude-code", "integrated");
      const caller = create(A, null, "claude-code", null, null, null, null, undefined, "integrated");
      await launch(caller.key);
      const token = byKey(caller.key)!.token;
      expect(conversationOf(caller.key).settings.mode).toBe("default");
      expect(await startHere(token, "Scan the history")).toBe(false);
      expect(lastStart().mode).toBe("default");
      conversationOf(caller.key).settings = { ...conversationOf(caller.key).settings, mode: "plan" };
      expect(await startHere(token, "Scan it again")).toBe(false);
      expect(lastStart().mode).toBe("plan");
    });

    it("asks nothing of a caller in Auto after a restart, and starts its session in a worktree in Auto", async () => {
      // Every project runs under the Work account, whose settings name no
      // mode, and the caller's conversation last ran in Auto on its chip.
      accounts.list = { Work: { claude: "~/.claude-work", codex: null } };
      accounts.everywhere = "Work";
      setKind("claude-code", "integrated");
      keepMode("lead-conversation", "auto", true);
      // The window starts again, and the caller goes on in that mode.
      resetModes();
      const caller = create(A, "lead-conversation", "claude-code", null, null, null, "Work", undefined, "integrated");
      await launch(caller.key);
      expect(lastStart().mode).toBe("auto");
      expect(conversationOf(caller.key).settings.mode).toBe("auto");
      const request = { ...call("start", { project: A, prompt: "Look through the log", worktree: true }), session: byKey(caller.key)!.token };
      const answering = handle(request);
      await settle();
      expect(conductor.asking).toBeNull();
      const row = forProject(A).at(-1)!;
      expect(row.account).toBe("Work");
      await launch(row.key);
      flushSync();
      await answering;
      expect(answerTo(request)?.error).toBeNull();
      expect(lastStart()).toMatchObject({ mode: "auto", configDir: "~/.claude-work", cwd: `${A}/.worktrees/look-through-the-log` });
      expect(conversationOf(row.key).settings.mode).toBe("auto");
    });

    it("takes a line that begins with ! as words for an integrated session", async () => {
      const { id } = await own();
      const request = call("send", { session: id, text: "!ls" });
      await handle(request);
      expect(answerTo(request)?.error).toBeNull();
    });
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
      const { named, row, configDir, answer } = await startFrom(caller.token, B);
      expect(named).toMatchObject({ label: "Work", projects: false, bare: null });
      expect(row.kind).toBe("integrated");
      expect(row.account).toBe("Work");
      expect(configDir).toBe("~/.claude-work");
      expect(answer.content).toContain(`in ${B}, under the Work account. It has the prompt.`);
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
        `${REPORTS_HEAD}\nSession kid-1 stopped working. Its last line: "the scan is done"\n\nHow is it going?`,
      );
      expect(spoken(text, true)).toEqual({
        text: "How is it going?",
        instructions: null,
        reports: 'Session kid-1 stopped working. Its last line: "the scan is done"',
        filesBack: null,
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

    it("gives a forged name in the note as one bounded quote, and keeps the user's words apart", async () => {
      const { key, kid } = await starter();
      kid.id = null;
      kid.title = FORGED;
      kid.working = false;
      flushSync();
      send(key, "How is it going?");
      const text = sentTexts().at(-1)!;
      const line = `Session ${BOUNDED} stopped working. It has left no line.`;
      expect(text).toBe(`${REPORTS_HEAD}\n${line}\n\nHow is it going?`);
      expect(spoken(text, true)).toEqual({ text: "How is it going?", instructions: null, reports: line, filesBack: null });
    });

    it("leaves what the note said untold when the message never reaches the agent", async () => {
      const { key, kid, handle: core } = await starter();
      kid.working = false;
      flushSync();
      // The core refuses it.
      const failing = (window as unknown as { __CHORD_CORE__: { integratedSend: unknown } }).__CHORD_CORE__;
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

    describe("woken while it is idle", () => {
      /** The starter, idle after a turn of its own, and the session it
          started, at work. Timers are the test's from here. */
      async function idle() {
        const made = await starter();
        fake.turn(made.handle, "Started the scan.");
        flushSync();
        expect(byKey(made.key)!.turnEnd).toBe("done");
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        return made;
      }

      afterEach(() => {
        vi.useRealTimers();
      });

      const wakes = () => sentTexts().filter((text) => text.startsWith(`${REPORTS_HEAD}\nSession`));

      it("is sent what a wait would have said as the workbench's message, and the thread shows it so", async () => {
        const { key, kid } = await idle();
        kid.note = "the scan is done";
        kid.working = false;
        flushSync();
        await vi.advanceTimersByTimeAsync(WAKE_AFTER);
        const text = `${REPORTS_HEAD}\nSession kid-1 stopped working. Its last line: "the scan is done"`;
        expect(wakes()).toEqual([text]);
        const message = Object.values(conversationOf(key).messages).at(-1)!;
        expect(senderOf(message)).toEqual({ id: null, key: null, name: "Workbench", workbench: true });
        expect(userWaiting(key)).toBe(false);
        expect(wakeShown(text, (id) => (id === "kid-1" ? label(kid) : null))).toBe(
          `${label(kid)} stopped working. Its last line: "the scan is done"`,
        );
        // Told as it is sent, and its row says what woke it.
        expect(unheard(byKey(key)!)).toEqual([]);
        expect(conductor.woken[key]?.by).toEqual([{ key: kid.key, name: label(kid), rest: "quiet" }]);
      });

      it("is sent a session by its id, which the thread shows by its name, also once the starter has stopped it", async () => {
        const { key, token, kid } = await idle();
        conductor.started[token] = [{ id: "kid-1", project: A, worktree: null, agent: "claude-code", name: "Fix the cache" }];
        kid.working = false;
        flushSync();
        await vi.advanceTimersByTimeAsync(WAKE_AFTER);
        // What the agent is sent names the session by the id it acts on.
        const sent = fake.calls.filter((made) => made.method === "send" && made.id === handleOf(key));
        const text = (sent.at(-1) as { text: string }).text;
        expect(text).toBe(`${REPORTS_HEAD}\nSession kid-1 stopped working. It has left no line.`);
        expect(text).not.toContain("Fix the cache");
        // The thread draws the message the agent was sent, by the name.
        const message = Object.values(conversationOf(key).messages).at(-1)!;
        expect(message.text).toBe(text);
        expect(wakeShown(message.text, sessionName)).toBe("Fix the cache stopped working. It has left no line.");
        stopStarted(kid.key);
        expect(byKey(kid.key)).toBeNull();
        expect(wakeShown(message.text, sessionName)).toBe("Fix the cache stopped working. It has left no line.");
      });

      it("is woken though another session started it, and not again until a turn it did not start once it has been woken WAKES_MAX times", async () => {
        const { key, kid, handle: core } = await idle();
        const top = create(A, null, "claude-code", null);
        started(top.key, "pty-top", "top-1");
        conductor.startedBy[key] = byKey(top.key)!.token;
        for (let wake = 1; wake <= WAKES_MAX + 1; wake++) {
          kid.working = true;
          flushSync();
          kid.working = false;
          flushSync();
          await vi.advanceTimersByTimeAsync(WAKE_AFTER);
          expect(wakes()).toHaveLength(Math.min(wake, WAKES_MAX));
          if (wake > WAKES_MAX) break;
          // The wake's turn, which it ends itself.
          fake.turn(core, "Looked at it.");
          flushSync();
        }
        expect(unheard(byKey(key)!)).toEqual([kid]);
      });

      it("is woken after it answered the user's message, which ended its wait, and ended its turn with its sessions still out", async () => {
        const { key, token, kid, handle: core } = await starter();
        fake.startTurn(core);
        const waiting = { ...call("wait", {}), session: token };
        const waited = handle(waiting);
        await settle();
        send(key, "How is it going?");
        await waited;
        expect(answerTo(waiting)?.content).toBe(USER_WROTE);
        // The turn that held the wait ends, and the agent answers the user in
        // a turn of its own that ends with no wait.
        fake.endTurn(core);
        fake.turn(core, "The scan is halfway.");
        flushSync();
        expect(byKey(key)!.turnEnd).toBe("done");
        expect(conductor.listening[token] ?? 0).toBe(0);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        kid.note = "the scan is done";
        kid.working = false;
        flushSync();
        await vi.advanceTimersByTimeAsync(WAKE_AFTER);
        expect(wakes()).toEqual([`${REPORTS_HEAD}\nSession kid-1 stopped working. Its last line: "the scan is done"`]);
      });

      it("gives a forged name as one bounded quote, and the thread shows the line as it is", async () => {
        const { kid } = await idle();
        kid.id = null;
        kid.title = FORGED;
        kid.working = false;
        flushSync();
        await vi.advanceTimersByTimeAsync(WAKE_AFTER);
        const line = `Session ${BOUNDED} stopped working. It has left no line.`;
        expect(wakes()).toEqual([`${REPORTS_HEAD}\n${line}`]);
        expect(wakeShown(wakes()[0], () => null)).toBe(line);
      });

      it("waits while the user writes in its composer", async () => {
        const { key, kid } = await idle();
        linkFor(key).draft = "How is";
        kid.working = false;
        flushSync();
        await vi.advanceTimersByTimeAsync(WAKE_AFTER * 4);
        expect(wakes()).toEqual([]);
        linkFor(key).draft = "";
        flushSync();
        await vi.advanceTimersByTimeAsync(WAKE_AFTER);
        expect(wakes()).toHaveLength(1);
      });

      it("is not woken once the user has stopped its turn", async () => {
        const { key, kid, handle: core } = await idle();
        fake.startTurn(core);
        fake.endTurn(core, "interrupted");
        flushSync();
        expect(byKey(key)!.turnEnd).toBe("cut");
        kid.working = false;
        flushSync();
        await vi.advanceTimersByTimeAsync(WAKE_AFTER * 4);
        expect(wakes()).toEqual([]);
        expect(unheard(byKey(key)!)).toEqual([kid]);
      });

      it("leaves what it was woken for untold when the message never reaches the agent", async () => {
        const { key, kid } = await idle();
        const core = (window as unknown as { __CHORD_CORE__: { integratedSend: unknown } }).__CHORD_CORE__;
        core.integratedSend = async () => {
          throw new Error("the session is gone");
        };
        kid.working = false;
        flushSync();
        await vi.advanceTimersByTimeAsync(WAKE_AFTER);
        await vi.advanceTimersByTimeAsync(0);
        flushSync();
        expect(unheard(byKey(key)!)).toEqual([kid]);
        expect(conductor.woken[key]).toBeUndefined();
        // Not tried again until a turn of its own has ended.
        await vi.advanceTimersByTimeAsync(WAKE_AFTER * 4);
        expect(Object.values(conversationOf(key).messages).filter((message) => message.state === "failed")).toHaveLength(1);
      });
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
      expect(answerTo(later)?.content).toBe(`Session kid-1 stopped working. It has left no line.\n${STOP_WHEN_DONE}`);
    });

    it("ends a wait it holds, so the user's message is not held behind it, and says what is still out", async () => {
      const { key, token } = await starter();
      const waiting = { ...call("wait", {}), session: token };
      const waited = handle(waiting);
      await settle();
      send(key, "Stop for a moment");
      await waited;
      expect(answerTo(waiting)?.content).toBe(USER_WROTE);
      // The answer to the user ends the turn, and no wait follows it.
      expect(USER_WROTE).toContain(
        "Answer it as the final message of your turn and end the turn there without calling wait again",
      );
      expect(sentTexts().at(-1)).toBe(
        `${REPORTS_HEAD}\nStill at work when the user wrote: kid-1. Answer the user as your turn's final message when there is something to tell them, and end the turn there; the workbench writes to you when one of them stops or asks.\n\nStop for a moment`,
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
    expect(answerTo(stopped)?.content).toBe(`Stopped session ${id}. It is off your list now, and not offered to resume.`);
    expect(byKey(key)).toBeNull();
    expect(forProject(A)).toHaveLength(0);
  });
});

describe("a name a start gave", () => {
  // Recorded: two sessions started with a name ran integrated, were closed
  // by the user and resumed by id in a terminal, where their rows and the
  // sessions tool named them by the first eight characters of their ids.
  it("stays the session's across a close and a resume by id in a terminal", async () => {
    setKind("claude-code", "integrated");
    const request = call("start", { project: A, prompt: "Read the brief and review", name: "Confirm review of send now" });
    const answering = handle(request);
    if (conductor.asking !== null) allow();
    await settle();
    const first = forProject(A).at(-1)!;
    await launch(first.key);
    flushSync();
    await answering;
    const id = byKey(first.key)!.id!;
    expect(label(byKey(first.key)!)).toBe("Confirm review of send now");

    close(first.key);
    setKind("claude-code", "terminal");
    const resuming = call("start", { session: id, prompt: "Go on" });
    const resumed = handle(resuming);
    await settle();
    const back = forProject(A).at(-1)!;
    expect(back.kind).toBe("terminal");
    started(back.key, "pty-back", id);
    flushSync();
    await resumed;
    expect(answerTo(resuming)?.content).toContain(`Resumed session ${id}`);
    // Claude Code titles its terminal with its own name alone until it has
    // a title of its own for the session.
    titled(back.key, "✳ Claude Code");
    expect(label(byKey(back.key)!)).toBe("Confirm review of send now");
    const listing = call("sessions");
    await handle(listing);
    expect(answerTo(listing)?.content).toContain(`${id}  "Confirm review of send now"`);
    // Its agent's own title is the better name while it has one.
    titled(back.key, "✳ send-now-review");
    expect(label(byKey(back.key)!)).toBe("send-now-review");
    titled(back.key, "Claude Code");
    expect(label(byKey(back.key)!)).toBe("Confirm review of send now");
  });

  it("names the session in what was said of it after the stop tool files it away", async () => {
    // Recorded: a session started with a name, in a worktree, was named by
    // its id in its starter's reports once the starter had stopped it.
    setKind("claude-code", "integrated");
    const request = call("start", { project: A, prompt: "Hold the clock still", name: "Fix the cache" });
    const answering = handle(request);
    if (conductor.asking !== null) allow();
    await settle();
    const row = forProject(A).at(-1)!;
    await launch(row.key);
    flushSync();
    await answering;
    const id = byKey(row.key)!.id!;
    expect(wakeShown(`${REPORTS_HEAD}\nSession ${id} stopped working. It has left no line.`, sessionName)).toBe(
      "Fix the cache stopped working. It has left no line.",
    );
    await handle(call("stop", { session: id }));
    expect(byKey(row.key)).toBeNull();
    expect(sessionName(id)).toBe("Fix the cache");
    expect(wakeShown(`${REPORTS_HEAD}\nSession ${id} stopped working. It has left no line.`, sessionName)).toBe(
      "Fix the cache stopped working. It has left no line.",
    );
  });

  it("is never one that reads as the user's or the workbench's, once the row has gone", () => {
    const row = create(A, null, "claude-code", null);
    started(row.key, "pty-you", "you-1");
    titled(row.key, "You");
    keepName(byKey(row.key)!);
    close(row.key);
    sessions.names["wb-1"] = "Workbench";
    conductor.started["token-x"] = [{ id: "you-2", project: A, worktree: null, agent: "claude-code", name: "you" }];
    for (const id of ["you-1", "wb-1", "you-2"]) expect(sessionName(id)).toBeNull();
    expect(wakeShown(`${REPORTS_HEAD}\nSession wb-1 stopped working. It has left no line.`, sessionName)).toBe(
      "A session stopped working. It has left no line.",
    );
  });

  it("is not replaced by the first words of a message to a resumed conversation", async () => {
    setKind("claude-code", "integrated");
    const request = call("start", { project: A, prompt: "Review it", name: "Confirm review" });
    const answering = handle(request);
    if (conductor.asking !== null) allow();
    await settle();
    const first = forProject(A).at(-1)!;
    await launch(first.key);
    flushSync();
    await answering;
    const id = byKey(first.key)!.id!;
    close(first.key);
    const resuming = call("start", { session: id, prompt: "The app was restarted; carry on" });
    const resumed = handle(resuming);
    await settle();
    const back = forProject(A).at(-1)!;
    expect(back.kind).toBe("integrated");
    await launch(back.key);
    flushSync();
    await resumed;
    expect(label(byKey(back.key)!)).toBe("Confirm review");
  });
});

describe("an orchestrator that runs integrated", () => {
  beforeEach(() => {
    resetWorkflows();
    setKind("claude-code", "integrated");
  });
  afterEach(() => resetWorkflows());

  /** A workflow's orchestrator, started integrated and running. */
  async function orchestrator(): Promise<Session> {
    const row = create(A, null, "claude-code", null, null, null, null, defaultWorkflow());
    expect(row.kind).toBe("integrated");
    await launch(row.key);
    return byKey(row.key)!;
  }

  const starts = () =>
    fake.calls.flatMap((made) => (made.method === "start" ? [made.options] : []));

  it("is started told its workflow, without its agent's own subagent tools", async () => {
    const row = await orchestrator();
    expect(row.status).toBe("running");
    const [options] = starts();
    expect(options).toMatchObject({
      agent: "claude-code",
      token: row.token,
      instructions: orchestratorPrompt(defaultWorkflow()),
      startOnly: true,
    });
    expect(options.afresh).toBeUndefined();
  });

  it("is held to its workflow, and a session it starts can start none of its own whatever it claims", async () => {
    const lead = await orchestrator();
    const as = (session: Session, tool: ConductRequest["tool"], args: Record<string, unknown>): ConductRequest => ({
      ...call(tool, args),
      session: session.token,
    });
    const bare = as(lead, "start", { project: A, prompt: "Fix the cache" });
    await handle(bare);
    expect(answerTo(bare)?.error).toContain('You follow the workflow "Build and review", so a start names the step it is for');

    const work = as(lead, "start", { project: A, prompt: "Fix the cache", step: "Work" });
    const answering = handle(work);
    if (conductor.asking !== null) allow();
    await settle();
    const worker = forProject(A).at(-1)!;
    expect(worker.key).not.toBe(lead.key);
    expect(worker.kind).toBe("integrated");
    await launch(worker.key);
    flushSync();
    await answering;
    expect(answerTo(work)?.error).toBeNull();
    // The worker follows no workflow, is told none and keeps its own tools.
    expect(byKey(worker.key)!.workflow).toBeNull();
    const told = starts().at(-1)!;
    expect(told.instructions).toBeUndefined();
    expect(told.startOnly).toBeUndefined();

    // What a session says of itself is not who it is: the worker's call
    // naming a step, the workflow and the orchestrator's role is refused.
    const claimed = as(worker, "start", {
      project: A,
      prompt: "Split it up",
      step: "Work",
      role: "orchestrator",
      workflow: "Build and review",
    });
    await handle(claimed);
    expect(answerTo(claimed)?.error).toBe("A session that another session started cannot start sessions of its own.");
    expect(forProject(A).filter((row) => row.status !== "exited").length).toBe(2);
  });

  it("resumed in place, is told the workflow as the settings have it now, afresh where it changed", async () => {
    const lead = await orchestrator();
    const id = lead.id!;
    fake.stop(handleOf(lead.key)!);
    await settle();
    expect(byKey(lead.key)!.status).toBe("exited");
    // Resumed with the workflow as it was, it is told the same again.
    await resume(lead.key);
    expect(starts().at(-1)).toMatchObject({
      session: id,
      instructions: orchestratorPrompt(defaultWorkflow()),
      startOnly: true,
    });
    expect(starts().at(-1)!.afresh).toBeUndefined();
    fake.stop(handleOf(lead.key)!);
    await settle();

    // The workflow changed in the settings since: it is told the new one,
    // and lets go of what its conversation was first told.
    const changed = { ...defaultWorkflow(), startOnly: false };
    adoptWorkflows({ list: [changed], default: "Build and review", overrides: {} });
    await resume(lead.key);
    expect(starts().at(-1)).toMatchObject({
      session: id,
      instructions: orchestratorPrompt(changed),
      startOnly: false,
      afresh: true,
    });
  });
});

