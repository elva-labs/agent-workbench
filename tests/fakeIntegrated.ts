import type {
  IntegratedEvent,
  IntegratedEventBody,
  IntegratedFileChange,
  IntegratedImage,
  IntegratedPlanStep,
  IntegratedQuestion,
  IntegratedSettings,
  IntegratedSnapshot,
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
  | { method: "compact"; id: string }
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
  | { method: "snapshot"; id: string }
  | { method: "stop"; id: string };

/** How the scripted agent behaves. `holding`: it takes no message while a
    turn runs, so the fake holds each one and hands one over only when no
    turn runs and the agent has named the last one handed over, as the core
    does for such an agent. `mints`: it makes its own conversation ids, so
    a fresh start says none and `ready` says the agent's. */
export interface FakeIntegratedOptions {
  holding?: boolean;
  mints?: boolean;
}

/** A scripted integrated session behind the seam, for the unit tests and
    the browser tests alike. The commands check what the core checks and
    the events follow the core's rules: a sent message is echoed with its
    text, messages are pending until a turn names them, the state is
    derived from the events, an answer is told, tool calls left open close
    when their turn or subagent ends, housekeeping tasks never keep the
    session working, a task the agent says it reports keeps the session
    working until its report's turn ends, long output is cut down and says
    so, and a snapshot holds what a window that comes late cannot read
    elsewhere. `ready` goes out before `start` returns, as it may from the
    core, and an interrupt's end of turn comes after the call. What the
    agent says within a turn is the test's to script, through `emit` and
    the helpers built on it. */
export interface FakeIntegrated {
  /** Every call, in order. */
  calls: IntegratedCall[];
  /** Everything said so far, in order. */
  events: IntegratedEvent[];
  /** Folders a start refuses until they are trusted. */
  untrusted: Set<string>;
  /** The messages handed over to a holding agent, in order. */
  handed: string[];

  start(options: IntegratedStartOptions): IntegratedStarted;
  trust(options: IntegratedTrustOptions): void;
  send(id: string, message: string, text: string, images?: IntegratedImage[]): void;
  interrupt(id: string): void;
  /** Asks the agent to compact: once no turn runs, it compacts in a turn
      that names no message. */
  compact(id: string): void;
  answer(id: string, request: string, choice: PermissionChoice, message?: string): void;
  reply(id: string, request: string, answers: string[][] | null): void;
  configure(
    id: string,
    settings: { model?: string; mode?: string; effort?: string },
  ): IntegratedSettings;
  snapshot(id: string): IntegratedSnapshot;
  stop(id: string): void;
  subscribe(handler: (event: IntegratedEvent) => void): () => void;

  /** Says anything at all for a session, under the core's rules. */
  emit(id: string, event: IntegratedEventBody): void;
  /** Starts a turn for `messages`: by default all those waiting, or for a
      holding agent the one handed over. */
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
  /** Asks questions; returns the request's id. A question takes the
      user's own words and is not secret unless it says otherwise. */
  question(
    id: string,
    questions: (Omit<IntegratedQuestion, "secret" | "other"> &
      Partial<Pick<IntegratedQuestion, "secret" | "other">>)[],
  ): string;
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
    options?: {
      kind?: "agent" | "shell" | "other";
      background?: boolean;
      ambient?: boolean;
      description?: string;
    },
  ): string;
  /** A task ended. It reports in a turn of its own when `reports` says
      so, by default when it is a subagent in the background that was not
      lost. */
  finishTask(
    id: string,
    task: string,
    status?: "completed" | "failed" | "stopped" | "lost",
    summary?: string,
    options?: { reports?: boolean },
  ): void;
  /** The plan, whole. */
  plan(id: string, steps: IntegratedPlanStep[], text?: string | null): void;
  /** The agent compacting by itself, start to finish, with no turn of its
      own: by default because the context window was full. */
  compaction(id: string, reason?: "asked" | "full"): void;
  /** What the conversation takes of the context window, and its size. */
  context(id: string, used: number | null, size: number | null): void;
  /** Something the agent says outside a turn. */
  notice(id: string, message: string, level?: "info" | "warning"): void;
  /** The agent drops a message it was sent: refused, discarded or
      cancelled. */
  drop(id: string, message: string, error?: string): void;
  /** The core left out streamed pieces because the window fell behind. */
  skip(id: string, pieces: number): void;
  /** The process ends by itself: cleanly, or not, with an error. */
  end(id: string, clean?: boolean): void;
}

