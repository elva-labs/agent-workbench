import type {
  IntegratedCommand,
  IntegratedEvent,
  IntegratedEventBody,
  IntegratedFileChange,
  IntegratedHistory,
  IntegratedHistoryOptions,
  IntegratedImage,
  IntegratedLimitWindow,
  IntegratedPlanStep,
  IntegratedPoint,
  IntegratedPoints,
  IntegratedPreview,
  IntegratedQuestion,
  IntegratedSentNow,
  IntegratedSettings,
  IntegratedSnapshot,
  IntegratedStartOptions,
  IntegratedStarted,
  IntegratedToolKind,
  IntegratedTrustOptions,
  IntegratedWentBack,
  PermissionChoice,
  PermissionOffer,
} from "$lib/core";

/** A call the window made on an integrated session, as the fake kept it. */
export type IntegratedCall =
  | { method: "start"; options: IntegratedStartOptions; id: string }
  | { method: "trust"; options: IntegratedTrustOptions }
  | { method: "send"; id: string; message: string; text: string; images: IntegratedImage[] }
  | { method: "interrupt"; id: string }
  | { method: "sendNow"; id: string }
  | { method: "withdraw"; id: string; message: string }
  | { method: "compact"; id: string; instructions: string | null }
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
  | { method: "history"; options: IntegratedHistoryOptions }
  | { method: "rewindPoints"; id: string }
  | { method: "rewindPreview"; id: string; message: string }
  | { method: "rewind"; id: string; message: string; conversation: boolean; files: string[] | null }
  | { method: "rewindUndo"; id: string }
  | { method: "held"; options: IntegratedHistoryOptions }
  | { method: "stop"; id: string };

/** How the scripted agent behaves. `holding`: it takes no message while a
    turn runs, so the fake holds each one and hands one over only when no
    turn runs and the agent has named the last one handed over, as the core
    does for such an agent. `mints`: it makes its own conversation ids, so
    a fresh start says none and `ready` says the agent's. */
export interface FakeIntegratedOptions {
  holding?: boolean;
  mints?: boolean;
  /** A mode the agent reports from its own configuration, whatever the
      start asked for, and which the list of modes does not hold. */
  ownMode?: string;
  /** The mode the user's own settings start a session in when the start
      names none: Default for Claude Code and Codex's own pair, unless it
      says. */
  defaultMode?: string;
  /** Keeps the sessions across a reload of the page, as the core keeps
      them while a window reloads: every call made on the fake is kept in
      the page's session storage under this key and played again when the
      fake is made anew. The calls a window made are its own, so a fake
      made anew starts with none. */
  keep?: string;
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
    elsewhere, the account's last limits among it. `ready` goes out before
    `start` returns, as it may from the core, and an interrupt's end of
    turn comes after the call. What the agent says within a turn is the
    test's to script, through `emit` and the helpers built on it. A session
    started with no model says the model it resolved its default to, as the
    core does. A session of Codex is shaped as the core's Codex driver says
    one is: it makes its own ids, offers its own models and modes, and
    withdraws what a turn asked when the turn ends, with no answer. */
export interface FakeIntegrated {
  /** Every call, in order. */
  calls: IntegratedCall[];
  /** Everything said so far, in order. */
  events: IntegratedEvent[];
  /** Folders a start refuses until they are trusted. */
  untrusted: Set<string>;
  /** The messages handed over to a holding agent, in order. */
  handed: string[];
  /** Sessions started while this holds say they are ready only when the
      test says so, through `ready`. */
  holdReady: boolean;
  /** A compaction asked for is refused with this, while it is set. */
  compactRefusal: string | null;

