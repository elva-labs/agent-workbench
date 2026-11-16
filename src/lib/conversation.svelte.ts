import type {
  IntegratedEventBody,
  IntegratedFileChange,
  IntegratedHistory,
  IntegratedImage,
  IntegratedPlanStep,
  IntegratedQuestion,
  IntegratedSettings,
  IntegratedSnapshot,
  IntegratedState,
  IntegratedToolKind,
  IntegratedUsage,
  PermissionChoice,
} from "$lib/core";
import { SvelteSet } from "svelte/reactivity";
import { asks, phraseText } from "$lib/thread";

/**
 * One integrated session's conversation, built from the core's events and
 * nothing else.
 *
 * The thread is a list of entries in the order they happened: the user's
 * messages, the agent's runs, and the few things that belong to neither,
 * such as a compaction or a notice. A run holds what the agent said and did
 * in order: text and thinking as they stream, tool calls with their input,
 * output and result, plans, and the questions it asked. A subagent's own
 * text and calls hang under the call that started it, and so do the tasks a
 * call started.
 *
 * Events can arrive with pieces missing: a gap in a streamed block, which a
 * skipped event marks and the whole that follows mends; a block that ends
 * with no whole, which the end of its turn or of the session closes; a call
 * or a subagent that a window coming late never saw start. None of these
 * is an error here: what is known is drawn, and nothing waits for what will
 * not come.
 *
 * What the conversation said before the window took it up, read from where
 * the agent keeps it, comes as the same events with the time each
 * happened, and is laid above whatever the thread already holds. What it
 * holds twice, a call, a block or a message both read and heard, is drawn
 * once, by its id.
 */

/** Where a run of a conversation began: `at`, when, or null where no run
    has begun since, and `since`, the time from which what was read belongs
    to it, or null where all of it is from before. */
export interface Run {
  at: number | null;
  since: number | null;
}

export type MessageState =
  /** Handed to the core, with no word back yet. */
  | "sending"
  /** Went to the agent with nothing ahead of it. */
  | "sent"
  /** Waits behind a running turn. */
  | "queued"
  /** In a turn: taken into the running one, or answered by one. */
  | "taken"
  /** Will not be answered: the agent refused, discarded or cancelled it. */
  | "dropped"
  /** Never reached the core. */
  | "failed";

export interface Message {
  id: string;
  text: string;
  images: IntegratedImage[];
  state: MessageState;
  error: string | null;
  /** When the window first heard of it; null for one read from a snapshot. */
  at: number | null;
  /** Whether it stands in the thread, rather than waiting under it. */
  placed: boolean;
}

interface Timed {
  /** When the window first heard of it. */
  at: number;
  /** When it was last heard of: its end, once it has one. */
  until: number;
}

export interface TextPart extends Timed {
  kind: "text" | "thinking";
  block: string;
  text: string;
  done: boolean;
  /** Pieces of it were left out on the way, and no whole has mended it. */
  gap: boolean;
}

export interface Task extends Timed {
  task: string;
  call: string | null;
  kind: "agent" | "shell" | "other";
  description: string | null;
  prompt: string | null;
  background: boolean;
  /** Housekeeping the agent does on its own account. */
  ambient: boolean;
  status: "running" | "completed" | "failed" | "stopped" | "lost";
  summary: string | null;
  /** The tool it last said it was using. */
  tool: string | null;
}

export interface ToolCall extends Timed {
  kind: "tool";
  call: string;
  parent: string | null;
  /** The agent's own name for the tool. */
  name: string;
  tool: IntegratedToolKind;
  /** The input once whole, in the agent's own shape. */
  input: unknown;
  /** The input as it streams, as JSON text. */
  inputText: string;
  inputDone: boolean;
  inputTruncated: boolean;
  /** The output as it streams, for an agent that streams it. */
  output: string;
  /** Pieces of the input or output were left out on the way. */
  gap: boolean;
  done: boolean;
  error: boolean;
  /** The result as text, once finished. */
  result: string | null;
  truncated: boolean;
  changes: IntegratedFileChange[];
  /** What a subagent this call started said and did. */
  parts: Part[];
  /** The tasks this call started. */
  tasks: Task[];
  /** How the user answered a permission the call asked for. */
  answer: { choice: PermissionChoice; message: string | null } | null;
  /** The agent withdrew a permission the call asked for before it was
      answered. */
  withdrawn: boolean;
  /** The call is how the agent keeps or proposes its plan: a plan event
      named it. */
  plan: boolean;
}

export interface PlanPart extends Timed {
  kind: "plan";
  call: string | null;
  text: string | null;
  steps: IntegratedPlanStep[];
}

export interface QuestionPart extends Timed {
  kind: "question";
  request: string;
  questions: IntegratedQuestion[];
  /** Per question, the answer; null in place of a secret one. */
  answers: (string[] | null)[] | null;
  outcome: "open" | "answered" | "declined" | "withdrawn";
}

