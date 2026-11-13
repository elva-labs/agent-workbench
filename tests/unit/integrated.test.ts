import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegratedEvent } from "$lib/core";
import { fakeIntegrated } from "../fakeIntegrated";

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

/** The real seam, talking to Tauri, which is mocked. */
async function tauri() {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  const { core } = await import("$lib/core");
  return core();
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  invoke.mockReset();
  listen.mockReset();
});

describe("the seam's integrated sessions", () => {
  it("call the core's commands by the names and arguments it takes", async () => {
    const seam = await tauri();
    invoke.mockResolvedValue(null);
    await seam.integratedStart({
      agent: "claude-code",
      project: "/repo",
      model: "haiku",
      permissionMode: "plan",
      configDir: "~/.claude-work",
    });
    await seam.integratedSend("int-1", "look", [{ mediaType: "image/png", data: "AAAA" }]);
    await seam.integratedSend("int-1", "again");
    await seam.integratedInterrupt("int-1");
    await seam.integratedAnswer("int-1", "r-1", "deny", "not that");
    await seam.integratedAnswer("int-1", "r-2", "allowSession");
    await seam.integratedSetModel("int-1", "sonnet");
    await seam.integratedSetPermissionMode("int-1", "acceptEdits");
    await seam.integratedStop("int-1");
    expect(invoke.mock.calls).toEqual([
      [
        "integrated_start",
        {
          agent: "claude-code",
          project: "/repo",
          model: "haiku",
          permissionMode: "plan",
          configDir: "~/.claude-work",
        },
      ],
      [
        "integrated_send",
        { id: "int-1", text: "look", images: [{ mediaType: "image/png", data: "AAAA" }] },
      ],
      ["integrated_send", { id: "int-1", text: "again", images: [] }],
      ["integrated_interrupt", { id: "int-1" }],
      [
        "integrated_answer",
        { id: "int-1", request: "r-1", choice: "deny", message: "not that" },
      ],
      [
        "integrated_answer",
        { id: "int-1", request: "r-2", choice: "allowSession", message: null },
      ],
      ["integrated_set_model", { id: "int-1", model: "sonnet" }],
      ["integrated_set_permission_mode", { id: "int-1", mode: "acceptEdits" }],
      ["integrated_stop", { id: "int-1" }],
    ]);
  });

  it("hear every session's news on one event", async () => {
    const seam = await tauri();
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const heard: IntegratedEvent[] = [];
    const off = await seam.onIntegratedEvent((event) => heard.push(event));
    expect(listen.mock.calls[0][0]).toBe("integrated_event");
    const deliver = listen.mock.calls[0][1] as (event: { payload: IntegratedEvent }) => void;
    deliver({ payload: { id: "int-1", type: "state", state: "working" } });
    expect(heard).toEqual([{ id: "int-1", type: "state", state: "working" }]);
    off();
    expect(unlisten).toHaveBeenCalled();
  });
});

