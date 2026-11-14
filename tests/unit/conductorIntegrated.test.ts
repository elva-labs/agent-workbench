import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSync } from "svelte";
import type { ConductRequest } from "$lib/core";
import { allow, conductor, handle, resetConductor, watchStops } from "$lib/conductor.svelte";
import { conversationOf, handleOf, launch, listenIntegrated, resetIntegrated } from "$lib/integrated.svelte";
import { byKey, create, forProject, reset as resetSessions, sessions } from "$lib/sessions.svelte";
import { resetSessionKinds, setKind } from "$lib/sessionKind.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { fakeIntegrated, type FakeIntegrated } from "../fakeIntegrated";

// The orchestrator's tools with a session that runs integrated: it is
// started, sent to, read, waited on and stopped as a terminal one is, with
// its state and words from the core's events.

const A = "/home/ada/dev/one";

let fake: FakeIntegrated;
let stop = () => {};
let unwatch = () => {};
const answers: { id: string; content: string | null; error: string | null }[] = [];
let calls = 0;

function call(tool: ConductRequest["tool"], args: Record<string, unknown> = {}): ConductRequest {
  return { id: `c${++calls}`, tool, arguments: args, cwd: A, session: null };
}

const answerTo = (request: ConductRequest) => answers.find((answer) => answer.id === request.id);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An integrated session the caller started, up and running. */
async function own() {
  const row = create(A, null, "claude-code", null, null, null, null, "integrated");
  conductor.startedBy[row.key] = A;
  await launch(row.key);
  return { key: row.key, id: byKey(row.key)!.id!, handle: handleOf(row.key)! };
}

beforeEach(async () => {
  resetSessions();
  resetIntegrated();
  resetConductor();
  resetWorkspace();
  resetSessionKinds();
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
    expect(sent?.text.startsWith("Scan the history")).toBe(true);
  });

  it("sends a message through the session's own send, whole, and says when it waits for the turn", async () => {
    const { id, handle: core } = await own();
    const first = call("send", { session: id, text: "Line one\nline two" });
    await handle(first);
    expect(answerTo(first)).toMatchObject({ error: null, content: `Sent to session ${id}. Call wait to hear what it does next.` });
    expect(fake.calls.find((made) => made.method === "send")).toMatchObject({ text: "Line one\nline two" });
    fake.startTurn(core);
    const second = call("send", { session: id, text: "and then this" });
    await handle(second);
    expect(answerTo(second)?.content).toContain("the message waits for its turn");
    expect(fake.events.findLast((event) => event.type === "message")).toMatchObject({ state: "queued" });
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
      `Session ${id}, what its agent last said and did:\nThe user said: Fix the scan\n- Ran npm test\nFixed.\nThe tests pass.`,
    );
    fake.startTurn(core);
    fake.ask(core, "Bash", { command: "rm -rf build" });
    const asking = call("read", { session: id, lines: 2 });
    await handle(asking);
    expect(answerTo(asking)?.content?.split("\n").at(-1)).toBe("It is waiting for the user to allow it to run rm -rf build.");
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
    expect(sessions.all).toHaveLength(0);
  });
});