export type Part = TextPart | ToolCall | PlanPart | QuestionPart;

export interface Turn {
  id: number;
  /** The messages it answers; none for a turn the agent began itself. */
  messages: string[];
  /** The model it ran on, as the session's settings had it at its start. */
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  outcome: "done" | "interrupted" | "failed" | null;
  error: string | null;
  durationMs: number | null;
  usage: IntegratedUsage | null;
  totalCostUsd: number | null;
  /** Everything the turn has changed so far, for an agent that keeps it. */
  diff: { diff: string; truncated: boolean } | null;
  /** A request to the model failed and the agent tries again. */
  retrying: { message: string; attempt: number | null; attempts: number | null } | null;
}

export type Entry =
  | { kind: "user"; key: string; message: string }
  | { kind: "agent"; key: string; turn: number; parts: Part[]; at: number | null }
  | {
      kind: "note";
      key: string;
      tone: "info" | "warning" | "error";
      text: string;
      at: number;
    }
  | {
      kind: "compaction";
      key: string;
      done: boolean;
      /** It ended without compacting: it failed, or its turn ended first. */
      failed: boolean;
      error: string | null;
      reason: "asked" | "full" | null;
      tokensBefore: number | null;
      tokensAfter: number | null;
      at: number;
    };

type Asked = Extract<IntegratedEventBody, { type: "permissionAsked" | "questionAsked" }>;
type Ready = Extract<IntegratedEventBody, { type: "ready" }>;

export interface Request {
  request: string;
  asked: Asked;
  state: "open" | "answered" | "withdrawn";
  answer: {
    choice: PermissionChoice;
    answers: (string[] | null)[] | null;
    message: string | null;
  } | null;
  /** An answer is on its way from this window. */
  answering: boolean;
  /** Why the core refused this window's answer. */
  error: string | null;
  at: number | null;
}

export class Conversation {
  /** The agent's id for the conversation, the one resuming takes. */
  sessionId = $state<string | null>(null);
  /** What the agent said of itself and what it offers, once ready, with
      its commands as they now are. */
  ready = $state<Ready | null>(null);
  settings = $state<IntegratedSettings>({ model: null, mode: null, effort: null });
  /** The efforts the model it runs on takes. */
  efforts = $state<string[]>([]);
  /** The session's state, as its last state event said. */
  state = $state<IntegratedState | null>(null);
  entries = $state<Entry[]>([]);
  messages = $state<Record<string, Message>>({});
  /** Message ids in the order the window heard of them. */
  order = $state<string[]>([]);
  turns = $state<Record<number, Turn>>({});
  /** The running turn's id. */
  current = $state<number | null>(null);
  requests = $state<Request[]>([]);
  /** Every task heard of, in the order they started. */
  tasks = $state<Task[]>([]);
  context = $state<{ used: number | null; size: number | null } | null>(null);
  compacting = $state(false);
  /** An interrupt was asked for and the turn has not ended yet. */
  interrupting = $state(false);
  /** How many streamed pieces were left out on the way, all told. */
  skipped = $state(0);
  /** The agent said the account it runs under is not signed in. */
  notLoggedIn = $state(false);
  errors = $state<{ kind: string; message: string }[]>([]);
  ended = $state<{ code: number | null; clean: boolean } | null>(null);
  /** Rebuilt from a snapshot: the turns before it are in the transcript. */
  late = $state(false);
  /** Where reading what was said before stands: not asked for, on its
      way, laid in the thread, or not read, for an agent whose history is
      not read here or a read that failed. */
  earlier = $state<"loading" | "read" | "unread" | null>(null);
  /** Why what was said before could not be read, where the read failed
      and said why. */
  earlierWhy = $state<string | null>(null);
  /** What was read leaves out the start of the conversation, it being
      too long to hold. */
  earlierCut = $state(false);
  /** Where this run of a conversation it resumed began: after the entry
      with this key, or at the top while nothing before it is drawn, at
      this time. */
  began = $state<{ after: string | null; at: number } | null>(null);
  /** How many messages this window has sent. */
  sentHere = $state(0);
  /** The folds of the thread that stand open, by `foldKey`. Kept with the
      conversation, so a fold stays open while the thread does not draw it. */
  opened = new SvelteSet<string>();
  /** A model chosen while a turn ran, which the turn after it runs on. */
  nextModel = $state<{ model: string | null; turn: number } | null>(null);
  /** When the latest turn to end ended; null before any has. */
  turnEnded = $state<number | null>(null);
  /** Goes up whenever what the thread holds may change, so what follows
      it, find among them, knows when to read it again without reading all
      of it to tell. */
  revision = $state(0);