  start(options: IntegratedStartOptions): IntegratedStarted;
  trust(options: IntegratedTrustOptions): void;
  send(id: string, message: string, text: string, images?: IntegratedImage[]): void;
  interrupt(id: string): void;
  /** Asks the agent to compact: once no turn runs, it compacts in a turn
      that names no message. Codex takes no instructions for it. */
  compact(id: string, instructions?: string): void;
  /** Sends the waiting messages now, refused as the core refuses it: a
      holding agent, or one shaped as Codex, has them steered into its
      turn and taken, in order, saying it delivers them; another has its
      turn interrupted, then starts one for them all, saying it stopped. */
  sendNow(id: string): IntegratedSentNow;
  /** While set, the messages steered into a turn are taken only on
      `releaseSteers`, as an agent that takes its time answers. */
  holdSteers: boolean;
  releaseSteers(): void;
  /** Takes back a message the agent has not taken; it is withdrawn. */
  withdraw(id: string, message: string): void;
  /** While set, a message taken back is withdrawn and the asking then
      fails with this, as when the answer is lost on the way. */
  withdrawAnswer: string | null;
  answer(id: string, request: string, choice: PermissionChoice, message?: string): void;
  reply(id: string, request: string, answers: string[][] | null): void;
  configure(
    id: string,
    settings: { model?: string; mode?: string; effort?: string },
  ): IntegratedSettings;
  snapshot(id: string): IntegratedSnapshot;
  /** What the agent wrote down of a conversation, as the core reads it
      back: the messages it took, its turns with the model each ran on,
      and what it said and did in whole, each with when; nothing of what
      only streamed. Codex names no model on a turn and keeps no plan's
      steps, and a thread it does not have is an error, in the core's
      words; Claude Code has nothing of a conversation it did not write. */
  history(options: IntegratedHistoryOptions): Promise<IntegratedHistory | null>;
  /** Where the session's conversation can go back to, as the core says:
      every message of the user's in its transcript as it is kept now,
      oldest first. Of Claude Code's, one before the conversation was last
      compacted cannot, and files can go back where `files` holds what
      putting them back would change. Of Codex's, one taken into a turn
      already running cannot, files never can, and a thread in `older`
      cannot at all. */
  rewindPoints(id: string): IntegratedPoints;
  /** What putting the files back as they were before a message would
      change, from `files`, refused as the core refuses it. */
  rewindPreview(id: string, message: string): IntegratedPreview;
  /** Goes back to before a message, refused as the core refuses it: a
      session not at rest, a message it cannot go back to, files it cannot
      put back, or files to put back that `files` now names and the ones
      passed, those the user was shown, do not. The transcript is read as
      far as the message from then on, as the core holds it, and a Claude
      Code conversation is held until a turn takes a message in it. Claude Code's session ends and one is started
      again under a new id, on the same conversation, a new one for the
      first message, or with `rewindFallback` set on the conversation
      whole; Codex's goes on. `rewound` follows on the session that goes
      on. */
  rewind(
    id: string,
    message: string,
    what: { conversation: boolean; files: string[] | null },
  ): IntegratedWentBack;
  /** Whether a Claude Code conversation is held at the point it went back
      to: from going back until a turn takes a message in it, or undo. */
  held(options: IntegratedHistoryOptions): boolean;
  /** What the core does as a terminal resumes a Claude Code conversation:
      one held at the point it went back to is refused, as the core refuses
      it, unless `bringBack` says the user agreed, which lets the point
      go. */
  terminalResume(session: string, bringBack: boolean): void;
  /** Undoes the going back that started a Claude Code session, while
      nothing has gone on in it since: it ends, and one is started again on
      the conversation as it was. */
  rewindUndo(id: string): IntegratedWentBack;
  /** What putting the files back as they were before a message of a
      Claude Code session would change, by the message. */
  files: Map<string, IntegratedPreview>;
  /** The Codex threads kept in the older format, which cannot go back. */
  older: Set<string>;
  /** While set, a Claude Code conversation that goes back does not come up
      from there, and is started again whole, saying this. */
  rewindFallback: string | null;
  stop(id: string): void;
  subscribe(handler: (event: IntegratedEvent) => void): () => void;

  /** Writes a past conversation into the transcript of `session` ahead
      of anything said in it since, as the agent given keeps it. */
  transcript(session: string, items: IntegratedHistory["items"], agent?: "claude-code" | "codex"): void;
  /** Holds what the agent says to every answer and reply until
      `releaseAnswers`, as a core whose agent takes its time does: the call
      is taken and checked at once, and the answer told on release. */
  holdAnswers(): void;
  releaseAnswers(): void;
  /** Holds the answer to every read of a history until `releaseHistory`;
      what is read is what the transcript held when asked. */
  holdHistory(): void;
  releaseHistory(): void;

