import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import type { ConductRequest } from "$lib/core";
import { conductor, handle, resetConductor, watchStops } from "$lib/conductor.svelte";
import {
  answer,
  configure,
  conversationOf,
  handleOf,
  launch,
  linkFor,
  listenIntegrated,
  resetIntegrated,
  send,
} from "$lib/integrated.svelte";
import {
  byKey,
  create,
  ended as endedTerminal,
  exact,
  launch as launchTerminal,
  reopened,
  reopenOtherWay,
  reset as resetSessions,
  sessions,
  started as startedTerminal,
  typed,
  wake,
  type Session,
} from "$lib/sessions.svelte";
import { adoptSessionKinds, resetSessionKinds, setKind } from "$lib/sessionKind.svelte";
import { applyDetect, resetAgent } from "$lib/agent.svelte";
import { hook, reset as resetHooks } from "$lib/hook.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";
import { reopen } from "$lib/reopen.svelte";
import { reset as resetWorkflows } from "$lib/workflows.svelte";
import { dueTo, followSetting, heldNow, holdOf, holdWords, REST_FOR, reopenEnds, resetMoves } from "$lib/sessionMoves.svelte";
import { closeSettings, openSettings } from "$lib/settings.svelte";
import { bringBack } from "$lib/sessions.svelte";
import { fakeIntegrated, type FakeIntegrated } from "../fakeIntegrated";

// Switching how an agent's sessions run moves the open sessions that follow
// the setting: each in its own row, once at rest and on screen, and never
// one at work, asking, or holding what its run would end with it.

const PROJECT = "/home/ada/dev/demo";

let fake: FakeIntegrated;
let stopListening = () => {};
let unfollow = () => {};
let unwatch = () => {};
const pty = { spawned: [] as { session?: string; agent?: string }[], written: [] as [string, string][], killed: [] as string[] };
const answers: { id: string; content: string | null; error: string | null }[] = [];

function detect(id: "claude-code" | "codex") {
  applyDetect(
    { id, path: `/usr/local/bin/${id}`, caps: { resumable: true, titles: true, acp: false, integrated: true }, fromLoginShell: true },
    true,
  );
}

/** The time to pass for a row at rest on screen to move, and what it then
    sets going. */
async function rest(ms = REST_FOR) {
  flushSync();
  await vi.advanceTimersByTimeAsync(ms);
  flushSync();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
}

const stops = () => fake.calls.filter((call) => call.method === "stop").map((call) => (call as { id: string }).id);

/** A conversation, spoken to and answered, so it rests. */
async function conversation(id: string | null = null): Promise<Session> {
  const row = create(PROJECT, id, "claude-code", null, null, null, null);
  await launch(row.key);
  send(row.key, "Look at the cache");
  fake.turn(handleOf(row.key)!, "Done.");
  return byKey(row.key)!;
}

/** A terminal session of a conversation, its process up. */
function terminal(id: string, agent: "claude-code" | "codex" = "claude-code"): Session {
  const row = create(PROJECT, id, agent, null, null, null, null);
  startedTerminal(row.key, `pty-${id}`, id);
  return byKey(row.key)!;
}

