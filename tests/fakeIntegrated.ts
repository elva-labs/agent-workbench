import type {
  IntegratedEvent,
  IntegratedEventBody,
  IntegratedFileChange,
  IntegratedImage,
  IntegratedPlanStep,
  IntegratedQuestion,
  IntegratedSettings,
  IntegratedStartOptions,
  IntegratedStarted,
  IntegratedToolKind,
  IntegratedTrustOptions,
  PermissionChoice,
  PermissionOffer,
} from "$lib/core";

/** A call the window made on an integrated session, as the fake kept it. */
export type IntegratedCall =
  | { method: "start"; options: IntegratedStartOptions; id: string }
  | { method: "trust"; options: IntegratedTrustOptions }
  | { method: "send"; id: string; message: string; text: string; images: IntegratedImage[] }
  | { method: "interrupt"; id: string }
  | {
      method: "answer";
      id: string;
      request: string;
      choice: PermissionChoice;
      message: string | null;
    }
  | { method: "reply"; id: string; request: string; answers: string[][] | null }
  | {
      method: "configure";
      id: string;
      settings: { model?: string; mode?: string; effort?: string };
    }
  | { method: "stop"; id: string };

/** A scripted integrated session behind the seam, for the unit tests and
    the browser tests alike. The commands check what the core checks and
    the events follow the core's rules: messages are pending until a turn
    names them, the state is derived from the events, tool calls left open
    close when their turn or subagent ends, and a subagent that finishes
    outside a turn keeps the session working until its report's turn ends.
    `ready` goes out before `start` returns, as it may from the core, and
    an interrupt's end of turn comes after the call. What the agent says
    within a turn is the test's to script, through `emit` and the helpers
    built on it. */
export interface FakeIntegrated {
  /** Every call, in order. */
  calls: IntegratedCall[];
  /** Everything said so far, in order. */
  events: IntegratedEvent[];
  /** Folders a start refuses until they are trusted. */
  untrusted: Set<string>;

  start(options: IntegratedStartOptions): IntegratedStarted;
  trust(options: IntegratedTrustOptions): void;
  send(id: string, message: string, text: string, images?: IntegratedImage[]): void;
  interrupt(id: string): void;
  answer(id: string, request: string, choice: PermissionChoice, message?: string): void;
  reply(id: string, request: string, answers: string[][] | null): void;
  configure(
    id: string,
    settings: { model?: string; mode?: string; effort?: string },
  ): IntegratedSettings;
  stop(id: string): void;
  subscribe(handler: (event: IntegratedEvent) => void): () => void;

  /** Says anything at all for a session, under the core's rules. */
  emit(id: string, event: IntegratedEventBody): void;
  /** Starts a turn for `messages`, all those waiting when not given. */
  startTurn(id: string, messages?: string[]): void;
  /** Ends the running turn. */
  endTurn(id: string, outcome?: "done" | "interrupted" | "failed", error?: string): void;
  /** A whole turn: started for the messages waiting (or by the agent),
      the text streamed in pieces and then whole, and ended. With a
      `parent`, only the subagent's text, with no turn of its own. */
  turn(
    id: string,
    text: string,
    options?: { pieces?: number; parent?: string | null; messages?: string[] },
  ): void;
  /** A block of thinking, streamed then whole. */
  think(id: string, text: string, options?: { parent?: string | null }): void;
  /** Asks a permission; returns the request's id. Session and always are
      offered only with what they remember. */
  ask(
    id: string,
    tool: string,
    input: unknown,
    options?: {
      session?: string | null;
      always?: string | null;
      path?: string | null;
      call?: string | null;
    },
  ): string;
  /** Asks questions; returns the request's id. */
  question(id: string, questions: IntegratedQuestion[]): string;
  /** A tool call started; returns its id. */
  startTool(
    id: string,
    name: string,
    input: unknown,
    options?: { parent?: string | null; kind?: IntegratedToolKind },
  ): string;
  /** A started tool call finished. */
  finishTool(
    id: string,
    call: string,
    output: string,
    options?: { error?: boolean; changes?: IntegratedFileChange[] },
  ): void;
  /** A tool call from start to finish; returns its id. */
  tool(
    id: string,
    name: string,
    input: unknown,
    output: string,
    options?: {
      parent?: string | null;
      kind?: IntegratedToolKind;
      changes?: IntegratedFileChange[];
    },
  ): string;
  /** A subagent or background task started by a call; returns its id. */
  task(
    id: string,
    call: string | null,
    options?: { kind?: "agent" | "shell" | "other"; background?: boolean; description?: string },
  ): string;
  /** A task ended. */
  finishTask(
    id: string,
    task: string,
    status?: "completed" | "failed" | "stopped" | "lost",
    summary?: string,
  ): void;
  /** The plan, whole. */
  plan(id: string, steps: IntegratedPlanStep[], text?: string | null): void;
  /** Compacting, start to finish, with no turn of its own. */
  compact(id: string): void;
  /** The process ends by itself: cleanly, or not, with an error. */
  end(id: string, clean?: boolean): void;
}

