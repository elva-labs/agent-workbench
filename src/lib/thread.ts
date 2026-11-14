import type { IntegratedEventBody, IntegratedToolKind, PermissionChoice, PermissionOffer } from "$lib/core";
import type { Conversation, Part, PlanPart, QuestionPart, TextPart, ToolCall } from "$lib/conversation.svelte";

/**
 * What the thread says, worked out from the conversation: how a run of the
 * agent's falls into what it said and what it did, the one line a stretch
 * of work folds into, what a tool call is called before and after it runs,
 * what the agent is doing now, and how a request is put to the user. Pure,
 * so the wording is tested apart from the drawing.
 */

/** A run as it is drawn: text as written, plans and questions in sight,
    and every stretch of work between them folded into one line. */
export type Segment =
  | { kind: "text"; part: TextPart }
  | { kind: "plan"; part: PlanPart }
  | { kind: "question"; part: QuestionPart }
  | { kind: "work"; parts: (ToolCall | TextPart)[]; key: string };

export function segments(parts: Part[]): Segment[] {
  const out: Segment[] = [];
  for (const part of parts) {
    if (part.kind === "text") out.push({ kind: "text", part });
    else if (part.kind === "plan") out.push({ kind: "plan", part });
    else if (part.kind === "question") {
      // An open question is in the dock; the thread draws it once settled.
      if (part.outcome !== "open") out.push({ kind: "question", part });
    } else {
      const last = out[out.length - 1];
      if (last?.kind === "work") last.parts.push(part);
      else
        out.push({
          kind: "work",
          parts: [part],
          key: part.kind === "tool" ? part.call : part.block,
        });
    }
  }
  return out;
}