beforeEach(async () => {
  vi.useFakeTimers();
  resetSessions();
  resetIntegrated();
  resetConductor();
  resetSessionKinds();
  resetAgent();
  resetHooks();
  resetWorkspace();
  // The window has the workflows, so a resumed row finds out what it
  // follows as it starts.
  resetWorkflows();
  resetMoves();
  closeSettings();
  localStorage.clear();
  detect("claude-code");
  adoptSessionKinds(["claude-code"]);
  hook.installed[PROJECT] = true;
  pty.spawned = [];
  pty.written = [];
  pty.killed = [];
  answers.length = 0;
  fake = fakeIntegrated();
  const presses = new Map<string, number>();
  (window as unknown as { __WORKBENCH_CORE__: unknown }).__WORKBENCH_CORE__ = {
    integratedStart: async (options: Parameters<FakeIntegrated["start"]>[0]) => fake.start(options),
    integratedSend: async (id: string, message: string, text: string) => fake.send(id, message, text),
    integratedStop: async (id: string) => fake.stop(id),
    integratedAnswer: async (id: string, request: string, choice: never, message?: string) =>
      fake.answer(id, request, choice, message),
    integratedHistory: async (options: Parameters<FakeIntegrated["history"]>[0]) => fake.history(options),
    integratedHeld: async (options: Parameters<FakeIntegrated["held"]>[0]) => fake.held(options),
    integratedConfigure: async (id: string, settings: never) => fake.configure(id, settings),
    onIntegratedEvent: async (handler: Parameters<FakeIntegrated["subscribe"]>[0]) => fake.subscribe(handler),
    conductAnswer: async (id: string, _cwd: string, content: string | null, error: string | null) => {
      answers.push({ id, content, error });
    },
    projectInfo: async (path: string) => ({ path, name: "demo", repository: path, isGit: true }),
    transcriptsMany: async (projects: string[]) => projects.map(() => []),
    setWindowTitle: async () => {},
    spawn: async (options: { session?: string; agent?: string }) => {
      pty.spawned.push(options);
      return { ptyId: `pty-up-${pty.spawned.length}`, sessionId: options.session ?? null };
    },
    // Claude Code quits on the second Ctrl+C at its prompt.
    write: async (id: string, data: string) => {
      pty.written.push([id, data]);
      if (data !== "\x03") return;
      const pressed = (presses.get(id) ?? 0) + 1;
      presses.set(id, pressed);
      if (pressed === 2) queueMicrotask(() => endedTerminal({ id, code: 0, clean: true }));
    },
    kill: async (id: string) => {
      pty.killed.push(id);
      queueMicrotask(() => endedTerminal({ id, code: 129, clean: false }));
    },
  };
  stopListening = await listenIntegrated();
  unwatch = watchStops();
  unfollow = followSetting();
});

afterEach(() => {
  unfollow();
  unwatch();
  stopListening();
  vi.useRealTimers();
  delete (window as unknown as { __WORKBENCH_CORE__?: unknown }).__WORKBENCH_CORE__;
});