/**
 * Builds the fake. Self-contained on purpose: the browser tests hand its
 * source to the page as it is, so it may refer to nothing outside itself.
 */
export function fakeIntegrated(): FakeIntegrated {
  type Asked =
    | { kind: "permission"; offers: PermissionOffer[] }
    | { kind: "question"; questions: IntegratedQuestion[] };
  type Session = {
    sessionId: string;
    settings: IntegratedSettings;
    pending: string[];
    used: Set<string>;
    turn: boolean;
    asked: Map<string, Asked>;
    /** Subagents at work, with the call that started each. */
    subagents: Map<string, string | null>;
    /** Open tool calls, with the subagent call each belongs to. */
    open: Map<string, string | null>;
    reporting: boolean;
    compacting: boolean;
    state: string | null;
    ended: boolean;
  };
  const MODES = [
    { value: "default", name: "Default", description: null },
    { value: "acceptEdits", name: "Accept edits", description: null },
    { value: "plan", name: "Plan", description: null },
  ];
  const MODELS = [
    { value: "haiku", name: "Haiku", description: null, efforts: [] as string[] },
    { value: "sonnet", name: "Sonnet", description: null, efforts: ["low", "medium", "high"] },
  ];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const sessions = new Map<string, Session>();
  const handlers = new Set<(event: IntegratedEvent) => void>();
  let count = 0;
  let blocks = 0;
  let requests = 0;
  let calls = 0;
  let tasks = 0;

  const efforts = (model: string | null) =>
    MODELS.find((entry) => entry.value === model)?.efforts ?? [];

  const fake: FakeIntegrated = {
    calls: [],
    events: [],
    untrusted: new Set(),

    start(options) {
      const folder = options.cwd ?? options.project;
      if (fake.untrusted.has(folder))
        throw new Error(`untrusted: ${folder} has not been trusted in claude yet`);
      const id = `int-${++count}`;
      const sessionId = options.session ?? `integrated-session-${count}`;
      const settings = {
        model: options.model ?? null,
        mode: options.mode ?? "default",
        effort: options.effort ?? null,
      };
      sessions.set(id, {
        sessionId,
        settings,
        pending: [],
        used: new Set(),
        turn: false,
        asked: new Map(),
        subagents: new Map(),
        open: new Map(),
        reporting: false,
        compacting: false,
        state: null,
        ended: false,
      });
      fake.calls.push({ method: "start", options, id });
      // Before the caller has the id, as the core's own may arrive.
      fake.emit(id, {
        type: "ready",
        sessionId,
        ...settings,
        version: "0.0.0-fake",
        models: MODELS,
        modes: MODES,
        efforts: efforts(settings.model),
        commands: [{ name: "compact", description: "Compact the conversation", hint: null }],
      });
      return { id, sessionId };
    },

    trust(options) {
      fake.calls.push({ method: "trust", options });
      fake.untrusted.delete(options.cwd ?? options.project);
    },

    send(id, message, text, images = []) {
      const session = live(id);
      if (!UUID.test(message)) throw new Error(`"${message}" is not a UUID`);
      if (session.used.has(message)) throw new Error(`message ${message} was sent already`);
      if (!text.trim() && images.length === 0) throw new Error("there is nothing to send");
      session.used.add(message);
      fake.calls.push({ method: "send", id, message, text, images });
      const queued = session.turn || session.pending.length > 0;
      session.pending.push(message);
      if (queued) fake.emit(id, { type: "message", message, state: "queued", error: null });
      settle(id);
    },

    interrupt(id) {
      const session = live(id);
      fake.calls.push({ method: "interrupt", id });
      if (!session.turn) {
        session.reporting = false;
        settle(id);
        return;
      }
      // The core answers first; the turn's end comes from the agent after.
      queueMicrotask(() => {
        for (const request of [...session.asked.keys()])
          fake.emit(id, { type: "withdrawn", request });
        if (session.turn) fake.endTurn(id, "interrupted");
      });
    },

    answer(id, request, choice, message) {
      const session = live(id);
      const asked = session.asked.get(request);
      if (asked?.kind !== "permission")
        throw new Error("the agent is not waiting on that request");
      const offer = asked.offers.find((offer) => offer.choice === choice);
      if (!offer) throw new Error("that choice was not offered for this request");
      fake.calls.push({
        method: "answer",
        id,
        request,
        choice,
        message: offer.message ? (message ?? null) : null,
      });
      session.asked.delete(request);
      settle(id);
    },

    reply(id, request, answers) {
      const session = live(id);
      const asked = session.asked.get(request);
      if (asked?.kind !== "question")
        throw new Error("the agent is not waiting on that question");
      if (answers) {
        if (answers.length !== asked.questions.length)
          throw new Error(`${answers.length} answers for ${asked.questions.length} questions`);
        if (answers.some((answer) => !answer.some((part) => part.trim())))
          throw new Error("a question has no answer");
      }
      fake.calls.push({ method: "reply", id, request, answers });
      session.asked.delete(request);
      settle(id);
    },

    configure(id, settings) {
      const session = live(id);
      fake.calls.push({ method: "configure", id, settings });
      const next = {
        model: settings.model ?? session.settings.model,
        mode: settings.mode ?? session.settings.mode,
        effort: settings.effort ?? session.settings.effort,
      };
      if (
        next.model !== session.settings.model ||
        next.mode !== session.settings.mode ||
        next.effort !== session.settings.effort
      )
        fake.emit(id, { type: "configured", ...next, efforts: efforts(next.model) });
      return { ...session.settings };
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
      switch (body.type) {
        case "ready":
        case "configured":
          session.settings = { model: body.model, mode: body.mode, effort: body.effort };
          break;
        case "turnStarted": {
          const messages = body.messages.filter((m) => session.pending.includes(m));
          if (session.turn) {
            for (const message of messages)
              fake.emit(id, { type: "message", message, state: "taken", error: null });
            return;
          }
          session.turn = true;
          session.reporting = false;
          session.pending = session.pending.filter((m) => !messages.includes(m));
          body = { type: "turnStarted", messages };
          break;
        }
        case "message": {
          const message = body.message;
          if (body.state !== "queued") {
            if (!session.pending.includes(message)) return;
            session.pending = session.pending.filter((m) => m !== message);
          }
          break;
        }
        case "text":
        case "thinking":
        case "toolStarted":
          if (body.parent === null && !session.turn)
            fake.emit(id, { type: "turnStarted", messages: [] });
          if (body.type === "toolStarted") session.open.set(body.call, body.parent);
          break;
        case "toolFinished":
          session.open.delete(body.call);
          break;
        case "turnEnded": {
          if (!session.turn) fake.emit(id, { type: "turnStarted", messages: [] });
          const working = new Set(session.subagents.values());
          close(id, (parent) => parent === null || !working.has(parent));
          session.turn = false;
          session.reporting = false;
          session.compacting = false;
          break;
        }
        case "permissionAsked":
          session.asked.set(body.request, { kind: "permission", offers: body.choices });
          break;
        case "questionAsked":
          session.asked.set(body.request, { kind: "question", questions: body.questions });
          break;
        case "withdrawn":
          session.asked.delete(body.request);
          break;
        case "taskStarted":
          if (body.kind === "agent") session.subagents.set(body.task, body.call);
          break;
        case "taskFinished":
          if (session.subagents.has(body.task)) {
            const call = session.subagents.get(body.task) ?? null;
            session.subagents.delete(body.task);
            if (!session.turn && body.status !== "lost") session.reporting = true;
            if (call !== null) close(id, (parent) => parent === call);
          }
          break;
        case "compacting":
          session.compacting = true;
          break;
        case "compacted":
          session.compacting = false;
          break;
        case "ended":
          session.ended = true;
          break;
      }
      const event = { ...body, id } as IntegratedEvent;
      fake.events.push(event);
      for (const handler of handlers) handler(event);
      if (body.type !== "state" && body.type !== "ended") settle(id);
    },

    startTurn(id, messages) {
      const session = live(id);
      fake.emit(id, { type: "turnStarted", messages: messages ?? [...session.pending] });
    },

    endTurn(id, outcome = "done", error) {
      fake.emit(id, {
        type: "turnEnded",
        outcome,
        error: outcome === "failed" ? (error ?? "the turn failed") : null,
        totalCostUsd: 0.001,
        durationMs: 10,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
    },

    turn(id, text, options = {}) {
      const parent = options.parent ?? null;
      if (parent === null) fake.startTurn(id, options.messages);
      streamed(id, "text", text, parent, options.pieces ?? 3);
      if (parent === null) fake.endTurn(id);
    },

    think(id, text, options = {}) {
      streamed(id, "thinking", text, options.parent ?? null, 2);
    },

    ask(id, tool, input, options = {}) {
      const request = `request-${++requests}`;
      const choices: PermissionOffer[] = [{ choice: "allow", remembers: null, message: false }];
      if (options.session)
        choices.push({ choice: "allowSession", remembers: options.session, message: false });
      if (options.always)
        choices.push({ choice: "allowAlways", remembers: options.always, message: false });
      choices.push(
        { choice: "deny", remembers: null, message: true },
        { choice: "cancel", remembers: null, message: true },
      );
      fake.emit(id, {
        type: "permissionAsked",
        request,
        call: options.call ?? null,
        parent: null,
        tool,
        input,
        truncated: false,
        description: null,
        path: options.path ?? null,
        choices,
      });
      return request;
    },

    question(id, questions) {
      const request = `request-${++requests}`;
      fake.emit(id, { type: "questionAsked", request, call: null, parent: null, questions });
      return request;
    },

    startTool(id, name, input, options = {}) {
      const call = `call-${++calls}`;
      const parent = options.parent ?? null;
      fake.emit(id, { type: "toolStarted", call, parent, name, kind: options.kind ?? "other" });
      fake.emit(id, { type: "toolInput", call, parent, delta: null, input, truncated: false });
      return call;
    },

    finishTool(id, call, output, options = {}) {
      const parent = sessions.get(id)?.open.get(call) ?? null;
      fake.emit(id, {
        type: "toolFinished",
        call,
        parent,
        output,
        error: options.error ?? false,
        truncated: false,
        changes: options.changes ?? [],
      });
    },

    tool(id, name, input, output, options = {}) {
      const call = fake.startTool(id, name, input, options);
      fake.finishTool(id, call, output, { changes: options.changes });
      return call;
    },

    task(id, call, options = {}) {
      const task = `task-${++tasks}`;
      fake.emit(id, {
        type: "taskStarted",
        task,
        call,
        kind: options.kind ?? "agent",
        description: options.description ?? null,
        prompt: null,
        background: options.background ?? true,
      });
      return task;
    },

    finishTask(id, task, status = "completed", summary) {
      const call = sessions.get(id)?.subagents.get(task) ?? null;
      fake.emit(id, { type: "taskFinished", task, call, status, summary: summary ?? null });
    },

    plan(id, steps, text = null) {
      fake.emit(id, { type: "plan", call: null, parent: null, text, steps });
    },

    compact(id) {
      fake.emit(id, { type: "compacting" });
      fake.emit(id, { type: "compacted", trigger: "manual", tokensBefore: 100, tokensAfter: 10 });
    },

    end(id, clean = true) {
      const session = sessions.get(id);
      if (!session || session.ended) return;
      // What is open closes without a state of its own, as in the core.
      session.state = "closing";
      close(id, () => true);
      if (session.turn) {
        session.turn = false;
        say(id, {
          type: "turnEnded",
          outcome: "failed",
          error: "the agent ended during the turn",
          totalCostUsd: null,
          durationMs: null,
          usage: null,
        });
      }
      for (const request of [...session.asked.keys()]) say(id, { type: "withdrawn", request });
      for (const message of session.pending)
        say(id, {
          type: "message",
          message,
          state: "dropped",
          error: "the agent ended before it took the message",
        });
      if (!clean)
        say(id, { type: "error", kind: "process", message: "claude ended with code 1" });
      fake.emit(id, { type: "ended", code: clean ? 0 : 1, clean });
      sessions.delete(id);
    },
  };

  function live(id: string): Session {
    const session = sessions.get(id);
    if (!session || session.ended) throw new Error("no such session");
    return session;
  }

  /** Puts an event out with no bookkeeping, for the end of a session. */
  function say(id: string, body: IntegratedEventBody) {
    const event = { ...body, id } as IntegratedEvent;
    fake.events.push(event);
    for (const handler of handlers) handler(event);
  }

  /** Finishes the open calls `which` picks by their parent, as failed. */
  function close(id: string, which: (parent: string | null) => boolean) {
    const session = sessions.get(id)!;
    for (const [call, parent] of [...session.open]) {
      if (!which(parent)) continue;
      session.open.delete(call);
      say(id, {
        type: "toolFinished",
        call,
        parent,
        output: "",
        error: true,
        truncated: false,
        changes: [],
      });
    }
  }

  function streamed(
    id: string,
    type: "text" | "thinking",
    text: string,
    parent: string | null,
    pieces: number,
  ) {
    const block = `block-${++blocks}`;
    const size = Math.max(1, Math.ceil(text.length / Math.max(1, pieces)));
    for (let at = 0; at < text.length; at += size)
      fake.emit(id, { type, block, parent, text: text.slice(at, at + size), done: false });
    fake.emit(id, { type, block, parent, text, done: true });
  }

  /** Tells the state when it changed, as the core does. */
  function settle(id: string) {
    const session = sessions.get(id);
    if (!session || session.ended || session.state === "closing") return;
    const state =
      session.asked.size > 0
        ? "asking"
        : session.turn ||
            session.pending.length > 0 ||
            session.compacting ||
            session.subagents.size > 0 ||
            session.reporting
          ? "working"
          : "idle";
    if (state === session.state) return;
    session.state = state;
    fake.emit(id, { type: "state", state });
  }

  return fake;
}