  /** Says anything at all for a session, under the core's rules. */
  emit(id: string, event: IntegratedEventBody): void;
  /** The agent of a session started while `holdReady` held says it is
      ready. */
  ready(id: string): void;
  /** The agent's commands and skills change, or it says more of which is
      which. */
  commands(id: string, commands: IntegratedCommand[]): void;
  /** Hands events the real core emitted to the window as they are, with
      none of this fake's own rules: a replay of what a driver said. */
  replay(id: string, events: IntegratedEventBody[]): void;
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
  /** The account's limits as the agent reports them, whole: each window
      with no model, reset time or severity unless it says otherwise,
      under no plan, taken now by a read. A push names `readAt`, the time
      of the read before it, or null where there was none. The agent is
      the session's. */
  limits(
    id: string,
    windows: (Pick<IntegratedLimitWindow, "kind" | "percent"> & Partial<IntegratedLimitWindow>)[],
    options?: { plan?: string | null; takenAt?: number; readAt?: number | null },
  ): void;
  /** Something the agent says outside a turn. */
  notice(id: string, message: string, level?: "info" | "warning"): void;
  /** The agent drops a message it was sent: refused, discarded or
      cancelled. */
  drop(id: string, message: string, error?: string): void;
  /** The agent stops waiting for a request by itself, as a question of
      Codex's does after a while. */
  expire(id: string, request: string): void;
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
    codex: boolean;
    /** How it was started, for a start again. */
    started: IntegratedStartOptions;
    sessionId: string | null;
    settings: IntegratedSettings;
    efforts: string[];
    ready: Extract<IntegratedEventBody, { type: "ready" }> | null;
    /** The ready event, held until the test says the agent is ready. */
    heldReady: Extract<IntegratedEventBody, { type: "ready" }> | null;
    pending: string[];
    /** The first message event of each pending message. */
    told: Map<string, Told>;
    used: Set<string>;
    turn: boolean;
    asked: Map<string, Asked>;
    tasks: Map<string, Task>;
    /** Subagents at work, with the call that started each. */
    subagents: Map<string, string | null>;
    /** The start of each subagent at work, as it went out. */
    starts: Map<string, Extract<IntegratedEventBody, { type: "taskStarted" }>>;
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
    /** The last limits event. */
    limits: Extract<IntegratedEventBody, { type: "limits" }> | null;
    /** When it started, for a conversation it resumed. */
    resumedAt: number | null;
    /** A turn has started in this run. */
    turned: boolean;
    /** What undoing the going back that started it goes back to: the
        conversation, and its transcript as it was then. */
    undo: { conversation: string; transcript: Written[] | null } | null;
  };
  type Written = IntegratedHistory["items"][number];
  // The core's limits on what goes to the window.
  const OUTPUT_KEEP = 64 * 1024;
  const CONTENT_KEEP = 256 * 1024;
  const MODES = [
    { value: "default", name: "Default", description: null },
    { value: "acceptEdits", name: "Accept edits", description: null },
    { value: "plan", name: "Plan", description: null },
    { value: "auto", name: "Auto", description: null },
    { value: "dontAsk", name: "Don't ask", description: null },
  ];
  const MODELS = [
    {
      value: "default",
      name: "Default (recommended)",
      description: "Sonnet, for everyday work",
      efforts: ["low", "medium", "high"],
    },
    { value: "haiku", name: "Haiku", description: null, efforts: [] as string[] },
    { value: "sonnet", name: "Sonnet", description: null, efforts: ["low", "medium", "high"] },
  ];
  /** What the agent says it runs on when no model was asked for. */
  const RESOLVED = "claude-sonnet-5-5";
  const command = (
    name: string,
    description: string,
    hint: string | null,
    source: string | null = null,
    skill = false,
  ): IntegratedCommand => ({ name, description, hint, skill, builtin: source === null, source });
  const COMMANDS = [
    command("compact", "Compact the conversation, keeping a summary", "[instructions]"),
    command("context", "Show what fills the context", null),
    command("init", "Write a CLAUDE.md for this project", null),
    command("review", "Review a pull request", "[pr]"),
    command("security-review", "Review the branch for security issues", null),
    command("release", "Bump, tag and push a release", "<version>", "project"),
    command("code-review", "Review the current diff for bugs", "[level]", "user", true),
    command("run", "Launch the app to see a change working", null, "project", true),
  ];
  const CODEX_MODES = [
    { value: "read-only", name: "Read only", description: "Reads, and asks before it changes anything" },
    { value: "auto", name: "Auto", description: "Works in the project, and asks before going outside it" },
    { value: "full-access", name: "Full access", description: "Works anywhere without asking" },
  ];
  const CODEX_MODELS = [
    { value: "gpt-5-codex", name: "gpt-5-codex", description: null, efforts: ["low", "medium", "high"] },
  ];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Why the core says a conversation cannot go back.
  const UNSAID = "That message is not in the conversation as the agent keeps it.";
  const COMPACTED =
    "The conversation was compacted after this message, so it cannot go back to before it.";
  const TAKEN_INTO =
    "Codex took this message into a turn that was running, which goes back with the message that began it.";
  const OLDER = "This conversation was kept by an older Codex and cannot go back.";
  const NO_FILES = "Codex cannot put files back.";
  const UNSHOWN = "The files to put back changed since they were shown. Look at them again.";
  const TERMINAL_HELD =
    "This conversation went back to an earlier message, and a terminal would bring back what that left out. Send it a message in the workbench first, or agree to bring that back.";
  const sessions = new Map<string, Session>();
  const handlers = new Set<(event: IntegratedEvent) => void>();
  /** What takes the messages steered while `holdSteers` holds. */
  const steersHeld: (() => void)[] = [];
  /** Each conversation's transcript, by its id. */
  const transcripts = new Map<string, Written[]>();
  /** The Claude Code conversations held at the point they went back to. */
  const heldConversations = new Set<string>();
  /** The conversations Codex keeps, the rest being Claude Code's. */
  const threads = new Set<string>();
  let historyHeld: { wait: Promise<void>; release: () => void } | null = null;
  /** What answers and replies tell, held until released. */
  let answersHeld: (() => void)[] | null = null;
  const told = (tell: () => void) => (answersHeld === null ? tell() : answersHeld.push(tell));
  let count = 0;
  /** How deep in its own calls the fake is, and whether it is playing
      back what was kept across a reload. */
  let depth = 0;
  let replaying = false;
  /** Runs `then` after the call that asked for it, as the agent would;
      while calls are played back, what it did then is played back too. */
  const later = (then: () => void) => {
    if (!replaying) queueMicrotask(then);
  };
  let blocks = 0;
  let requests = 0;
  let calls = 0;
  let tasks = 0;