describe("switching how an agent's sessions run", () => {
  it("moves a conversation at rest on screen to a terminal in its own row, keeping its place, name, token and read state", async () => {
    const other = await conversation();
    const row = await conversation();
    const { key, token, id, changedAt, ordinal } = row;
    const h = handleOf(key);
    row.unread = true;
    row.title = "Fix the cache";
    setKind("claude-code", "terminal");
    await rest();
    expect(stops()).toEqual([h]);
    const now = byKey(key)!;
    expect(now).toMatchObject({ kind: "terminal", status: "starting", resumedFrom: id, token, ordinal, changedAt, unread: true, ownWay: false });
    expect(now.title).toBe("Fix the cache");
    await launchTerminal(key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).toMatchObject({ session: id });
    expect(byKey(key)).toMatchObject({ status: "running", changedAt });
    // The one not on screen goes on as it was until it is shown.
    expect(byKey(other.key)).toMatchObject({ kind: "integrated", status: "running" });
    expect(handleOf(other.key)).not.toBeNull();
    sessions.active = other.key;
    await rest();
    expect(byKey(other.key)).toMatchObject({ kind: "terminal", status: "starting", ownWay: false });
    expect(sessions.all).toHaveLength(2);
  });

  it("moves a terminal session at rest to a conversation, quitting it as the user would", async () => {
    setKind("claude-code", "terminal");
    const row = terminal("conversation-1");
    exact("conversation-1", "prompt");
    exact("conversation-1", "stop");
    setKind("claude-code", "integrated");
    await rest();
    // A press at a time, until it quits.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pty.written.filter(([id, data]) => id === "pty-conversation-1" && data === "\x03")).toHaveLength(2);
    expect(pty.killed).toEqual([]);
    expect(byKey(row.key)).toMatchObject({ kind: "integrated", status: "starting", resumedFrom: "conversation-1", ownWay: false });
    await launch(row.key);
    expect(fake.calls.find((call) => call.method === "start")).toMatchObject({ options: { session: "conversation-1", token: row.token } });
  });

  it("starts a conversation nothing was said in afresh the other way, in the mode chosen on its chip", async () => {
    const row = create(PROJECT, null, "claude-code", null, null, null, null);
    await launch(row.key);
    await configure(row.key, { mode: "plan" });
    setKind("claude-code", "terminal");
    await rest();
    // Its agent has no record of it to resume.
    expect(byKey(row.key)).toMatchObject({ kind: "terminal", status: "starting", resumedFrom: null, title: null });
    await launchTerminal(row.key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).toMatchObject({ mode: "plan" });
    expect(pty.spawned.at(-1)!.session).toBeUndefined();
  });

  it("moves the row on screen once the settings close over it, and one opened after the switch at once", async () => {
    const away = await conversation();
    const row = await conversation();
    openSettings();
    setKind("claude-code", "terminal");
    await rest(REST_FOR * 3);
    // Nothing is looked at under the settings.
    expect(byKey(row.key)!.kind).toBe("integrated");
    expect(byKey(away.key)!.kind).toBe("integrated");
    closeSettings();
    await rest(0);
    expect(byKey(row.key)!.kind).toBe("terminal");
    // At rest out of sight all along, it moves the moment it is opened.
    sessions.active = away.key;
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(byKey(away.key)!.kind).toBe("terminal");
  });

  it("does not move a row that comes to rest while it is looked at, until it is shown again", async () => {
    const row = await conversation();
    const h = handleOf(row.key)!;
    setKind("claude-code", "terminal");
    flushSync();
    send(row.key, "One more thing");
    fake.startTurn(h);
    flushSync();
    fake.turn(h, "Done too.");
    fake.emit(h, { type: "state", state: "idle" });
    await rest(REST_FOR * 5);
    expect(byKey(row.key)!.kind).toBe("integrated");
    expect(holdWords(byKey(row.key)!)).toEqual({
      line: "Moves to a terminal next time",
      short: "next time",
      full: "It came to rest while you were looking at it, so it moves the next time you come to it. Reopen it in a terminal from its menu to move it now.",
    });
    sessions.active = null;
    flushSync();
    sessions.active = row.key;
    await rest(0);
    expect(byKey(row.key)!.kind).toBe("terminal");
  });

  it("leaves a conversation held at a point it went back to, until a message is sent from there, and says so", async () => {
    const seam = (window as unknown as { __WORKBENCH_CORE__: Record<string, unknown> }).__WORKBENCH_CORE__;
    const asked: unknown[] = [];
    let held = true;
    seam.integratedHeld = async (options: unknown) => {
      asked.push(options);
      return held;
    };
    const row = await conversation();
    expect(await heldNow(byKey(row.key)!)).toBe(true);
    asked.length = 0;
    setKind("claude-code", "terminal");
    await rest(REST_FOR * 3);
    expect(asked).toEqual([{ agent: "claude-code", project: PROJECT, session: row.id }]);
    expect(stops()).toEqual([]);
    expect(holdWords(byKey(row.key)!)).toEqual({
      line: "Stays a conversation: it went back, and a terminal would bring back what was gone back on",
      short: "stays",
      full: "It went back to an earlier message, which Claude Code's terminal does not take: opened there, it would bring back what was gone back on. It moves once a message is sent from here. Reopen it in a terminal from its menu to move it anyway.",
    });
    // A message sent from there lets it go; a turn's stream asks nothing.
    held = false;
    send(row.key, "Carry on from here");
    const h = handleOf(row.key)!;
    fake.startTurn(h);
    for (const block of ["b-1", "b-2", "b-3"])
      fake.emit(h, { type: "text", block, parent: null, text: "Carrying on", done: true });
    await rest(REST_FOR * 3);
    expect(asked).toHaveLength(1);
    fake.endTurn(h);
    fake.emit(h, { type: "state", state: "idle" });
    await rest(REST_FOR * 3);
    expect(asked).toHaveLength(2);
    // It was held while it was looked at, so it moves when next shown.
    expect(holdWords(byKey(row.key)!)?.line).toBe("Moves to a terminal next time");
    sessions.active = null;
    flushSync();
    sessions.active = row.key;
    await rest(0);
    expect(byKey(row.key)!.kind).toBe("terminal");
  });

  it("asks a core without going back nothing, and holds none of its conversations", async () => {
    const row = await conversation();
    expect(await heldNow(byKey(row.key)!)).toBe(false);
    setKind("claude-code", "terminal");
    await rest();
    expect(byKey(row.key)!.kind).toBe("terminal");
  });

  it("starts a terminal that brings back what the conversation went back on only once the user agreed, and once", async () => {
    const row = await conversation();
    bringBack(row.key);
    const reopening = reopenOtherWay(row.key);
    await vi.advanceTimersByTimeAsync(0);
    expect(await reopening).toBe(true);
    await launchTerminal(row.key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).toMatchObject({ session: row.id, bringBack: true });
    const back = reopenOtherWay(row.key);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await back).toBe(true);
    await launch(row.key);
    const again = reopenOtherWay(row.key);
    await vi.advanceTimersByTimeAsync(0);
    expect(await again).toBe(true);
    await launchTerminal(row.key, 80, 24, () => {});
    expect(pty.spawned.at(-1)).not.toHaveProperty("bringBack");
  });

  it("turns a row left from the last quit at once, starting nothing", async () => {
    const row = reopened(PROJECT, "conversation-9", "claude-code", null, null, null, "integrated");
    const changedAt = row.changedAt;
    setKind("claude-code", "terminal");
    flushSync();
    expect(byKey(row.key)).toMatchObject({ kind: "terminal", status: "dormant", changedAt, ownWay: false });
    expect(fake.calls.filter((call) => call.method === "start")).toEqual([]);
    expect(pty.spawned).toEqual([]);
  });

  it("never cuts a conversation short: at work, asking, with messages waiting, with subagents at work, or being written to", async () => {
    const row = await conversation();
    const h = handleOf(row.key)!;
    const link = linkFor(row.key);
    const held = () => holdOf(byKey(row.key)!);
    setKind("claude-code", "terminal");
    flushSync();

    fake.send(h, crypto.randomUUID(), "Go");
    fake.startTurn(h);
    expect(held()).toMatchObject({ kind: "busy" });
    await rest(REST_FOR * 3);
    expect(byKey(row.key)!.kind).toBe("integrated");
    fake.question(h, [{ header: null, question: "Which?", options: [], multiple: false }]);
    expect(held()).toMatchObject({ kind: "busy", why: "asking" });
    fake.expire(h, conversationOf(row.key).open[0].request);
    fake.endTurn(h);
    fake.emit(h, { type: "state", state: "idle" });
    flushSync();
    // At rest, the core is asked whether the conversation went back first.
    expect(held()).toMatchObject({ kind: "busy", why: "checking" });
    await rest(0);
    expect(held()).toBeNull();

    const waiting = crypto.randomUUID();
    conversationOf(row.key).sending(waiting, "Then this", []);
    expect(held()).toMatchObject({ kind: "busy", why: "messages waiting" });
    conversationOf(row.key).forget(waiting);

    const task = fake.task(h, null, { kind: "agent", background: true, description: "Explore the cache" });
    expect(held()).toMatchObject({ kind: "busy" });
    fake.finishTask(h, task, "completed", "done", { reports: false });
    fake.emit(h, { type: "state", state: "idle" });
    await rest(0);
    expect(held()).toBeNull();

    link.draft = "Half a thought";
    expect(held()).toMatchObject({ kind: "busy", why: "being written to" });
    await rest(REST_FOR * 3);
    expect(byKey(row.key)!.kind).toBe("integrated");
    link.draft = "";
    await rest(REST_FOR * 3);
    // It was at work while it was looked at, so it waits to be shown again
    // rather than moving under the reader.
    expect(byKey(row.key)!.kind).toBe("integrated");
    expect(holdWords(byKey(row.key)!)?.line).toBe("Moves to a terminal next time");
    sessions.active = null;
    flushSync();
    sessions.active = row.key;
    await rest(0);
    expect(byKey(row.key)!.kind).toBe("terminal");
  });

  it("never cuts a terminal session short: at work, asking, delegating or with words on its line", async () => {
    setKind("claude-code", "terminal");
    const row = terminal("conversation-1");
    const held = () => holdOf(byKey(row.key)!);
    setKind("claude-code", "integrated");
    exact("conversation-1", "prompt");
    expect(held()).toMatchObject({ kind: "busy", why: "working" });
    exact("conversation-1", "permission");
    expect(held()).toMatchObject({ kind: "busy", why: "working" });
    exact("conversation-1", "delegated");
    expect(held()).toMatchObject({ kind: "busy", why: "working" });
    await rest(REST_FOR * 3);
    expect(pty.written).toEqual([]);
    exact("conversation-1", "stop");
    typed("pty-conversation-1", "half");
    expect(held()).toMatchObject({ kind: "busy", why: "being written to" });
    await rest(REST_FOR * 3);
    expect(pty.written).toEqual([]);
    expect(byKey(row.key)!.kind).toBe("terminal");
  });

  it("waits for a command in the background to end, saying so, and leaves one with a permission allowed for its run alone", async () => {
    const second = await conversation();
    const row = await conversation();
    const h = handleOf(row.key)!;
    const task = fake.task(h, null, { kind: "shell", background: true, description: "npm run dev" });
    setKind("claude-code", "terminal");
    await rest(REST_FOR * 3);
    expect(byKey(row.key)!.kind).toBe("integrated");
    expect(holdWords(byKey(row.key)!)).toEqual({
      line: "Moves to a terminal when npm run dev ends",
      short: "waits",
      full: "Moving it now ends npm run dev. Reopen it in a terminal from its menu to move it now.",
    });
    // The command ends while it is looked at: it moves next time it is
    // shown, and says so.
    fake.finishTask(h, task, "completed", "stopped");
    fake.emit(h, { type: "state", state: "idle" });
    await rest(REST_FOR * 3);
    expect(byKey(row.key)!.kind).toBe("integrated");
    expect(holdWords(byKey(row.key)!)?.line).toBe("Moves to a terminal next time");
    sessions.active = null;
    flushSync();
    expect(holdWords(byKey(row.key)!)).toBeNull();
    sessions.active = row.key;
    await rest(0);
    expect(byKey(row.key)!.kind).toBe("terminal");
    sessions.active = null;
    flushSync();

    // A rule allowed for the session is lost with the run; a permission
    // mode allowed so goes on with the conversation's mode.
    const h2 = handleOf(second.key)!;
    const rule = fake.ask(h2, "Bash", { command: "npm test" }, { session: "Bash(npm test) for the rest of this session" });
    answer(second.key, rule, "allowSession");
    await vi.advanceTimersByTimeAsync(0);
    const mode = fake.ask(h2, "Write", { file_path: "a.ts" }, { session: "the acceptEdits permission mode for the rest of this session" });
    answer(second.key, mode, "allowSession");
    await vi.advanceTimersByTimeAsync(0);
    expect(reopenEnds(byKey(second.key)!)).toEqual(["Bash(npm test)"]);
    expect(holdOf(byKey(second.key)!)).toEqual({ kind: "stays", why: "ends", ends: ["Bash(npm test)"] });
    expect(holdWords(byKey(second.key)!)?.line).toBe("Stays a conversation: moving ends Bash(npm test)");
    // Moved by hand, the next run holds none of it.
    expect(await reopenOtherWay(second.key)).toBe(true);
    expect(byKey(second.key)!.ownWay).toBe(false);
  });

  it("leaves a terminal session with a command in the background, and one whose rest it cannot tell, saying why", async () => {
    setKind("claude-code", "terminal");
    const serving = terminal("conversation-1");
    exact("conversation-1", "prompt");
    exact("conversation-1", "stop", null, false, { background: ["npm run dev"] });
    const unhooked = terminal("conversation-2");
    hook.installed[PROJECT] = false;
    setKind("claude-code", "integrated");
    expect(holdWords(byKey(serving.key)!)?.line).toBe("Moves to a conversation when npm run dev ends");
    expect(holdWords(byKey(unhooked.key)!)).toEqual({
      line: "Stays in a terminal: live updates are off",
      short: "stays",
      full: "Live updates are off for this project, so the workbench cannot tell when this session is idle. Reopen it as a conversation from its menu when it is.",
    });
    await rest(REST_FOR * 3);
    sessions.active = serving.key;
    await rest(REST_FOR * 3);
    expect(pty.written).toEqual([]);
    // Codex's turns are read from its own log, hooks or not.
    detect("codex");
    adoptSessionKinds(["claude-code"]);
    setKind("codex", "terminal");
    const codex = terminal("thread-1", "codex");
    setKind("codex", "integrated");
    expect(holdOf(byKey(codex.key)!)).toBeNull();
  });

  it("leaves a session started or reopened the other way by hand, until it is reopened back", async () => {
    setKind("claude-code", "terminal");
    const picked = create(PROJECT, null, "claude-code", null, null, null, null, undefined, "integrated");
    expect(picked.ownWay).toBe(true);
    const plain = terminal("conversation-1");
    expect(plain.ownWay).toBe(false);
    const reopening = reopenOtherWay(plain.key);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await reopening).toBe(true);
    expect(byKey(plain.key)).toMatchObject({ kind: "integrated", ownWay: true });
    await launch(plain.key);
    setKind("claude-code", "integrated");
    setKind("claude-code", "terminal");
    await rest(REST_FOR * 3);
    expect(byKey(plain.key)).toMatchObject({ kind: "integrated", status: "running" });
    expect(dueTo(byKey(plain.key)!)).toBeNull();
    // Reopened back to the setting's way, it follows the setting again.
    const back = reopenOtherWay(plain.key);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await back).toBe(true);
    expect(byKey(plain.key)).toMatchObject({ kind: "terminal", ownWay: false });
  });

  it("moves nothing before the setting and the agent are known, and nothing that has ended", async () => {
    const row = await conversation();
    resetSessionKinds();
    setKind("claude-code", "terminal");
    resetSessionKinds();
    expect(dueTo(byKey(row.key)!)).toBeNull();
    adoptSessionKinds([]);
    expect(dueTo(byKey(row.key)!)).toBe("terminal");
    resetAgent();
    expect(dueTo(byKey(row.key)!)).toBeNull();
    detect("claude-code");
    fake.end(handleOf(row.key)!);
    flushSync();
    expect(byKey(row.key)!.status).toBe("exited");
    expect(dueTo(byKey(row.key)!)).toBeNull();
  });

  it("keeps a session's own way across a quit, and turns the rest to the setting", async () => {
    workspace.open.push({ path: PROJECT, name: "demo", repository: PROJECT, isGit: true });
    localStorage.setItem(
      "workbench.open",
      JSON.stringify({
        open: [
          { project: PROJECT, id: "conversation-1", agent: "claude-code", startIn: null, model: null, kind: "integrated", own: true },
          { project: PROJECT, id: "conversation-2", agent: "claude-code", startIn: null, model: null, kind: "integrated" },
        ],
        active: null,
      }),
    );
    adoptSessionKinds([]);
    const stop = reopen();
    flushSync();
    const [own, follows] = ["conversation-1", "conversation-2"].map((id) => sessions.all.find((one) => one.id === id)!);
    expect(own).toMatchObject({ kind: "integrated", ownWay: true, status: "dormant" });
    expect(follows).toMatchObject({ kind: "terminal", ownWay: false, status: "dormant" });
    const kept = JSON.parse(localStorage.getItem("workbench.open")!) as { open: { id: string; own?: boolean }[] };
    expect(kept.open.map((entry) => [entry.id, entry.own])).toEqual([
      ["conversation-1", true],
      ["conversation-2", undefined],
    ]);
    stop();
  });

  it("keeps a move not yet made on record, and starts the row that way after a restart before the setting is known", async () => {
    workspace.open.push({ path: PROJECT, name: "demo", repository: PROJECT, isGit: true });
    const stop = reopen();
    const row = await conversation();
    const h = handleOf(row.key)!;
    fake.send(h, crypto.randomUUID(), "Keep going");
    fake.startTurn(h);
    setKind("claude-code", "terminal");
    flushSync();
    // At work, so not moved: on record as due to.
    const kept = JSON.parse(localStorage.getItem("workbench.open")!) as { open: { id: string; kind: string; moves?: string }[] };
    expect(kept.open).toMatchObject([{ id: row.id, kind: "integrated", moves: "terminal" }]);
    stop();

    // The app starts again, with a core that runs nothing from before:
    // the setting and the agent are not known yet when the row on screen
    // wakes.
    resetSessions();
    resetIntegrated();
    resetSessionKinds();
    resetAgent();
    stopListening();
    fake = fakeIntegrated();
    stopListening = await listenIntegrated();
    const again = reopen();
    flushSync();
    const back = sessions.all.find((one) => one.id === row.id)!;
    expect(back).toMatchObject({ kind: "integrated", status: "dormant" });
    // The run it had is not there to take up.
    await vi.waitFor(() => expect(linkFor(back.key).busy).toBe(false));
    wake(back.key);
    expect(byKey(back.key)).toMatchObject({ kind: "terminal", status: "starting", resumedFrom: row.id, ownWay: false });
    again();
  });
});