/**
 * Builds the fake. Self-contained on purpose: the browser tests hand its
 * source to the page as it is, so it may refer to nothing outside itself.
 */
export function fakeIntegrated(options: FakeIntegratedOptions = {}): FakeIntegrated {
  type Asking = Extract<IntegratedEventBody, { type: "permissionAsked" | "questionAsked" }>;
  type Told = Extract<IntegratedEventBody, { type: "message" }>;
  type Asked = (
    | { kind: "permission"; offers: PermissionOffer[] }
    | { kind: "question"; questions: IntegratedQuestion[] }
  ) & { event: Asking };
  type Task = {
    call: string | null;
    kind: "agent" | "shell" | "other";
    background: boolean;
    ambient: boolean;
  };
  type Held = { message: string; text: string; images: IntegratedImage[] };
  type Session = {
    sessionId: string | null;
    settings: IntegratedSettings;
    efforts: string[];
    ready: Extract<IntegratedEventBody, { type: "ready" }> | null;
    pending: string[];
    /** The first message event of each pending message. */
    told: Map<string, Told>;
    used: Set<string>;
    turn: boolean;
    asked: Map<string, Asked>;
    tasks: Map<string, Task>;
    /** Subagents at work, with the call that started each. */
    subagents: Map<string, string | null>;
    /** Open tool calls, with the subagent call each belongs to. */
    open: Map<string, string | null>;
    /** How much of each open call's input and output has streamed. */
    streamed: Map<string, number>;
    reporting: boolean;
    compacting: boolean;
    compactAsked: boolean;
    held: Held[];
    handed: string | null;
    state: string | null;
    ended: boolean;
  };
  // The core's limits on what goes to the window.
  const OUTPUT_KEEP = 64 * 1024;
  const CONTENT_KEEP = 256 * 1024;
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

  // Lengths are in UTF-8 bytes, and a cut falls on a character's edge.
  const size = (text: string) => new TextEncoder().encode(text).length;
  const cut = (text: string, keep: number) => {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= keep) return { text, cut: false };
    let end = keep;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return { text: new TextDecoder().decode(bytes.slice(0, end)), cut: true };
  };
  /** Every string in a value cut down to `keep` bytes. */
  const cutStrings = (value: unknown, keep: number): { value: unknown; cut: boolean } => {
    if (typeof value === "string") {
      const done = cut(value, keep);
      return { value: done.text, cut: done.cut };
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => cutStrings(item, keep));
      return { value: items.map((item) => item.value), cut: items.some((item) => item.cut) };
    }
    if (value !== null && typeof value === "object") {
      const fields = Object.entries(value).map(
        ([key, item]) => [key, cutStrings(item, keep)] as const,
      );
      return {
        value: Object.fromEntries(fields.map(([key, item]) => [key, item.value])),
        cut: fields.some(([, item]) => item.cut),
      };
    }
    return { value, cut: false };
  };
  /** A changed file cut down: its content, and its hunks past what the
      limit holds of their lines. */
  const cutChange = (change: IntegratedFileChange): IntegratedFileChange => {
    const content = change.content === null ? null : cut(change.content, CONTENT_KEEP);
    let room = CONTENT_KEEP;
    let keep = 0;
    for (const hunk of change.hunks) {
      const lines = hunk.lines.reduce((sum, line) => sum + size(line) + 1, 0);
      if (lines > room) break;
      room -= lines;
      keep += 1;
    }
    return {
      ...change,
      content: content?.text ?? null,
      hunks: change.hunks.slice(0, keep),
      truncated: change.truncated || !!content?.cut || keep < change.hunks.length,
    };
  };

  const fake: FakeIntegrated = {
    calls: [],
    events: [],
    untrusted: new Set(),
    handed: [],

    start(startOptions) {
      const folder = startOptions.cwd ?? startOptions.project;
      if (fake.untrusted.has(folder))
        throw new Error(`untrusted: ${folder} has not been trusted in claude yet`);
      const id = `int-${++count}`;
      const sessionId =
        startOptions.session ?? (options.mints ? null : `integrated-session-${count}`);
      const settings = {
        model: startOptions.model ?? null,
        mode: startOptions.mode ?? "default",
        effort: startOptions.effort ?? null,
      };
      sessions.set(id, {
        sessionId,
        settings,
        efforts: [],
        ready: null,
        pending: [],
        told: new Map(),
        used: new Set(),
        turn: false,
        asked: new Map(),
        tasks: new Map(),
        subagents: new Map(),
        open: new Map(),
        streamed: new Map(),
        reporting: false,
        compacting: false,
        compactAsked: false,
        held: [],
        handed: null,
        state: null,
        ended: false,
      });
      fake.calls.push({ method: "start", options: startOptions, id });
      // Before the caller has the id, as the core's own may arrive. An
      // agent that makes its own id says it here.
      fake.emit(id, {
        type: "ready",
        sessionId: sessionId ?? `agent-thread-${count}`,
        ...settings,
        version: "0.0.0-fake",
        models: MODELS,
        modes: MODES,
        efforts: efforts(settings.model),
        commands: [{ name: "compact", description: "Compact the conversation", hint: null }],
      });
      return { id, sessionId };
    },

    trust(trustOptions) {
      fake.calls.push({ method: "trust", options: trustOptions });
      fake.untrusted.delete(trustOptions.cwd ?? trustOptions.project);
    },

    send(id, message, text, images = []) {
      const session = live(id);
      if (!text.trim() && images.length === 0) throw new Error("there is nothing to send");
      if (!UUID.test(message)) throw new Error(`"${message}" is not a UUID`);
      if (session.used.has(message)) throw new Error(`message ${message} was sent already`);
      session.used.add(message);
      fake.calls.push({ method: "send", id, message, text, images });
      const queued = session.turn || session.pending.length > 0;
      session.pending.push(message);
      if (options.holding) {
        if (session.turn || session.handed !== null || session.held.length > 0)
          session.held.push({ message, text, images });
        else handOver(id, message);
      }
      const told: Told = {
        type: "message",
        message,
        state: queued ? "queued" : "sent",
        error: null,
        text,
        images,
      };
      session.told.set(message, told);
      fake.emit(id, told);
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

    compact(id) {
      const session = live(id);
      fake.calls.push({ method: "compact", id });
      session.compactAsked = true;
      // The agent takes it once no turn runs, after the call answers.
      queueMicrotask(() => {
        if (!session.turn) compactNow(id);
      });
    },

    answer(id, request, choice, message) {
      const session = live(id);
      const asked = session.asked.get(request);
      if (asked?.kind !== "permission")
        throw new Error("the agent is not waiting on that request");
      const offer = asked.offers.find((offer) => offer.choice === choice);
      if (!offer) throw new Error("that choice was not offered for this request");
      const said = offer.message && message?.trim() ? message.trim() : null;
      fake.calls.push({ method: "answer", id, request, choice, message: said });
      fake.emit(id, { type: "answered", request, choice, answers: null, message: said });
      // Cancelling stops the turn, which the agent then ends.
      if (choice === "cancel")
        queueMicrotask(() => {
          if (session.turn) fake.endTurn(id, "interrupted");
        });
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
        asked.questions.forEach((question, at) => {
          if (question.other) return;
          const labels = question.options.map((option) => option.label);
          const own = answers[at].map((part) => part.trim()).find(
            (part) => part && !labels.includes(part),
          );
          if (own !== undefined)
            throw new Error(`"${own}" is not one of the options of "${question.question}"`);
        });
      }
      fake.calls.push({ method: "reply", id, request, answers });
      // No window is told a secret question's answer.
      fake.emit(id, {
        type: "answered",
        request,
        choice: answers ? "allow" : "deny",
        answers:
          answers?.map((answer, at) => (asked.questions[at]?.secret ? null : answer)) ?? null,
        message: null,
      });
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

    snapshot(id) {
      const session = live(id);
      fake.calls.push({ method: "snapshot", id });
      return {
        state: (session.state as IntegratedSnapshot["state"] | null) ?? "idle",
        turn: session.turn,
        settings: { ...session.settings },
        efforts: [...session.efforts],
        ready: session.ready,
        requests: [...session.asked.values()].map((asked) => asked.event),
        messages: session.pending.flatMap((message) => {
          const told = session.told.get(message);
          return told ? [told] : [];
        }),
      };
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
          session.efforts = body.efforts;
          if (body.type === "ready") session.ready = body;
          break;
        case "turnStarted": {
          const messages = body.messages.filter((m) => session.pending.includes(m));
          if (session.turn) {
            for (const message of messages)
              fake.emit(id, { ...movedOn(message, "taken"), error: null });
            return;
          }
          session.turn = true;
          session.reporting = false;
          session.pending = session.pending.filter((m) => !messages.includes(m));
          for (const message of messages) session.told.delete(message);
          body = { type: "turnStarted", messages };
          break;
        }
        case "message": {
          const message = body.message;
          if (body.state === "taken" || body.state === "dropped") {
            if (!session.pending.includes(message)) return;
            session.pending = session.pending.filter((m) => m !== message);
            session.told.delete(message);
            session.held = session.held.filter((held) => held.message !== message);
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
        case "toolInput":
        case "toolOutput": {
          const delta = body.delta;
          if (delta !== null) {
            const streamed = (session.streamed.get(body.call) ?? 0) + size(delta);
            session.streamed.set(body.call, streamed);
            if (streamed > CONTENT_KEEP) return;
          } else if (body.type === "toolInput" && body.input !== null && body.input !== undefined) {
            const input = cutStrings(body.input, OUTPUT_KEEP);
            body = { ...body, input: input.value, truncated: body.truncated || input.cut };
          }
          break;
        }
        case "toolFinished": {
          session.open.delete(body.call);
          session.streamed.delete(body.call);
          const output = cut(body.output, OUTPUT_KEEP);
          const changes = body.changes.map(cutChange);
          body = { ...body, output: output.text, truncated: body.truncated || output.cut, changes };
          break;
        }
        case "turnDiff": {
          const diff = cut(body.diff, CONTENT_KEEP);
          body = { ...body, diff: diff.text, truncated: body.truncated || diff.cut };
          break;
        }
        case "turnEnded": {
          if (!session.turn) fake.emit(id, { type: "turnStarted", messages: [] });
          const working = new Set(session.subagents.values());
          close(id, (parent) => parent === null || !working.has(parent));
          session.turn = false;
          session.reporting = false;
          session.compacting = false;
          break;
        }
        case "permissionAsked": {
          const input = cutStrings(body.input, OUTPUT_KEEP);
          body = { ...body, input: input.value, truncated: body.truncated || input.cut };
          session.asked.set(body.request, { kind: "permission", offers: body.choices, event: body });
          break;
        }
        case "questionAsked":
          session.asked.set(body.request, {
            kind: "question",
            questions: body.questions,
            event: body,
          });
          break;
        case "answered":
        case "withdrawn":
          session.asked.delete(body.request);
          break;
        case "taskStarted":
          session.tasks.set(body.task, {
            call: body.call,
            kind: body.kind,
            background: body.background,
            ambient: body.ambient,
          });
          if (body.kind === "agent" && !body.ambient) session.subagents.set(body.task, body.call);
          break;
        case "taskFinished":
          session.tasks.delete(body.task);
          if (body.reports && !session.turn && body.status !== "lost") session.reporting = true;
          if (session.subagents.has(body.task)) {
            const call = session.subagents.get(body.task) ?? null;
            session.subagents.delete(body.task);
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
      if (body.type === "turnEnded") afterTurn(id);
      if (body.type !== "state" && body.type !== "ended") {
        release(id);
        settle(id);
      }
    },

    startTurn(id, messages) {
      const session = live(id);
      const waiting = options.holding
        ? session.handed === null
          ? []
          : [session.handed]
        : [...session.pending];
      fake.emit(id, { type: "turnStarted", messages: messages ?? waiting });
    },

    endTurn(id, outcome = "done", error) {
      fake.emit(id, {
        type: "turnEnded",
        outcome,
        error: outcome === "failed" ? (error ?? "the turn failed") : null,
        totalCostUsd: 0.001,
        durationMs: 10,
        usage: { inputTokens: 3, cachedTokens: 2, outputTokens: 1, reasoningTokens: 0 },
      });
    },

    turn(id, text, turnOptions = {}) {
      const parent = turnOptions.parent ?? null;
      if (parent === null) fake.startTurn(id, turnOptions.messages);
      streamed(id, "text", text, parent, turnOptions.pieces ?? 3);
      if (parent === null) fake.endTurn(id);
    },

    think(id, text, thinkOptions = {}) {
      streamed(id, "thinking", text, thinkOptions.parent ?? null, 2);
    },

    ask(id, tool, input, askOptions = {}) {
      const request = `request-${++requests}`;
      const choices: PermissionOffer[] = [{ choice: "allow", remembers: null, message: false }];
      if (askOptions.session)
        choices.push({ choice: "allowSession", remembers: askOptions.session, message: false });
      if (askOptions.always)
        choices.push({ choice: "allowAlways", remembers: askOptions.always, message: false });
      choices.push(
        { choice: "deny", remembers: null, message: true },
        { choice: "cancel", remembers: null, message: true },
      );
      fake.emit(id, {
        type: "permissionAsked",
        request,
        call: askOptions.call ?? null,
        parent: null,
        tool,
        input,
        truncated: false,
        description: null,
        path: askOptions.path ?? null,
        choices,
      });
      return request;
    },

    question(id, asking) {
      const request = `request-${++requests}`;
      const questions = asking.map((question) => ({ secret: false, other: true, ...question }));
      fake.emit(id, { type: "questionAsked", request, call: null, parent: null, questions });
      return request;
    },

    startTool(id, name, input, toolOptions = {}) {
      const call = `call-${++calls}`;
      const parent = toolOptions.parent ?? null;
      fake.emit(id, { type: "toolStarted", call, parent, name, kind: toolOptions.kind ?? "other" });
      fake.emit(id, { type: "toolInput", call, parent, delta: null, input, truncated: false });
      return call;
    },

    finishTool(id, call, output, finishOptions = {}) {
      const parent = sessions.get(id)?.open.get(call) ?? null;
      fake.emit(id, {
        type: "toolFinished",
        call,
        parent,
        output,
        error: finishOptions.error ?? false,
        truncated: false,
        changes: finishOptions.changes ?? [],
      });
    },

    tool(id, name, input, output, toolOptions = {}) {
      const call = fake.startTool(id, name, input, toolOptions);
      fake.finishTool(id, call, output, { changes: toolOptions.changes });
      return call;
    },

    task(id, call, taskOptions = {}) {
      const task = `task-${++tasks}`;
      fake.emit(id, {
        type: "taskStarted",
        task,
        call,
        kind: taskOptions.kind ?? "agent",
        description: taskOptions.description ?? null,
        prompt: null,
        background: taskOptions.background ?? true,
        ambient: taskOptions.ambient ?? false,
      });
      return task;
    },

    finishTask(id, task, status = "completed", summary, finishOptions = {}) {
      const known = sessions.get(id)?.tasks.get(task);
      const reports =
        finishOptions.reports ??
        (known?.kind === "agent" && known.background && !known.ambient && status !== "lost");
      fake.emit(id, {
        type: "taskFinished",
        task,
        call: known?.call ?? null,
        status,
        summary: summary ?? null,
        reports,
      });
    },

    plan(id, steps, text = null) {
      fake.emit(id, { type: "plan", call: null, parent: null, text, steps });
    },

    compaction(id, reason = "full") {
      fake.emit(id, { type: "compacting" });
      fake.emit(id, { type: "compacted", reason, tokensBefore: 100, tokensAfter: 10 });
    },

    context(id, used, size) {
      fake.emit(id, { type: "context", used, size });
    },

    notice(id, message, level = "info") {
      fake.emit(id, { type: "notice", level, message });
    },

    drop(id, message, error = "the agent refused the message") {
      fake.emit(id, { ...movedOn(message, "dropped"), error });
    },

    skip(id, pieces) {
      fake.emit(id, { type: "skipped", pieces });
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
          ...movedOn(message, "dropped"),
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

  /** A message event after the first, with nothing of what it said. */
  function movedOn(message: string, state: "taken" | "dropped") {
    return { type: "message" as const, message, state, text: null, images: [] };
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
      session.streamed.delete(call);
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

  function handOver(id: string, message: string) {
    sessions.get(id)!.handed = message;
    fake.handed.push(message);
  }

  /** Hands a holding agent the next held message, once no turn runs and
      it has named the last one handed over. */
  function release(id: string) {
    const session = sessions.get(id);
    if (!options.holding || !session || session.ended) return;
    if (session.handed !== null && !session.pending.includes(session.handed))
      session.handed = null;
    if (session.turn || session.handed !== null) return;
    const next = session.held.shift();
    if (next) handOver(id, next.message);
  }

  /** What the agent does once a turn is over: compact, if it was asked. */
  function afterTurn(id: string) {
    const session = sessions.get(id);
    if (session?.compactAsked) queueMicrotask(() => compactNow(id));
  }

  function compactNow(id: string) {
    const session = sessions.get(id);
    if (!session || session.ended || session.turn || !session.compactAsked) return;
    session.compactAsked = false;
    fake.emit(id, { type: "turnStarted", messages: [] });
    fake.compaction(id, "asked");
    fake.context(id, 10, 200_000);
    fake.endTurn(id);
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