  #clock: () => number;
  #blocks = new Map<string, TextPart>();
  #calls = new Map<string, ToolCall>();
  #taskIndex = new Map<string, Task>();
  #turnCount = 0;
  /** Turns made for runs no turn of the agent's held: what a subagent this
      window never saw start said, or what a window that came late heard of
      a turn before it knew one ran. */
  #loose = new Set<number>();
  #entryCount = 0;
  #revisions = 0;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  /** Marks what the thread holds as changing. Written, never read, here,
      so a change made while something reads the conversation does not
      make that read again for its own sake. */
  #changed() {
    this.revision = ++this.#revisions;
  }

  /** The model the session goes on to once the running turn ends, when it
      was changed during the turn; null otherwise. */
  get modelAfterTurn(): string | null {
    const next = this.nextModel;
    return next !== null && this.current === next.turn ? next.model : null;
  }

  get turn(): Turn | null {
    return this.current === null ? null : (this.turns[this.current] ?? null);
  }

  /** The requests still waiting for an answer, in the order asked. */
  get open(): Request[] {
    return this.requests.filter((request) => request.state === "open");
  }

  /** The messages not standing in the thread: sending, waiting, or failed
      to send, in the order sent. */
  get waiting(): Message[] {
    return this.order
      .map((id) => this.messages[id])
      .filter((message) => message !== undefined && !message.placed);
  }

  /** Whether the agent is at work on something: a turn, a compaction, a
      message about to start a turn, or a subagent that will report. */
  get working(): boolean {
    return this.current !== null || this.state === "working" || this.compacting;
  }

  call(id: string): ToolCall | null {
    return this.#calls.get(id) ?? null;
  }

  /** The window is sending a message under an id it chose. */
  sending(id: string, text: string, images: IntegratedImage[] = []) {
    this.#changed();
    if (this.messages[id] !== undefined) return;
    this.messages[id] = {
      id,
      text,
      images,
      state: "sending",
      error: null,
      at: this.#clock(),
      placed: false,
    };
    this.order.push(id);
    this.sentHere += 1;
  }

  /** The core refused the message: it never reached the agent. */
  sendFailed(id: string, error: string) {
    this.#changed();
    const message = this.messages[id];
    if (message === undefined || message.state !== "sending") return;
    message.state = "failed";
    message.error = error;
  }

  /** A failed message is taken back, its words to be sent again. */
  forget(id: string) {
    this.#changed();
    const message = this.messages[id];
    if (message === undefined || message.placed) return;
    delete this.messages[id];
    this.order = this.order.filter((known) => known !== id);
  }

  /** This window is answering a request. */
  answering(request: string, on: boolean, error: string | null = null) {
    const found = this.requests.find((known) => known.request === request);
    if (found === undefined) return;
    found.answering = on;
    found.error = error;
  }

  /** Whether nothing has been said or done in the conversation: no message
      sent, by this window or another, no turn run, nothing asked and
      nothing of an earlier run read or due. Notes the agent made as it
      started may stand. */
  get untouched(): boolean {
    return (
      this.order.length === 0 &&
      Object.keys(this.turns).length === 0 &&
      this.requests.length === 0 &&
      !this.compacting &&
      !this.late &&
      this.earlier === null &&
      this.began === null &&
      this.entries.every((entry) => entry.kind === "note")
    );
  }

  /** The session starts again on another run before anything was said in
      it: nothing its last run said stands. With the same agent, what the
      agent offers, the mode and the effort stay until the new run says its
      own, so the controls that show them stay as they were; the model is
      the one the new run is started on. */
  restarted(model: string | null, sameAgent: boolean) {
    this.sessionId = null;
    if (sameAgent) this.settings = { ...this.settings, model };
    else {
      this.ready = null;
      this.settings = { model, mode: null, effort: null };
      this.efforts = [];
    }
    this.state = null;
    this.entries = [];
    this.messages = {};
    this.order = [];
    this.turns = {};
    this.current = null;
    this.requests = [];
    this.tasks = [];
    this.context = null;
    this.compacting = false;
    this.interrupting = false;
    this.skipped = 0;
    this.notLoggedIn = false;
    this.errors = [];
    this.ended = null;
    this.nextModel = null;
    this.opened.clear();
    this.#blocks.clear();
    this.#calls.clear();
    this.#taskIndex.clear();
    this.#loose.clear();
  }

  /** The session starts again after it ended: what ended it is over, and
      the thread goes on under it. */
  resumed() {
    this.#changed();
    this.ended = null;
    this.notLoggedIn = false;
    this.state = null;
    this.interrupting = false;
    this.compacting = false;
  }

  /** This run begins after what the thread holds now; with nothing in
      it, there is nothing before it to set it apart from. */
  beganHere(at: number) {
    const last = this.entries[this.entries.length - 1];
    this.began = last === undefined ? null : { after: last.key, at };
  }

  /** This run begins before what was said before is in: its line stands
      at the top, what this run says goes under it, and what was said
      before goes above it once read. */
  beganAbove(at: number) {
    this.began = { after: null, at };
  }

  /** What was said before was not read, and `why` where the read said:
      no line stands for it. */
  unread(why: string | null = null) {
    this.earlier = "unread";
    this.earlierWhy = why;
    if (this.began?.after === null) this.began = null;
  }

  /**
   * Lays what the conversation said and did before above what the thread
   * holds, each event at the time it happened, and marks where `run`
   * began: before the first of the main thread's events from its `since`
   * on, or after all of it, where a line already stands at the top or the
   * run has a time. A turn left open by what was read is this run's,
   * which the session's own events and snapshot settle, unless all of it
   * is from before, or the thread already has a turn running: then it is
   * over, and with all of it from before its calls with no finish failed.
   */
  lay(history: IntegratedHistory, run: Run | null) {
    this.#changed();
    const later = this.entries;
    const running = this.current;
    this.entries = [];
    this.current = null;
    let after: string | null | undefined;
    for (const item of history.items) {
      const main = !("parent" in item.event) || item.event.parent === null;
      if (after === undefined && run !== null && run.since !== null && main && item.at >= run.since)
        after = this.entries[this.entries.length - 1]?.key ?? null;
      this.apply(item.event, item.at);
      if (item.event.type === "turnStarted" && item.model !== undefined) {
        const turn = this.turn;
        if (turn !== null) turn.model = item.model;
      }
    }
    if (after === undefined) after = this.entries[this.entries.length - 1]?.key ?? null;
    const left = this.current;
    this.entries = [...this.entries, ...later];
    this.current = running;
    if (left !== null) {
      const over = run !== null && run.since === null;
      if (over || running !== null || later.length > 0) this.#endRead(left, over);
      else this.current = left;
    }
    if (run !== null && run.since !== null) {
      if (after !== null) this.began = { after, at: run.at ?? run.since };
    } else if (run !== null) {
      const at = this.began?.after === null ? this.began.at : run.at;
      if (at !== null) this.began = { after, at };
    }
    this.earlierCut = history.cut;
    this.earlier = "read";
    this.earlierWhy = null;
    this.late = false;
  }

  /** Ends a turn that was read with no end: its blocks are whole, and
      with `failed` its calls with no finish failed, as the core says of a
      live session's when its turn ends. */
  #endRead(id: number, failed: boolean) {
    const turn = this.turns[id];
    if (turn === undefined) return;
    turn.endedAt = turn.endedAt ?? turn.startedAt;
    // It ended once the last of what was read of it was over.
    let last = turn.endedAt ?? Number.NEGATIVE_INFINITY;
    for (const entry of this.entries) {
      if (entry.kind !== "agent" || entry.turn !== id) continue;
      for (const part of entry.parts) {
        if ((part.kind === "text" || part.kind === "thinking") && !part.done) part.done = true;
        if (failed && part.kind === "tool" && !part.done) {
          part.done = true;
          part.error = true;
          part.result = part.output;
          part.inputDone = true;
        }
        last = Math.max(last, part.until);
      }
    }
    if (last > (this.turnEnded ?? Number.NEGATIVE_INFINITY)) this.turnEnded = last;
  }

  /** Every event of the session, in the order it came, at the time it
      happened: now, unless it says. */
  apply(event: IntegratedEventBody, at?: number) {
    this.#changed();
    const now = at ?? this.#clock();
    switch (event.type) {
      case "ready":
        this.sessionId = event.sessionId;
        this.ready = event;
        this.settings = { model: event.model, mode: event.mode, effort: event.effort };
        this.efforts = [...event.efforts];
        break;
      case "commands":
        if (this.ready !== null) this.ready = { ...this.ready, commands: event.commands };
        break;
      case "configured":
        if (this.current !== null && event.model !== this.settings.model)
          this.nextModel = { model: event.model, turn: this.current };
        this.settings = { model: event.model, mode: event.mode, effort: event.effort };
        this.efforts = [...event.efforts];
        break;
      case "message":
        this.#message(event, now);
        break;
      case "turnStarted":
        this.#startTurn(event.messages, now);
        break;
      case "turnEnded":
        this.#endTurn(event, now);
        break;
      case "text":
      case "thinking":
        this.#streamed(event.type, event.block, event.parent, event.text, event.done, now);
        break;
      case "toolStarted": {
        if (this.#calls.has(event.call)) break;
        this.#settleRetry();
        const parts = this.#container(event.parent, now);
        parts.push({
          kind: "tool",
          call: event.call,
          parent: event.parent,
          name: event.name,
          tool: event.kind,
          input: null,
          inputText: "",
          inputDone: false,
          inputTruncated: false,
          output: "",
          gap: false,
          done: false,
          error: false,
          result: null,
          truncated: false,
          changes: [],
          parts: [],
          tasks: [],
          answer: null,
          withdrawn: false,
          plan: false,
          at: now,
          until: now,
        });
        const made = parts[parts.length - 1] as ToolCall;
        this.#calls.set(event.call, made);
        // A task heard of before its call, from a snapshot, is the call's.
        for (const task of this.tasks) if (task.call === event.call) made.tasks.push(task);
        break;
      }
      case "toolInput": {
        const call = this.#calls.get(event.call);
        if (call === undefined || call.inputDone) break;
        call.until = now;
        if (event.delta !== null) call.inputText += event.delta;
        else {
          call.input = event.input;
          call.inputDone = true;
          call.inputTruncated = event.truncated;
        }
        break;
      }
      case "toolOutput": {
        const call = this.#calls.get(event.call);
        if (call === undefined || call.done) break;
        call.output += event.delta;
        call.until = now;
        break;
      }
      case "toolFinished": {
        const call = this.#calls.get(event.call);
        if (call === undefined || call.done) break;
        call.done = true;
        call.error = event.error;
        call.result = event.output;
        call.truncated = event.truncated;
        call.changes = event.changes;
        call.gap = false;
        call.until = now;
        // A call that never said its input whole has what streamed of it,
        // and a subagent's blocks end with the call that started it.
        if (!call.inputDone) call.inputDone = true;
        this.#closeParts(call.parts, now);
        break;
      }
      case "plan": {
        if (event.call !== null) {
          const call = this.#calls.get(event.call);
          if (call !== undefined) call.plan = true;
        }
        const parts = this.#container(event.parent, now);
        const plan = this.#planIn(parts);
        if (plan !== null) {
          plan.text = event.text;
          plan.steps = event.steps;
          plan.call = event.call;
          plan.until = now;
        } else
          parts.push({
            kind: "plan",
            call: event.call,
            text: event.text,
            steps: event.steps,
            at: now,
            until: now,
          });
        break;
      }
      case "turnDiff": {
        const turn = this.turn;
        if (turn !== null) turn.diff = { diff: event.diff, truncated: event.truncated };
        break;
      }
      case "permissionAsked":
      case "questionAsked":
        this.#asked(event, now);
        break;
      case "answered": {
        const request = this.requests.find((known) => known.request === event.request);
        if (request === undefined || request.state !== "open") break;
        request.state = "answered";
        request.answering = false;
        request.answer = {
          choice: event.choice,
          answers: event.answers,
          message: event.message,
        };
        if (request.asked.type === "permissionAsked" && request.asked.call !== null) {
          const call = this.#calls.get(request.asked.call);
          if (call !== undefined) call.answer = { choice: event.choice, message: event.message };
        }
        const question = this.#question(event.request);
        if (question !== null) {
          question.outcome = event.choice === "deny" ? "declined" : "answered";
          question.answers = event.answers;
          question.until = now;
        }
        break;
      }
      case "withdrawn":
        this.#withdraw(event.request, now);
        break;
      case "taskStarted": {
        if (this.#taskIndex.has(event.task)) break;
        const task: Task = {
          task: event.task,
          call: event.call,
          kind: event.kind,
          description: event.description,
          prompt: event.prompt,
          background: event.background,
          ambient: event.ambient,
          status: "running",
          summary: null,
          tool: null,
          at: now,
          until: now,
        };
        const call = event.call === null ? undefined : this.#calls.get(event.call);
        let live: Task;
        if (call !== undefined) {
          call.tasks.push(task);
          live = call.tasks[call.tasks.length - 1];
          this.tasks.push(live);
        } else {
          this.tasks.push(task);
          live = this.tasks[this.tasks.length - 1];
        }
        this.#taskIndex.set(event.task, live);
        break;
      }
      case "taskProgress": {
        const task = this.#taskIndex.get(event.task);
        if (task === undefined) break;
        if (event.tool !== null) task.tool = event.tool;
        if (event.description !== null) task.description = event.description;
        task.until = now;
        break;
      }
      case "taskFinished": {
        const task = this.#taskIndex.get(event.task);
        if (task === undefined || task.status !== "running") break;
        task.status = event.status;
        task.summary = event.summary;
        task.until = now;
        const call = task.call === null ? undefined : this.#calls.get(task.call);
        if (call !== undefined) this.#closeParts(call.parts, now);
        break;
      }
      case "compacting":
        this.compacting = true;
        this.#push({
          kind: "compaction",
          key: "",
          done: false,
          failed: false,
          error: null,
          reason: null,
          tokensBefore: null,
          tokensAfter: null,
          at: now,
        });
        break;
      case "compacted": {
        this.compacting = false;
        const open = this.entries.findLast(
          (entry) => entry.kind === "compaction" && !entry.done,
        );
        if (open !== undefined && open.kind === "compaction") {
          open.done = true;
          open.reason = event.reason;
          open.tokensBefore = event.tokensBefore;
          open.tokensAfter = event.tokensAfter;
        } else
          this.#push({
            kind: "compaction",
            key: "",
            done: true,
            failed: false,
            error: null,
            reason: event.reason,
            tokensBefore: event.tokensBefore,
            tokensAfter: event.tokensAfter,
            at: now,
          });
        break;
      }
      case "compactFailed":
        this.#compactionOver(event.error, now);
        break;
      case "context":
        this.context = { used: event.used, size: event.size };
        break;
      case "notice":
        this.#push({
          kind: "note",
          key: "",
          tone: event.level === "warning" ? "warning" : "info",
          text: event.message,
          at: now,
        });
        break;
      case "skipped":
        this.skipped += event.pieces;
        for (const block of this.#blocks.values()) if (!block.done) block.gap = true;
        for (const call of this.#calls.values()) if (!call.done) call.gap = true;
        break;
      case "retrying": {
        const turn = this.turn;
        if (turn !== null)
          turn.retrying = {
            message: event.message,
            attempt: event.attempt,
            attempts: event.attempts,
          };
        break;
      }
      case "state":
        this.state = event.state;
        // An interrupt while no turn ran is over once the state is told: it
        // stopped what the session waited on, or there was nothing to stop.
        if (this.current === null) this.interrupting = false;
        break;
      case "error":
        this.errors.push({ kind: event.kind, message: event.message });
        if (event.kind === "notLoggedIn") this.notLoggedIn = true;
        else this.#push({ kind: "note", key: "", tone: "error", text: event.message, at: now });
        break;
      case "ended":
        this.#end(event.code, event.clean, now);
        break;
    }
  }

  /**
   * Takes what a window that comes late reads: the state, the settings and
   * what the agent offers, the requests still open and the messages no
   * turn has taken. It reflects every event before it, so it is laid over
   * whatever was heard before it, and the events after it follow as usual.
   */
  restore(snapshot: IntegratedSnapshot) {
    this.#changed();
    const now = this.#clock();
    this.late = true;
    if (snapshot.ready !== null) {
      this.sessionId = snapshot.ready.sessionId;
      this.ready = snapshot.ready;
    }
    this.settings = { ...snapshot.settings };
    this.efforts = [...snapshot.efforts];
    this.state = snapshot.state;
    if (snapshot.turn && this.current === null) this.#adoptTurn();
    else if (!snapshot.turn && this.current !== null) this.#closeTurn(now);
    if (!snapshot.turn)
      for (const entry of this.entries)
        if (entry.kind === "agent" && this.#loose.has(entry.turn)) this.#closeParts(entry.parts, now);
    const open = new Set(snapshot.requests.map((asked) => asked.request));
    for (const request of this.requests)
      if (request.state === "open" && !open.has(request.request))
        this.#withdraw(request.request, now);
    for (const asked of snapshot.requests) this.#asked(asked, null);
    // The subagents still at work, which no transcript holds: one whose
    // call is not heard of yet joins it when it comes.
    for (const started of snapshot.tasks ?? []) this.apply(started, now);
    for (const told of snapshot.messages) {
      const known = this.messages[told.message];
      if (known === undefined) {
        this.messages[told.message] = {
          id: told.message,
          text: told.text ?? "",
          images: told.images,
          state: told.state === "queued" ? "queued" : "sent",
          error: null,
          at: null,
          placed: false,
        };
        this.order.push(told.message);
      } else if (known.state === "sending") known.state = told.state === "queued" ? "queued" : "sent";
    }
  }

  #push(entry: Entry): Entry {
    entry.key = `e${++this.#entryCount}`;
    this.entries.push(entry);
    return this.entries[this.entries.length - 1];
  }

  #message(event: Extract<IntegratedEventBody, { type: "message" }>, now: number) {
    let message = this.messages[event.message];
    if (message === undefined) {
      this.messages[event.message] = {
        id: event.message,
        text: event.text ?? "",
        images: event.images,
        state: "sending",
        error: null,
        at: now,
        placed: false,
      };
      this.order.push(event.message);
      message = this.messages[event.message];
    } else if (event.text !== null && message.text === "") {
      message.text = event.text;
      message.images = event.images;
    }
    switch (event.state) {
      case "sent":
        if (message.state === "sending") message.state = "sent";
        if (this.current === null) this.#place(message);
        break;
      case "queued":
        if (message.state === "sending") message.state = "queued";
        break;
      case "taken":
        message.state = "taken";
        if (!message.placed) {
          this.#place(message);
          const turn = this.turn;
          if (turn !== null) {
            if (!turn.messages.includes(message.id)) turn.messages.push(message.id);
            // What the agent says after it took the message follows it.
            this.#push({ kind: "agent", key: "", turn: turn.id, parts: [], at: now });
          }
        }
        break;
      case "dropped":
        message.state = "dropped";
        message.error = event.error;
        if (!message.placed) this.#place(message);
        break;
      // Taken back before the agent took it: its words went back to the
      // composer of the window that took it, and it leaves every thread.
      case "withdrawn":
        this.forget(message.id);
        break;
    }
  }

  #place(message: Message) {
    if (message.placed) return;
    message.placed = true;
    this.#push({ kind: "user", key: "", message: message.id });
  }

  #startTurn(messages: string[], now: number | null) {
    if (this.current !== null) this.#closeTurn(now ?? this.#clock());
    for (const id of messages) {
      let message = this.messages[id];
      if (message === undefined) {
        this.messages[id] = {
          id,
          text: "",
          images: [],
          state: "taken",
          error: null,
          at: now,
          placed: false,
        };
        this.order.push(id);
        message = this.messages[id];
      }
      message.state = "taken";
      this.#place(message);
    }
    const id = ++this.#turnCount;
    this.turns[id] = {
      id,
      messages: [...messages],
      model: this.settings.model,
      startedAt: now,
      endedAt: null,
      outcome: null,
      error: null,
      durationMs: null,
      usage: null,
      totalCostUsd: null,
      diff: null,
      retrying: null,
    };
    this.current = id;
    this.#push({ kind: "agent", key: "", turn: id, parts: [], at: now });
  }

  /** A compaction ends without compacting: the open one says so, or one
      that never said it began. */
  #compactionOver(error: string | null, now: number) {
    this.compacting = false;
    const open = this.entries.findLast((entry) => entry.kind === "compaction" && !entry.done);
    if (open !== undefined && open.kind === "compaction") {
      open.done = true;
      open.failed = true;
      open.error = error;
    } else
      this.#push({
        kind: "compaction",
        key: "",
        done: true,
        failed: true,
        error,
        reason: null,
        tokensBefore: null,
        tokensAfter: null,
        at: now,
      });
  }

  #endTurn(event: Extract<IntegratedEventBody, { type: "turnEnded" }>, now: number) {
    // A compaction is over with its turn, as the core counts it, whether
    // or not the agent said how it went.
    if (this.compacting) this.#compactionOver(null, now);
    if (this.current === null) this.#startTurn([], now);
    const turn = this.turn!;
    turn.outcome = event.outcome;
    turn.error = event.error;
    turn.durationMs = event.durationMs;
    turn.usage = event.usage;
    turn.totalCostUsd = event.totalCostUsd;
    this.#closeTurn(now);
  }

  /** Ends the running turn here: its blocks are as whole as they will get. */
  #closeTurn(now: number) {
    const turn = this.turn;
    if (turn === null) return;
    turn.endedAt = now;
    turn.retrying = null;
    if (this.turnEnded === null || now > this.turnEnded) this.turnEnded = now;
    // No run of a turn numbered before this one stands after this one's
    // first run, so the walk back from the end stops at such a run.
    for (let at = this.entries.length - 1; at >= 0; at--) {
      const entry = this.entries[at];
      if (entry.kind !== "agent") continue;
      if (entry.turn === turn.id) this.#closeParts(entry.parts, now);
      else if (entry.turn < turn.id) break;
    }
    this.current = null;
    this.interrupting = false;
  }

  /** The blocks in these parts that are still streaming end where they are. */
  #closeParts(parts: Part[], now: number) {
    for (const part of parts) {
      if ((part.kind === "text" || part.kind === "thinking") && !part.done) {
        part.done = true;
        part.until = now;
      }
    }
  }

  #streamed(
    kind: "text" | "thinking",
    block: string,
    parent: string | null,
    text: string,
    done: boolean,
    now: number,
  ) {
    let part = this.#blocks.get(block);
    if (part === undefined) {
      this.#settleRetry();
      const parts = this.#container(parent, now);
      parts.push({ kind, block, text, done, gap: false, at: now, until: now });
      part = parts[parts.length - 1] as TextPart;
      this.#blocks.set(block, part);
      return;
    }
    if (done) {
      part.text = text;
      part.done = true;
      part.gap = false;
    } else if (!part.done) part.text += text;
    part.until = now;
  }

  /** Where something said under `parent` goes: under the call that
      started its subagent, or in the agent's run in the main thread. A
      subagent whose call this window never saw speaks in the main run. */
  #container(parent: string | null, now: number): Part[] {
    if (parent !== null) {
      const call = this.#calls.get(parent);
      if (call !== undefined) return call.parts;
    }
    const last = this.entries[this.entries.length - 1];
    const current = this.current;
    if (last?.kind === "agent" && (current === null || last.turn === current)) return last.parts;
    // Outside a turn only a subagent this window never saw start speaks
    // in the main thread: it gets a run of its own, in no running turn.
    const turn = current ?? this.#looseTurn(now);
    const entry = this.#push({ kind: "agent", key: "", turn, parts: [], at: now });
    return entry.kind === "agent" ? entry.parts : [];
  }

  /** The turn a snapshot says runs, which this window heard of only from
      the middle: what it heard of it before the snapshot, in runs no turn
      held, is that turn's, so the turn's end closes it. */
  #adoptTurn() {
    const trailing: Entry[] = [];
    for (let at = this.entries.length - 1; at >= 0; at--) {
      const entry = this.entries[at];
      if (entry.kind === "user") break;
      if (entry.kind === "agent") {
        if (!this.#loose.has(entry.turn)) break;
        trailing.push(entry);
      }
    }
    if (trailing.length === 0) {
      this.#startTurn([], null);
      return;
    }
    const first = trailing[trailing.length - 1];
    const id = first.kind === "agent" ? first.turn : ++this.#turnCount;
    this.#loose.delete(id);
    const turn = this.turns[id];
    turn.endedAt = null;
    for (const entry of trailing) if (entry.kind === "agent") entry.turn = id;
    this.current = id;
  }

  /** A turn for a run that no turn of the agent's holds, already over. */
  #looseTurn(now: number): number {
    const id = ++this.#turnCount;
    this.#loose.add(id);
    this.turns[id] = {
      id,
      messages: [],
      model: this.settings.model,
      startedAt: now,
      endedAt: now,
      outcome: null,
      error: null,
      durationMs: null,
      usage: null,
      totalCostUsd: null,
      diff: null,
      retrying: null,
    };
    return id;
  }

  /** The plan already drawn in these parts in the running turn. */
  #planIn(parts: Part[]): PlanPart | null {
    for (let at = parts.length - 1; at >= 0; at--) {
      const part = parts[at];
      if (part.kind === "plan") return part;
    }
    return null;
  }

  #asked(asked: Asked, now: number | null) {
    if (this.requests.some((known) => known.request === asked.request)) return;
    this.requests.push({
      request: asked.request,
      asked,
      state: "open",
      answer: null,
      answering: false,
      error: null,
      at: now,
    });
    if (asked.type === "questionAsked") {
      const at = now ?? this.#clock();
      this.#container(asked.parent, at).push({
        kind: "question",
        request: asked.request,
        questions: asked.questions,
        answers: null,
        outcome: "open",
        at,
        until: at,
      });
    }
  }

  #question(request: string): QuestionPart | null {
    const find = (parts: Part[]): QuestionPart | null => {
      for (const part of parts) {
        if (part.kind === "question" && part.request === request) return part;
        if (part.kind === "tool") {
          const found = find(part.parts);
          if (found !== null) return found;
        }
      }
      return null;
    };
    for (let at = this.entries.length - 1; at >= 0; at--) {
      const entry = this.entries[at];
      if (entry.kind !== "agent") continue;
      const found = find(entry.parts);
      if (found !== null) return found;
    }
    return null;
  }

  #withdraw(id: string, now: number) {
    const request = this.requests.find((known) => known.request === id);
    if (request === undefined || request.state !== "open") return;
    request.state = "withdrawn";
    request.answering = false;
    // A permission withdrawn leaves its trace: on the step that asked, or
    // as a note where the step is not known.
    if (request.asked.type === "permissionAsked") {
      const call = request.asked.call === null ? undefined : this.#calls.get(request.asked.call);
      if (call !== undefined) call.withdrawn = true;
      else
        this.#push({
          kind: "note",
          key: "",
          tone: "info",
          text: `The agent withdrew its request to ${phraseText(asks(request.asked))} before it was answered.`,
          at: now,
        });
    }
    const question = this.#question(id);
    if (question !== null && question.outcome === "open") {
      question.outcome = "withdrawn";
      question.until = now;
    }
  }

  /** Something new came after a retry: the request went through. */
  #settleRetry() {
    const turn = this.turn;
    if (turn !== null) turn.retrying = null;
  }

  #end(code: number | null, clean: boolean, now: number) {
    if (this.ended !== null) return;
    for (const block of this.#blocks.values())
      if (!block.done) {
        block.done = true;
        block.until = now;
      }
    for (const call of this.#calls.values())
      if (!call.done) {
        call.done = true;
        call.error = true;
        call.result = call.output;
        call.inputDone = true;
        call.until = now;
      }
    for (const task of this.#taskIndex.values())
      if (task.status === "running") {
        task.status = "lost";
        task.until = now;
      }
    for (const request of this.requests) if (request.state === "open") this.#withdraw(request.request, now);
    if (this.current !== null) {
      const turn = this.turn!;
      if (turn.outcome === null) {
        turn.outcome = "failed";
        turn.error = "the agent ended during the turn";
      }
      this.#closeTurn(now);
    }
    for (const id of this.order) {
      const message = this.messages[id];
      if (message.state === "sending" || message.state === "queued" || (message.state === "sent" && !message.placed)) {
        message.state = "dropped";
        message.error = message.error ?? "the session ended before the agent took it";
        this.#place(message);
      }
    }
    this.compacting = false;
    this.interrupting = false;
    this.ended = { code, clean };
  }
}