  const efforts = (model: string | null) =>
    [...MODELS, ...CODEX_MODELS].find(
      (entry) => entry.value === model || (model !== null && model.split(/[-_.]/).includes(entry.value)),
    )?.efforts ?? [];

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
    holdReady: false,
    compactRefusal: null,
    holdSteers: false,
    withdrawAnswer: null,

    start(startOptions) {
      const folder = startOptions.cwd ?? startOptions.project;
      if (fake.untrusted.has(folder))
        throw new Error(`untrusted: ${folder} has not been trusted in claude yet`);
      const started = open(startOptions);
      fake.calls.push({ method: "start", options: startOptions, id: started.id });
      announce(started.id);
      return started;
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
      later(() => {
        for (const request of [...session.asked.keys()])
          fake.emit(id, { type: "withdrawn", request });
        if (session.turn) fake.endTurn(id, "interrupted");
      });
    },

    sendNow(id) {
      const session = live(id);
      const why =
        session.pending.length === 0
          ? "no message waits"
          : session.asked.size > 0
            ? "the agent waits for an answer first"
            : session.compacting
              ? "the conversation is being compacted"
              : !session.turn
                ? "no turn runs, and the agent takes the message next"
                : null;
      if (why !== null) throw new Error(why);
      fake.calls.push({ method: "sendNow", id });
      if (options.holding || session.codex) {
        // Steered into the running turn, in the order sent, and taken once
        // the agent answers.
        const steered = options.holding ? session.held.splice(0).map((held) => held.message) : [...session.pending];
        const take = () => {
          for (const message of steered) fake.emit(id, { ...movedOn(message, "taken"), error: null });
        };
        if (fake.holdSteers) steersHeld.push(take);
        else later(take);
        return { sendNow: "delivering" };
      }
      // Interrupted, and the agent takes every waiting message at once.
      later(() => {
        if (session.turn) fake.endTurn(id, "interrupted");
        fake.emit(id, { type: "turnStarted", messages: [...session.pending] });
      });
      return { sendNow: "stopped" };
    },

    releaseSteers() {
      for (const take of steersHeld.splice(0)) take();
    },

    withdraw(id, message) {
      const session = live(id);
      if (!session.pending.includes(message) || session.handed === message)
        throw new Error("the agent has taken the message already");
      fake.calls.push({ method: "withdraw", id, message });
      fake.emit(id, { ...movedOn(message, "withdrawn"), error: null });
      if (fake.withdrawAnswer !== null) throw new Error(fake.withdrawAnswer);
    },