describe("the scripted integrated session", () => {
  function started() {
    const fake = fakeIntegrated();
    const heard: IntegratedEvent[] = [];
    fake.subscribe((event) => heard.push(event));
    const { id } = fake.start({ agent: "claude-code", project: "/repo", model: "haiku" });
    return { fake, heard, id };
  }

  const kinds = (events: IntegratedEvent[]) => events.map((event) => event.type);
  const states = (events: IntegratedEvent[]) =>
    events.flatMap((event) => (event.type === "state" ? [event.state] : []));

  it("says it is ready once the caller has the id, and is idle", async () => {
    const { heard, id } = started();
    expect(heard).toEqual([]);
    await Promise.resolve();
    expect(kinds(heard)).toEqual(["ready", "state"]);
    expect(heard[0]).toMatchObject({ id, type: "ready", model: "haiku" });
    expect(states(heard)).toEqual(["idle"]);
  });

  it("plays a turn for the message it was sent", async () => {
    const { fake, heard, id } = started();
    await Promise.resolve();
    const message = fake.send(id, "hello");
    fake.turn(id, "hi there", { pieces: 2 });
    const turn = heard.find((event) => event.type === "turnStarted");
    expect(turn).toMatchObject({ message });
    const texts = heard.filter((event) => event.type === "text");
    expect(texts.map((event) => event.type === "text" && event.text)).toEqual([
      "hi t",
      "here",
      "hi there",
    ]);
    expect(states(heard)).toEqual(["idle", "working", "idle"]);
  });

  it("queues a message sent during a turn and gives it the next", async () => {
    const { fake, heard, id } = started();
    await Promise.resolve();
    fake.send(id, "first");
    fake.emit(id, { type: "turnStarted", message: null });
    const second = fake.send(id, "second");
    expect(heard.at(-1)).toMatchObject({ type: "messageQueued", message: second });
    fake.emit(id, {
      type: "turnEnded",
      outcome: "done",
      error: null,
      costUsd: null,
      durationMs: null,
      usage: null,
    });
    fake.turn(id, "for the second");
    const turns = heard.filter((event) => event.type === "turnStarted");
    expect(turns.at(-1)).toMatchObject({ message: second });
  });

  it("asks, and an answer settles what was asked", async () => {
    const { fake, heard, id } = started();
    await Promise.resolve();
    fake.send(id, "touch it");
    fake.emit(id, { type: "turnStarted", message: null });
    const request = fake.ask(id, "Bash", { command: "touch x" }, { rule: "Bash(touch x)" });
    expect(states(heard).at(-1)).toBe("asking");
    fake.answer(id, request, "allowProject");
    expect(states(heard).at(-1)).toBe("working");
    expect(fake.calls.at(-1)).toEqual({
      method: "answer",
      id,
      request,
      choice: "allowProject",
      message: null,
    });
    expect(() => fake.answer(id, request, "allowOnce")).toThrow();
  });

  it("ends a turn on an interrupt and withdraws what it asked", async () => {
    const { fake, heard, id } = started();
    await Promise.resolve();
    fake.send(id, "go");
    fake.emit(id, { type: "turnStarted", message: null });
    const request = fake.ask(id, "Bash", { command: "sleep 9" });
    fake.interrupt(id);
    expect(heard.slice(-4)).toMatchObject([
      { type: "permissionWithdrawn", request },
      { type: "state", state: "working" },
      { type: "turnEnded", outcome: "interrupted" },
      { type: "state", state: "idle" },
    ]);
  });

  it("changes model and mode, and ends when stopped", async () => {
    const { fake, heard, id } = started();
    await Promise.resolve();
    expect(fake.setModel(id, "sonnet")).toBe("sonnet");
    expect(fake.setPermissionMode(id, "plan")).toBe("plan");
    expect(heard.filter((event) => event.type === "configured").at(-1)).toMatchObject({
      model: "sonnet",
      permissionMode: "plan",
    });
    fake.stop(id);
    await Promise.resolve();
    expect(heard.at(-1)).toMatchObject({ type: "ended", clean: true });
    expect(() => fake.send(id, "anyone?")).toThrow();
  });

  it("fails a turn when the process dies in the middle of it", async () => {
    const { fake, heard, id } = started();
    await Promise.resolve();
    fake.send(id, "go");
    fake.emit(id, { type: "turnStarted", message: null });
    fake.end(id, false);
    expect(kinds(heard).slice(-3)).toEqual(["turnEnded", "error", "ended"]);
  });

  it("ties a subagent's messages to the call that started it", async () => {
    const { fake, heard, id } = started();
    await Promise.resolve();
    fake.send(id, "find it");
    fake.emit(id, { type: "turnStarted", message: null });
    const call = fake.tool(id, "Agent", { prompt: "find it" }, "launched");
    fake.tool(id, "Grep", { pattern: "x" }, "a.rs", { parent: call });
    fake.turn(id, "found it", { parent: call });
    const ofSubagent = heard.filter((event) => "parent" in event && event.parent === call);
    expect(kinds(ofSubagent)).toEqual([
      "toolStarted",
      "toolInput",
      "toolFinished",
      "text",
      "text",
      "text",
      "text",
    ]);
  });
});
