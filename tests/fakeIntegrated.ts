import type {
  IntegratedEvent,
  IntegratedEventBody,
  IntegratedFileChange,
  IntegratedImage,
  IntegratedStartOptions,
  IntegratedStarted,
  PermissionChoice,
} from "$lib/core";

/** A call the window made on an integrated session, as the fake kept it. */
export type IntegratedCall =
  | { method: "start"; options: IntegratedStartOptions; id: string }
  | { method: "send"; id: string; text: string; images: IntegratedImage[]; message: string }
  | { method: "interrupt"; id: string }
  | {
      method: "answer";
      id: string;
      request: string;
      choice: PermissionChoice;
      message: string | null;
    }
  | { method: "setModel"; id: string; model: string }
  | { method: "setPermissionMode"; id: string; mode: string }
  | { method: "stop"; id: string };

/** A scripted integrated session behind the seam, for the unit tests and
    the browser tests alike. The commands do what the core's do to a
    well-behaved agent: start says it is ready, a message starts a turn, an
    answer settles a request, a stop ends the session. What the agent says
    within a turn is the test's to script, through `emit` and the helpers
    built on it. */
export interface FakeIntegrated {
  /** Every call, in order. */
  calls: IntegratedCall[];
  start(options: IntegratedStartOptions): IntegratedStarted;
  send(id: string, text: string, images?: IntegratedImage[]): string;
  interrupt(id: string): void;
  answer(id: string, request: string, choice: PermissionChoice, message?: string): void;
  setModel(id: string, model: string): string | null;
  setPermissionMode(id: string, mode: string): string | null;
  stop(id: string): void;
  subscribe(handler: (event: IntegratedEvent) => void): () => void;
  /** Everything said so far, in order. */
  events: IntegratedEvent[];

  /** Says anything at all for a session. */
  emit(id: string, event: IntegratedEventBody): void;
  /** A whole turn: started (for the oldest message waiting, or by the
      agent), the text streamed in pieces and then whole, and ended. */
  turn(id: string, text: string, options?: { pieces?: number; parent?: string | null }): void;
  /** Asks a permission; returns the request's id. */
  ask(id: string, tool: string, input: unknown, options?: { rule?: string | null; path?: string | null }): string;
  /** A tool call from start to finish, with a file change if given. */
  tool(
    id: string,
    name: string,
    input: unknown,
    output: string,
    options?: { parent?: string | null; change?: IntegratedFileChange | null },
  ): string;
  /** The process ends by itself: cleanly, or not, with an error. */
  end(id: string, clean?: boolean): void;
}

/**
 * Builds the fake. Self-contained on purpose: the browser tests hand its
 * source to the page as it is, so it may refer to nothing outside itself.
 */