    compact(id, instructions) {
      const session = live(id);
      const words = instructions?.trim() ? instructions.trim() : null;
      if (session.codex && words !== null) throw new Error("Codex compacts without instructions");
      if (fake.compactRefusal !== null) throw new Error(fake.compactRefusal);
      fake.calls.push({ method: "compact", id, instructions: words });
      session.compactAsked = true;
      // The agent takes it once no turn runs, after the call answers.
      later(() => {
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
      told(() => {
        fake.emit(id, { type: "answered", request, choice, answers: null, message: said });
        // Cancelling stops the turn, which the agent then ends.
        if (choice === "cancel")
          later(() => {
            if (session.turn) fake.endTurn(id, "interrupted");
          });
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
      told(() =>
        fake.emit(id, {
          type: "answered",
          request,
          choice: answers ? "allow" : "deny",
          answers:
            answers?.map((answer, at) => (asked.questions[at]?.secret ? null : answer)) ?? null,
          message: null,
        }),
      );
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
        limits: session.limits,
        resumedAt: session.resumedAt,
        tasks: [...session.starts.values()],
      };
    },

    async history(historyOptions) {
      fake.calls.push({ method: "history", options: historyOptions });
      const codex = historyOptions.agent === "codex";
      const own = threads.has(historyOptions.session) === codex;
      // Read when asked; a held read only answers late.
      const items = JSON.parse(JSON.stringify(own ? (transcripts.get(historyOptions.session) ?? []) : [])) as Written[];
      if (historyHeld !== null) await historyHeld.wait;
      if (codex && !own) throw new Error("Codex does not have this conversation");
      return { items, cut: false };
    },

    transcript(session, items, agent = "claude-code") {
      if (agent === "codex") threads.add(session);
      transcripts.set(session, [...items, ...(transcripts.get(session) ?? [])]);
    },

    holdAnswers() {
      answersHeld ??= [];
    },

    releaseAnswers() {
      const held = answersHeld ?? [];
      answersHeld = null;
      for (const tell of held) tell();
    },

    holdHistory() {
      if (historyHeld !== null) return;
      let release = () => {};
      const wait = new Promise<void>((resolve) => (release = resolve));
      historyHeld = { wait, release };
    },

    releaseHistory() {
      const held = historyHeld;
      historyHeld = null;
      held?.release();
    },

    files: new Map(),
    older: new Set(),
    rewindFallback: null,

    rewindPoints(id) {
      const session = live(id);
      fake.calls.push({ method: "rewindPoints", id });
      return pointsOf(session);
    },

    rewindPreview(id, message) {
      const session = live(id);
      fake.calls.push({ method: "rewindPreview", id, message });
      if (session.codex) throw new Error(NO_FILES);
      const preview = fake.files.get(message);
      if (!preview) throw new Error("No file checkpoint found for this message.");
      return { ...preview, files: [...preview.files] };
    },

    rewind(id, message, what) {
      const session = live(id);
      const why = unrested(session);
      if (why !== null) throw new Error(why);
      if (!what.conversation && what.files === null)
        throw new Error("neither the conversation nor the files were asked to go back");
      const conversation = conversationOf(session)!;
      if (session.codex && what.files !== null) throw new Error(NO_FILES);
      const points = pointsOf(session);
      if (points.why !== null) throw new Error(points.why);
      const point = points.points.find((point) => point.message === message);
      if (!point) throw new Error(UNSAID);
      if (what.files !== null && !point.files)
        throw new Error("Claude Code kept no files from before this message.");
      if (what.conversation && !point.conversation) throw new Error(point.why ?? UNSAID);
      const shown = what.files;
      if (shown !== null && (fake.files.get(message)?.files ?? []).some((file) => !shown.includes(file)))
        throw new Error(UNSHOWN);
      fake.calls.push({
        method: "rewind",
        id,
        message,
        conversation: what.conversation,
        files: what.files,
      });
      const files = what.files !== null ? [...(fake.files.get(message)?.files ?? [])] : [];
      const rewound = (on: string, back: boolean) =>
        fake.emit(on, { type: "rewound", message, conversation: back, files });
      if (!what.conversation || session.codex) {
        if (what.conversation) cutAt(conversation, message);
        rewound(id, what.conversation);
        return { id, sessionId: conversation, files, fallback: null, error: null };
      }
      // Claude Code starts again, the session it goes back from ending
      // first: from the entry before the message, or for the first as a
      // new conversation, or whole where it does not come up from there.
      const fallback = fake.rewindFallback;
      const first = points.points[0]?.message === message;
      const whole = fallback === null && !first ? cutAt(conversation, message) : null;
      const next = again(id, session, fallback === null && first ? undefined : conversation);
      if (fallback === null) rewound(next.id, true);
      else if (files.length > 0) rewound(next.id, false);
      if (fallback === null && files.length === 0)
        sessions.get(next.id)!.undo = { conversation, transcript: whole };
      if (fallback === null && !first) heldConversations.add(conversation);
      else heldConversations.delete(conversation);
      return { id: next.id, sessionId: next.sessionId, files, fallback, error: null };
    },

    rewindUndo(id) {
      const session = live(id);
      if (session.undo === null) throw new Error("there is no going back to undo in this session");
      const why = unrested(session);
      if (why !== null) throw new Error(why);
      if (session.turned || session.used.size > 0)
        throw new Error("the conversation has gone on since it went back");
      fake.calls.push({ method: "rewindUndo", id });
      const { conversation, transcript } = session.undo;
      if (transcript !== null) transcripts.set(conversation, transcript);
      heldConversations.delete(conversation);
      const next = again(id, session, conversation);
      return { id: next.id, sessionId: next.sessionId, files: [], fallback: null, error: null };
    },

    held(heldOptions) {
      fake.calls.push({ method: "held", options: heldOptions });
      return heldOptions.agent === "claude-code" && heldConversations.has(heldOptions.session);
    },

    terminalResume(session, bringBack) {
      if (!heldConversations.has(session)) return;
      if (!bringBack) throw new Error(`held: ${TERMINAL_HELD}`);
      heldConversations.delete(session);
    },

    stop(id) {
      live(id);
      fake.calls.push({ method: "stop", id });
      later(() => fake.end(id, true));
    },

    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    replay(id, events) {
      for (const body of events) {
        const event = { ...body, id } as IntegratedEvent;
        fake.events.push(event);
        for (const handler of handlers) handler(event);
      }
    },

    ready(id) {
      const session = live(id);
      const ready = session.heldReady;
      if (ready === null) throw new Error("the agent said it was ready already");
      session.heldReady = null;
      fake.emit(id, ready);
    },

    commands(id, commands) {
      fake.emit(id, { type: "commands", commands });
    },

    emit(id, body) {
      const session = sessions.get(id);
      if (!session || session.ended) return;
      const told = new Map(session.told);
      switch (body.type) {
        case "ready":
        case "configured":
          session.settings = { model: body.model, mode: body.mode, effort: body.effort };
          session.efforts = body.efforts;
          if (body.type === "ready") session.ready = body;
          break;
        case "commands":
          if (session.ready !== null) session.ready = { ...session.ready, commands: body.commands };
          break;
        case "turnStarted": {
          const messages = body.messages.filter((m) => session.pending.includes(m));
          if (session.turn) {
            for (const message of messages)
              fake.emit(id, { ...movedOn(message, "taken"), error: null });
            return;
          }
          session.turn = true;
          session.turned = true;
          session.reporting = false;
          session.pending = session.pending.filter((m) => !messages.includes(m));
          for (const message of messages) session.told.delete(message);
          body = { type: "turnStarted", messages };
          break;
        }
        case "message": {
          const message = body.message;
          if (body.state === "taken" || body.state === "dropped" || body.state === "withdrawn") {
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
          // Codex withdraws what the turn asked when it ends, with no answer.
          if (session.codex)
            for (const request of [...session.asked.keys()]) fake.emit(id, { type: "withdrawn", request });
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
          if (body.kind === "agent" && !body.ambient) {
            session.subagents.set(body.task, body.call);
            session.starts.set(body.task, body);
          }
          break;
        case "taskFinished":
          session.tasks.delete(body.task);
          session.starts.delete(body.task);
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
        case "compactFailed":
          session.compacting = false;
          break;
        case "limits":
          session.limits = body;
          break;
        case "ended":
          session.ended = true;
          break;
      }
      remember(session, body, told);
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

    limits(id, windows, limitOptions = {}) {
      const session = live(id);
      const takenAt = limitOptions.takenAt ?? Math.floor(Date.now() / 1000);
      fake.emit(id, {
        type: "limits",
        agent: session.codex ? "codex" : "claude-code",
        plan: limitOptions.plan ?? null,
        windows: windows.map((window) => ({
          model: null,
          resetsAt: null,
          severity: null,
          ...window,
        })),
        readAt: limitOptions.readAt === undefined ? takenAt : limitOptions.readAt,
        takenAt,
      });
    },

    notice(id, message, level = "info") {
      fake.emit(id, { type: "notice", level, message });
    },

    expire(id, request) {
      fake.emit(id, { type: "withdrawn", request });
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

  /** Makes a session as a start asks, its ready event held for
      `announce`. */
  function open(startOptions: IntegratedStartOptions): IntegratedStarted {
    const id = `int-${++count}`;
    const codex = startOptions.agent === "codex";
    const sessionId =
      startOptions.session ?? (options.mints || codex ? null : `integrated-session-${count}`);
    const settings = {
      model: startOptions.model ?? (codex ? "gpt-5-codex" : RESOLVED),
      mode: options.ownMode ?? startOptions.mode ?? options.defaultMode ?? (codex ? "untrusted, workspace-write" : "default"),
      effort: startOptions.effort ?? null,
    };
    sessions.set(id, {
      codex,
      sessionId,
      settings,
      efforts: [],
      ready: null,
      heldReady: null,
      pending: [],
      told: new Map(),
      used: new Set(),
      turn: false,
      asked: new Map(),
      tasks: new Map(),
      subagents: new Map(),
      starts: new Map(),
      open: new Map(),
      streamed: new Map(),
      reporting: false,
      compacting: false,
      compactAsked: false,
      held: [],
      handed: null,
      state: null,
      ended: false,
      limits: null,
      resumedAt: startOptions.session ? Date.now() : null,
      started: startOptions,
      turned: false,
      undo: null,
    });
    // Before the caller has the id, as the core's own may arrive. An
    // agent that makes its own id says it here. Codex lists no commands.
    const ready: Extract<IntegratedEventBody, { type: "ready" }> = {
      type: "ready",
      sessionId: sessionId ?? `agent-thread-${count}`,
      ...settings,
      version: "0.0.0-fake",
      models: codex ? CODEX_MODELS : MODELS,
      modes: codex ? CODEX_MODES : MODES,
      efforts: efforts(settings.model),
      commands: codex ? [] : COMMANDS,
    };
    sessions.get(id)!.heldReady = ready;
    return { id, sessionId };
  }

  /** Says a session just made is ready, unless the test holds it. */
  function announce(id: string) {
    if (fake.holdReady) return;
    const session = sessions.get(id)!;
    const ready = session.heldReady;
    session.heldReady = null;
    if (ready !== null) fake.emit(id, ready);
  }

  /** Why a session is not at rest, which going back takes, in the core's
      words; null when it is. */
  function unrested(session: Session): string | null {
    if (session.ready === null) return "the agent is not ready yet";
    if (session.turn || session.reporting) return "a turn runs";
    if (session.compacting) return "the conversation is being compacted";
    if (session.pending.length > 0) return "a message waits for a turn";
    if (session.asked.size > 0) return "the agent waits for an answer";
    if (session.subagents.size > 0) return "a subagent is still at work";
    return null;
  }

  function conversationOf(session: Session): string | null {
    return session.sessionId ?? session.ready?.sessionId ?? null;
  }

  /** The messages of the user's in a session's transcript as it is kept
      now, and how far each can be gone back to, by the core's rules. */
  function pointsOf(session: Session): IntegratedPoints {
    const conversation = conversationOf(session);
    if (conversation === null) return { points: [], why: null };
    if (session.codex && fake.older.has(conversation)) return { points: [], why: OLDER };
    const written = transcripts.get(conversation) ?? [];
    let compacted = -1;
    written.forEach((item, at) => {
      if (item.event.type === "compacted") compacted = at;
    });
    const points: IntegratedPoint[] = [];
    written.forEach((item, at) => {
      const event = item.event;
      if (event.type !== "message" || points.some((point) => point.message === event.message)) return;
      const goes = session.codex
        ? event.state !== "taken"
        : points.length === 0 || at > compacted;
      points.push({
        message: event.message,
        conversation: goes,
        files: !session.codex && fake.files.has(event.message),
        why: goes ? null : session.codex ? TAKEN_INTO : COMPACTED,
      });
    });
    return { points, why: null };
  }

  /** Reads a conversation as far as a message from now on, as the core
      holds it there or Codex keeps it; answers the transcript as it was. */
  function cutAt(conversation: string, message: string): Written[] | null {
    const written = transcripts.get(conversation) ?? [];
    const at = written.findIndex(
      (item) => item.event.type === "message" && item.event.message === message,
    );
    if (at < 0) return null;
    transcripts.set(conversation, written.slice(0, at));
    return written;
  }

  /** Ends a session and starts it again as the core does: on the same
      start, on `conversation` or a new one, on the settings it runs on and
      a mode it offers, ready before the answer. */
  function again(id: string, session: Session, conversation: string | undefined) {
    const mode = session.settings.mode;
    const offered = (session.codex ? CODEX_MODES : MODES).some((known) => known.value === mode);
    fake.end(id, true);
    const started = open({
      ...session.started,
      session: conversation,
      model: session.settings.model ?? undefined,
      mode: offered && mode !== null ? mode : undefined,
      effort: session.settings.effort ?? undefined,
    });
    const next = sessions.get(started.id)!;
    const ready = next.heldReady!;
    next.heldReady = null;
    fake.emit(started.id, ready);
    return { id: started.id, sessionId: ready.sessionId };
  }

  function live(id: string): Session {
    const session = sessions.get(id);
    if (!session || session.ended) throw new Error("no such session");
    return session;
  }

  /** Writes down what the agent writes into its transcript of an event:
      a message when a turn takes it, with what it said, the turn with the
      model it runs on where the agent keeps that, and what is said and
      done in whole. */
  function remember(session: Session, body: IntegratedEventBody, told: Map<string, Told>) {
    const conversation = session.sessionId ?? session.ready?.sessionId;
    if (!conversation) return;
    let written = transcripts.get(conversation);
    if (written === undefined) {
      written = [];
      transcripts.set(conversation, written);
    }
    if (session.codex) threads.add(conversation);
    const write = (event: IntegratedEventBody, model?: string | null) =>
      written.push({ at: Date.now(), event, ...(model ? { model } : {}) });
    const said = (message: string) => told.get(message);
    switch (body.type) {
      case "turnStarted":
        // A message taken from the point held writes the cut down.
        if (body.messages.length > 0) heldConversations.delete(conversation);
        for (const message of body.messages)
          write({
            type: "message",
            message,
            state: "sent",
            error: null,
            text: said(message)?.text ?? null,
            images: said(message)?.images ?? [],
          });
        write(body, session.codex ? null : session.settings.model);
        break;
      case "message":
        if (body.state === "taken")
          write({ ...body, text: said(body.message)?.text ?? body.text, images: said(body.message)?.images ?? [] });
        break;
      case "text":
      case "thinking":
        if (body.done) write(body);
        break;
      case "toolInput":
        if (body.delta === null) write(body);
        break;
      case "plan":
        if (!session.codex || body.text !== null) write(body);
        break;
      case "toolStarted":
      case "toolFinished":
      case "turnEnded":
      case "compacted":
        write(body);
        break;
    }
  }

  /** A message event after the first, with nothing of what it said. */
  function movedOn(message: string, state: "taken" | "dropped" | "withdrawn") {
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
      remember(session, {
        type: "toolFinished",
        call,
        parent,
        output: "",
        error: true,
        truncated: false,
        changes: [],
      }, new Map());
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
    if (session?.compactAsked) later(() => compactNow(id));
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

  // Kept across a reload: every call made from outside is written down,
  // and a fake made anew plays them again before anything listens. Calls
  // the fake makes on itself, and what it does later of its own accord,
  // follow from those and are not written down.
  if (options.keep !== undefined) {
    const key = options.keep;
    const log: { name: string; args: unknown[] }[] = (() => {
      try {
        return JSON.parse(sessionStorage.getItem(key) ?? "[]");
      } catch {
        return [];
      }
    })();
    const own = fake as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of Object.keys(own)) {
      const call = own[name];
      if (
        typeof call !== "function" ||
        [
          "subscribe",
          "snapshot",
          "history",
          "holdHistory",
          "releaseHistory",
          "holdAnswers",
          "releaseAnswers",
          "rewindPoints",
          "rewindPreview",
          "held",
        ].includes(name)
      )
        continue;
      own[name] = (...args: unknown[]) => {
        if (depth === 0 && !replaying) {
          log.push({ name, args });
          sessionStorage.setItem(key, JSON.stringify(log));
        }
        depth += 1;
        try {
          return call(...args);
        } finally {
          depth -= 1;
        }
      };
    }
    replaying = true;
    for (const { name, args } of [...log]) {
      try {
        own[name](...args);
      } catch {
        // A call that failed the first time fails again, as it should.
      }
    }
    replaying = false;
    fake.calls.length = 0;
    fake.events.length = 0;
  }

  return fake;
}