/** A span of time as the thread says it: 12s, 3m, 1h 5m. */
export function span(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

const times = (count: number) =>
  count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
const plural = (count: number, one: string, many: string = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** Whether a call is the workbench's own `start`, which starts a session. */
export function startsSession(call: ToolCall): boolean {
  return call.tool === "mcp" && /(^|__)start$/.test(call.name) && /workbench/.test(call.name);
}

/** Calls that draw themselves elsewhere: the plan's own tools. */
function planTool(call: ToolCall): boolean {
  return call.name === "TodoWrite" || call.name === "ExitPlanMode";
}

/** A stretch of work in one line: how long, and what came of it. While it
    runs, how long so far. */
export function workSummary(
  parts: (ToolCall | TextPart)[],
  now: number,
): { running: boolean; head: string; detail: string } {
  const running = parts.some((part) => !part.done);
  const from = Math.min(...parts.map((part) => part.at));
  const to = running ? now : Math.max(...parts.map((part) => part.until));
  const files = new Set<string>();
  let commands = 0;
  let reads = 0;
  let searches = 0;
  let web = 0;
  let subagents = 0;
  let sessions = 0;
  let tools = 0;
  let failed = 0;
  for (const part of parts) {
    if (part.kind !== "tool" || planTool(part)) continue;
    if (part.done && part.error && part.answer?.choice !== "deny") failed += 1;
    if (part.changes.length > 0) for (const change of part.changes) files.add(change.to ?? change.path);
    else if (part.tool === "edit") {
      const path = inputPath(part.input);
      if (path !== null) files.add(path);
    }
    switch (part.tool) {
      case "command":
        commands += 1;
        break;
      case "read":
        reads += 1;
        break;
      case "search":
        searches += 1;
        break;
      case "web":
        web += 1;
        break;
      case "agent":
        subagents += 1;
        break;
      case "edit":
        break;
      default:
        if (startsSession(part)) sessions += 1;
        else tools += 1;
    }
  }
  const said = [
    files.size > 0 ? `changed ${plural(files.size, "file")}` : null,
    commands > 0 ? `ran ${plural(commands, "command")}` : null,
    reads > 0 ? `read ${plural(reads, "file")}` : null,
    searches > 0 ? `searched ${times(searches)}` : null,
    web > 0 ? `looked on the web ${times(web)}` : null,
    subagents > 0 ? `started ${plural(subagents, "subagent")}` : null,
    sessions > 0 ? `started ${plural(sessions, "session")}` : null,
    tools > 0 ? `used ${plural(tools, "tool")}` : null,
    failed > 0 ? `${failed} failed` : null,
  ].filter((part) => part !== null);
  const thought = parts.every((part) => part.kind === "thinking");
  const head = thought
    ? running
      ? "Thinking"
      : `Thought for ${span(to - from)}`
    : running
      ? `Working for ${span(to - from)}`
      : `Worked for ${span(to - from)}`;
  return { running, head, detail: said.join(", ") };
}

/** A path a tool's input names, in the shapes Claude Code's tools take. */
export function inputPath(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const fields = input as Record<string, unknown>;
  for (const name of ["file_path", "notebook_path", "path"]) {
    const value = fields[name];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function field(input: unknown, name: string): string | null {
  if (input === null || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The last segments of a path, enough to know the file by. */
export function shortPath(path: string, root: string | null = null): string {
  if (root !== null && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

/** An MCP tool's name split into the server and the tool. */
export function mcpName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match === null ? null : { server: match[1], tool: match[2] };
}

/** What a call is, as a step in the work: what it did, and the thing it
    did it to, which is drawn as code. Present tense while it runs. */
export function stepTitle(
  call: ToolCall,
  root: string | null = null,
): { verb: string; object: string | null } {
  const running = !call.done;
  const input = call.inputDone ? call.input : partialInput(call.inputText);
  const path = inputPath(input);
  const shown = path === null ? null : shortPath(path, root);
  const say = (now: string, then: string, object: string | null) => ({
    verb: running ? now : then,
    object,
  });
  if (call.name === "TodoWrite") return say("Updating the plan", "Updated the plan", null);
  if (call.name === "ExitPlanMode") return say("Proposing the plan", "Proposed the plan", null);
  switch (call.tool) {
    case "command":
      return say("Running", "Ran", firstLine(field(input, "command")));
    case "edit":
      return call.name === "Write"
        ? say("Writing", "Wrote", shown)
        : say("Editing", "Edited", shown);
    case "read":
      return say("Reading", "Read", shown);
    case "search": {
      const pattern = field(input, "pattern") ?? field(input, "query");
      return say("Searching for", "Searched for", pattern);
    }
    case "web": {
      const url = field(input, "url");
      if (url !== null) return say("Fetching", "Fetched", url);
      return say("Searching the web for", "Searched the web for", field(input, "query"));
    }
    case "agent": {
      const description = field(input, "description");
      return say("Working with a subagent on", "A subagent worked on", description);
    }
    case "mcp": {
      const named = mcpName(call.name);
      if (named === null) return say("Using", "Used", call.name);
      return say(`Using ${named.server}'s`, `Used ${named.server}'s`, named.tool);
    }
    default:
      return say("Using", "Used", call.name);
  }
}

/** The fields of an input still streaming as JSON, as far as they parse. */
function partialInput(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    // The usual shape is one object of strings: read what has closed.
    const fields: Record<string, string> = {};
    for (const match of text.matchAll(/"([a-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      try {
        fields[match[1]] = JSON.parse(`"${match[2]}"`);
      } catch {
        // A field cut in an escape is left for the whole.
      }
    }
    return fields;
  }
}

function firstLine(text: string | null): string | null {
  if (text === null) return null;
  const line = text.split("\n")[0];
  return line.length < text.length ? `${line} …` : line;
}

/** The deepest call still running in these parts, a subagent's own first. */
export function runningCall(parts: Part[]): ToolCall | null {
  for (let at = parts.length - 1; at >= 0; at--) {
    const part = parts[at];
    if (part.kind !== "tool" || part.done) continue;
    return runningCall(part.parts) ?? part;
  }
  return null;
}

/** What the agent is doing now, in a few words, or null when what it is
    doing is in sight: text streaming in, or nothing at all. */
export function nowDoing(conversation: Conversation, parts: Part[]): string | null {
  if (conversation.open.length > 0) return "Waiting for your answer";
  if (conversation.interrupting) return "Stopping";
  if (conversation.compacting) return "Compacting the conversation";
  const turn = conversation.turn;
  if (turn?.retrying) {
    const { message, attempt, attempts } = turn.retrying;
    const which = attempt !== null && attempts !== null ? `, attempt ${attempt} of ${attempts}` : "";
    return `Retrying after an error${which}: ${message}`;
  }
  const call = runningCall(parts);
  if (call !== null) {
    const { verb, object } = stepTitle(call);
    return object === null ? verb : `${verb} ${object}`;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined && last.kind === "thinking" && !last.done) return "Thinking";
  if (last !== undefined && last.kind === "text" && !last.done) return null;
  const subagents = conversation.tasks.filter(
    (task) => task.kind === "agent" && !task.ambient && task.status === "running",
  ).length;
  if (turn === null && subagents > 0)
    return `Waiting on ${plural(subagents, "subagent")} to report`;
  if (turn === null && conversation.waiting.some((message) => message.state === "sent"))
    return "Starting";
  return "Working";
}

/** The name the agent's runs go under: the model it ran on, or the agent's
    own name where the model is its default. */
export function speaker(conversation: Conversation, model: string | null): string {
  if (model === null || model === "default") return "Claude";
  const offered = conversation.ready?.models.find((option) => option.value === model);
  const name = offered?.name ?? model;
  const plain = name.replace(/\s*\(.*\)\s*$/, "").trim();
  return plain === "" ? "Claude" : plain.charAt(0).toUpperCase() + plain.slice(1);
}

/** The ids of the sessions a run started with the workbench's `start`
    tool, read off what each call answered. */
export function startedIds(parts: Part[]): string[] {
  const ids: string[] = [];
  for (const part of parts) {
    if (part.kind !== "tool" || !part.done || part.error || !startsSession(part)) continue;
    const match = /Started session (\S+?)[.,]?\s/.exec(`${part.result ?? ""} `);
    if (match !== null && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

type Permission = Extract<IntegratedEventBody, { type: "permissionAsked" }>;

/** What a permission request asks, in words: the verb, and the thing it is
    for, drawn as code. */
export function asks(asked: Permission): { verb: string; object: string | null } {
  const input = asked.input;
  const path = asked.path ?? inputPath(input);
  switch (asked.tool) {
    case "Bash":
      return { verb: "run", object: field(input, "command") };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: "edit", object: path };
    case "Write":
      return { verb: "write", object: path };
    case "Read":
      return { verb: "read", object: path };
    case "WebFetch":
      return { verb: "fetch", object: field(input, "url") };
    case "WebSearch":
      return { verb: "search the web for", object: field(input, "query") };
    case "ExitPlanMode":
      return { verb: "go ahead with the plan", object: null };
    default: {
      const named = mcpName(asked.tool);
      if (named !== null) return { verb: `use ${named.server}'s`, object: named.tool };
      return { verb: "use", object: asked.tool };
    }
  }
}

/** A choice as its button says it. */
export function choiceLabel(offer: PermissionOffer): string {
  switch (offer.choice) {
    case "allow":
      return "Allow once";
    case "allowSession":
      return "Allow for this session";
    case "allowAlways":
      return "Always allow";
    case "deny":
      return "Deny";
    case "cancel":
      return "Deny and stop";
  }
}

/** What a choice does and keeps, in a sentence. */
export function choiceMeans(offer: PermissionOffer): string {
  switch (offer.choice) {
    case "allow":
      return "Allows this call and remembers nothing.";
    case "allowSession":
    case "allowAlways":
      return `Allows this call and remembers ${offer.remembers ?? "it"}.`;
    case "deny":
      return offer.message
        ? "Refuses this call and the turn goes on. You can tell the agent why."
        : "Refuses this call and the turn goes on.";
    case "cancel":
      return "Refuses this call and stops the turn.";
  }
}

/** How a settled permission went, for the step that asked it. */
export function answered(choice: PermissionChoice): string {
  switch (choice) {
    case "allow":
      return "Allowed once";
    case "allowSession":
      return "Allowed for this session";
    case "allowAlways":
      return "Always allowed";
    case "deny":
      return "Denied";
    case "cancel":
      return "Denied and stopped";
  }
}

/** The kind glyph a step wears, by what sort of tool it is. */
export function glyph(tool: IntegratedToolKind | "thinking"): string {
  switch (tool) {
    case "command":
      return "terminal";
    case "edit":
      return "edit";
    case "read":
      return "file";
    case "search":
      return "search";
    case "web":
      return "globe";
    case "agent":
      return "agent";
    case "mcp":
      return "plug";
    case "thinking":
      return "thought";
    default:
      return "tool";
  }
}

/** Tokens as the composer says them: 812, 12k, 1.2M. */
export function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** A clock time as the thread shows it, in the user's own format. */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