export function fakeIntegrated(): FakeIntegrated {
  type Session = {
    sessionId: string;
    model: string | null;
    mode: string | null;
    pending: string[];
    turn: boolean;
    asking: Set<string>;
    state: string | null;
    /** Ending: what is open closes without a state, as in the core. */
    closing: boolean;
    ended: boolean;
  };
  const sessions = new Map<string, Session>();
  const handlers = new Set<(event: IntegratedEvent) => void>();
  let count = 0;
  let messages = 0;
  let blocks = 0;
  let requests = 0;
  let calls = 0;

  const fake: FakeIntegrated = {
    calls: [],
    events: [],

    start(options) {
      const id = `int-${++count}`;
      const sessionId = options.session ?? `integrated-session-${count}`;
      sessions.set(id, {
        sessionId,
        model: options.model ?? null,
        mode: options.permissionMode ?? "default",
        pending: [],
        turn: false,
        asking: new Set(),
        state: null,
        closing: false,
        ended: false,
      });
      fake.calls.push({ method: "start", options, id });
      // After the caller has the id, as the core's own ready arrives.
      queueMicrotask(() => {
        const session = sessions.get(id)!;
        fake.emit(id, {
          type: "ready",
          sessionId,
          model: session.model,
          permissionMode: session.mode,
          version: "0.0.0-fake",
          models: [
            { value: "haiku", name: "Haiku", description: null },
            { value: "sonnet", name: "Sonnet", description: null },
          ],
          commands: [{ name: "compact", description: "Compact the conversation", hint: null }],
        });
      });
      return { id, sessionId };
    },

    send(id, text, images = []) {
      const session = live(id);
      const message = `message-${++messages}`;
      fake.calls.push({ method: "send", id, text, images, message });
      const queued = session.turn || session.pending.length > 0;
      session.pending.push(message);
      if (queued) fake.emit(id, { type: "messageQueued", message });
      settle(id);
      return message;
    },

    interrupt(id) {
      live(id);
      fake.calls.push({ method: "interrupt", id });
      const session = sessions.get(id)!;
      for (const request of [...session.asking])
        fake.emit(id, { type: "permissionWithdrawn", request });
      if (session.turn)
        fake.emit(id, {
          type: "turnEnded",
          outcome: "interrupted",
          error: null,
          costUsd: null,
          durationMs: null,
          usage: null,
        });
    },

    answer(id, request, choice, message) {
      const session = live(id);
      if (!session.asking.has(request))
        throw new Error("the agent is not waiting on that request");
      fake.calls.push({ method: "answer", id, request, choice, message: message ?? null });
      session.asking.delete(request);
      settle(id);
    },

    setModel(id, model) {
      const session = live(id);
      fake.calls.push({ method: "setModel", id, model });
      session.model = model;
      fake.emit(id, { type: "configured", model, permissionMode: session.mode });
      return model;
    },

    setPermissionMode(id, mode) {
      const session = live(id);
      fake.calls.push({ method: "setPermissionMode", id, mode });
      session.mode = mode;
      fake.emit(id, { type: "configured", model: session.model, permissionMode: mode });
      return mode;
    },

    stop(id) {
      live(id);
      fake.calls.push({ method: "stop", id });
      queueMicrotask(() => fake.end(id, true));
    },

    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    emit(id, body) {
      const session = sessions.get(id);
      if (!session || session.ended) return;
      // The bookkeeping the core's tracker keeps, so the fake's states and
      // turns say what the real ones would.
      if (body.type === "turnStarted") {
        if (session.turn) return;
        session.turn = true;
        body = { ...body, message: body.message ?? session.pending.shift() ?? null };
      }
      if (body.type === "turnEnded") session.turn = false;
      if (body.type === "permissionAsked") session.asking.add(body.request);
      if (body.type === "permissionWithdrawn") session.asking.delete(body.request);
      if (body.type === "ended") session.ended = true;
      const event = { ...body, id } as IntegratedEvent;
      fake.events.push(event);
      for (const handler of handlers) handler(event);
      if (body.type !== "state" && body.type !== "ended") settle(id);
    },

    turn(id, text, options = {}) {
      const parent = options.parent ?? null;
      if (parent === null) fake.emit(id, { type: "turnStarted", message: null });
      const block = `block-${++blocks}`;
      const pieces = Math.max(1, options.pieces ?? 3);
      const size = Math.ceil(text.length / pieces);
      for (let at = 0; at < text.length; at += size)
        fake.emit(id, { type: "text", block, parent, text: text.slice(at, at + size), done: false });
      fake.emit(id, { type: "text", block, parent, text, done: true });
      if (parent === null)
        fake.emit(id, {
          type: "turnEnded",
          outcome: "done",
          error: null,
          costUsd: 0.001,
          durationMs: 10,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        });
    },

    ask(id, tool, input, options = {}) {
      const request = `request-${++requests}`;
      const rule = options.rule === undefined ? `${tool}` : options.rule;
      fake.emit(id, {
        type: "permissionAsked",
        request,
        call: null,
        parent: null,
        tool,
        input,
        description: null,
        path: options.path ?? null,
        rule,
        choices: rule
          ? ["allowOnce", "allowSession", "allowProject", "deny"]
          : ["allowOnce", "allowSession", "deny"],
      });
      return request;
    },

    tool(id, name, input, output, options = {}) {
      const call = `call-${++calls}`;
      const parent = options.parent ?? null;
      fake.emit(id, { type: "toolStarted", call, parent, name });
      fake.emit(id, { type: "toolInput", call, parent, delta: null, input });
      fake.emit(id, {
        type: "toolFinished",
        call,
        parent,
        output,
        error: false,
        change: options.change ?? null,
      });
      return call;
    },

    end(id, clean = true) {
      const session = sessions.get(id);
      if (!session || session.ended) return;
      session.closing = true;
      if (session.turn)
        fake.emit(id, {
          type: "turnEnded",
          outcome: "failed",
          error: "the agent ended during the turn",
          costUsd: null,
          durationMs: null,
          usage: null,
        });
      for (const request of [...session.asking])
        fake.emit(id, { type: "permissionWithdrawn", request });
      if (!clean)
        fake.emit(id, { type: "error", kind: "process", message: "claude ended with code 1" });
      fake.emit(id, { type: "ended", code: clean ? 0 : 1, clean });
      sessions.delete(id);
    },
  };

  function live(id: string): Session {
    const session = sessions.get(id);
    if (!session || session.ended) throw new Error("no such session");
    return session;
  }

  /** Tells the state when it changed, as the core does. */
  function settle(id: string) {
    const session = sessions.get(id);
    if (!session || session.ended || session.closing) return;
    const state =
      session.asking.size > 0
        ? "asking"
        : session.turn || session.pending.length > 0
          ? "working"
          : "idle";
    if (state === session.state) return;
    session.state = state;
    fake.emit(id, { type: "state", state });
  }

  return fake;
}