describe("a session another started, moved by the setting", () => {
  /** The starter: a terminal session whose tools name it by its token. */
  function starter(): Session {
    const looking = sessions.active;
    const row = create("/home/ada/dev/lead", "planner", "claude-code", null, null, null, null);
    startedTerminal(row.key, "pty-planner", "planner");
    sessions.active = looking;
    return byKey(row.key)!;
  }

  let calls = 0;
  const call = (lead: Session, tool: ConductRequest["tool"], args: Record<string, unknown>): ConductRequest => ({
    id: `c${++calls}`,
    tool,
    arguments: args,
    cwd: "/home/ada/dev/lead",
    session: lead.token,
  });
  const answerTo = (request: ConductRequest) => answers.find((one) => one.id === request.id);

  it("is not moved while its starter waits on it, and its starter hears no end of it", async () => {
    const lead = starter();
    const kid = await conversation();
    conductor.startedBy[kid.key] = lead.token;
    const h = handleOf(kid.key)!;
    fake.send(h, crypto.randomUUID(), "Fix it");
    fake.startTurn(h);
    // The user is in the session that started it.
    sessions.active = lead.key;
    setKind("claude-code", "terminal");
    const waiting = call(lead, "wait", { session: kid.id, seconds: 30 });
    const answered = handle(waiting);
    await rest();
    // At rest while the wait still holds it, then heard of.
    fake.turn(h, "Fixed.");
    fake.emit(h, { type: "state", state: "idle" });
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    await answered;
    expect(answerTo(waiting)?.content).toContain("stopped working");
    // A second wait, held through the move: it hears neither an end nor a
    // stop, only that nothing happened.
    const again = call(lead, "wait", { session: kid.id, seconds: 5 });
    const second = handle(again);
    await rest();
    expect(byKey(kid.key)!.kind).toBe("integrated");
    await vi.advanceTimersByTimeAsync(6_000);
    await second;
    expect(answerTo(again)?.content).toContain("Nothing happened");
    expect(byKey(kid.key)!.kind).toBe("integrated");
    // Shown once the wait is over, it moves.
    sessions.active = kid.key;
    await rest();
    expect(byKey(kid.key)).toMatchObject({ kind: "terminal", status: "starting" });
    const third = call(lead, "wait", { session: kid.id, seconds: 5 });
    const thirdAnswer = handle(third);
    await launchTerminal(kid.key, 80, 24, () => {});
    await vi.advanceTimersByTimeAsync(6_000);
    await thirdAnswer;
    expect(answerTo(third)?.content).toContain("Nothing happened");
    expect(conductor.startedBy[kid.key]).toBe(lead.token);
  });

  it("takes a line sent while it moves in its next run", async () => {
    const lead = starter();
    const kid = await conversation();
    conductor.startedBy[kid.key] = lead.token;
    setKind("claude-code", "terminal");
    flushSync();
    // The move has begun: its conversation is being stopped.
    await vi.advanceTimersByTimeAsync(REST_FOR);
    flushSync();
    const sending = call(lead, "send", { session: kid.id, text: "And the docs" });
    const sent = handle(sending);
    await vi.advanceTimersByTimeAsync(0);
    expect(byKey(kid.key)!.kind).toBe("terminal");
    await launchTerminal(kid.key, 80, 24, () => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await sent;
    expect(answerTo(sending)?.content).toContain(`Sent to session ${kid.id}`);
    expect(pty.written.some(([id, data]) => id === byKey(kid.key)!.ptyId && data.includes("And the docs"))).toBe(true);
  });
});
