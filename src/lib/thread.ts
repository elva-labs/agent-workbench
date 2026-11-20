export { revealed, shown } from "$lib/unseen";
import { shown } from "$lib/unseen";
import { spoken } from "$lib/instructions";
import { EARLIER_SERVER_NAMES } from "$lib/migrate";
import type {
  IntegratedEventBody,
  IntegratedFileChange,
  IntegratedToolKind,
  PermissionChoice,
  PermissionOffer,
} from "$lib/core";
import type {
  Command,
  Conversation,
  Entry,
  Message,
  Part,
  PlanPart,
  QuestionPart,
  TextPart,
  ToolCall,
} from "$lib/conversation.svelte";

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
  | { kind: "work"; parts: (ToolCall | TextPart)[]; key: string }
  | { kind: "thought"; part: TextPart };

/** The last thinking a run ends its say with before the workbench's own
    calls is drawn in sight, as its answer may be there and nowhere else. */
export function segments(parts: Part[]): Segment[] {
  const out: Segment[] = [];
  const thought = thoughtAnswer(parts);
  for (const part of parts) {
    if (!drawnPart(part)) continue;
    if (part === thought) out.push({ kind: "thought", part });
    else if (part.kind === "text") out.push({ kind: "text", part });
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

/** The workbench's own calls the thread does not draw: a wait on the
    sessions the agent started, a line left on its row, and the notes kept
    of the conversation and read back. None is work the user reads, so none
    has a step, a count or a line of its own, and what the agent wrote
    before them stays the last thing in its run. */
const UNDRAWN = new Set(["wait", "notify", "note", "notes"]);

/** The last thinking in a run that has something in it, when one of the
    workbench's own calls comes right after it and the run ends there or
    goes on in words: what the agent says there is often its answer, put
    before the call, with at most a closing line after it. Thinking with
    text right after it, or with more work after the calls, stays folded. */
export function thoughtAnswer(parts: Part[]): TextPart | null {
  for (let at = parts.length - 1; at >= 0; at--) {
    const part = parts[at];
    if (part.kind !== "thinking" || part.text.trim() === "") continue;
    if (!part.done) return null;
    let next = at + 1;
    while (next < parts.length && !drawnPart(parts[next])) next++;
    if (next === at + 1) return null;
    const after = parts[next];
    return after === undefined || after.kind === "text" ? part : null;
  }
  return null;
}

/** Whether the thread draws a part of a run. */
export function drawnPart(part: Part): boolean {
  if (part.kind !== "tool") return true;
  const named = mcpName(part.name);
  return named === null || !isOwn(named.server) || !UNDRAWN.has(named.tool);
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

/** What the workbench's own start tool answers when it has started a
    session, whichever agent called it. */
const STARTED = /^Started session (\S+?)[.,]?\s/;

/** What the start tool's answer says of the mode the session begins in. */
const BEGINS = / It begins in ([A-Za-z][A-Za-z ]{0,40}?) mode\./;

/** Whether a call started a session through the workbench's start tool. */
export function startsSession(call: ToolCall): boolean {
  return call.tool === "mcp" && call.done && !call.error && STARTED.test(`${call.result ?? ""} `);
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
    if (part.kind !== "tool" || part.plan) continue;
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

/** The path a tool's input names: a field of its own, or the first of the
    changes it lists. */
export function inputPath(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const fields = input as Record<string, unknown>;
  for (const name of ["file_path", "notebook_path", "path"]) {
    const value = fields[name];
    if (typeof value === "string" && value !== "") return value;
  }
  const changes = fields.changes;
  if (Array.isArray(changes)) {
    const first = changes[0] as Record<string, unknown> | undefined;
    if (typeof first?.path === "string" && first.path !== "") return first.path;
  }
  return null;
}

/** How many files a tool's input lists as changes, when it lists them. */
function changeCount(input: unknown): number {
  if (input === null || typeof input !== "object") return 0;
  const changes = (input as Record<string, unknown>).changes;
  return Array.isArray(changes) ? changes.length : 0;
}

/** Whether an edit writes a file whole rather than changing part of it. */
function writesWhole(call: ToolCall, input: unknown): boolean {
  if (call.changes.length > 0) return call.changes.every((change) => change.kind === "create");
  if (input === null || typeof input !== "object") return false;
  const fields = input as Record<string, unknown>;
  return typeof fields.content === "string" && fields.old_string === undefined;
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

/** What a call or a request is, in words: the verb, then whose it is when
    an MCP server's or a tool's own name says so, then the thing it is for.
    The owner and the thing are the agent's text, drawn as they are and
    never as part of the words around them. */
export interface Phrase {
  /** The words before the thing: the app's own as strings, and a name the
      agent or a server gave as `{ name }`, which is drawn as it is. */
  lead: Piece[];
  object: string | null;
  /** The thing is a name or words the agent chose, a session's name or a
      note, drawn in the text's own type between quotes rather than as
      code. */
  quoted?: boolean;
  /** The app's own words after the thing: how many more there are. */
  tail?: string;
}

export type Piece = string | { name: string };

/** A phrase as one line of plain text. */
export function phraseText(phrase: Phrase): string {
  const lead = phrase.lead.map((piece) => (typeof piece === "string" ? piece : piece.name)).join("");
  const thing = phrase.object === null ? "" : ` ${phrase.quoted ? `“${phrase.object}”` : phrase.object}`;
  return `${lead}${thing}${phrase.tail === undefined ? "" : ` ${phrase.tail}`}`;
}

/** The name an MCP server is called by in a phrase: the connectors the
    Claude apps add carry a `claude_ai_` prefix that says nothing to a
    person. */
function serverShown(server: string): string {
  if (isOwn(server)) return "Chord";
  const bare = server.replace(/^claude_ai_/, "");
  return bare === "" ? server : bare;
}

/** The MCP server the workbench itself runs for its agents, by the name
    Claude Code knows it by, which is the key Codex knows it by too. */
const OWN_SERVER = "chord";

/** Whether a call's server is the app's own: by its name, or by the
    earlier one a transcript written before the rename has. */
function isOwn(server: string): boolean {
  return server === OWN_SERVER || EARLIER_SERVER_NAMES.includes(server);
}

/** How the window answers what the workbench's tools name. */
export interface SessionNames {
  /** The name a session's row shows, by the session's id; null for an id
      no row has. */
  named(id: string): string | null;
  /** The names of the sessions a wait that names none is watching, when
      that is known; null when it is not. */
  watching(): string[] | null;
}

let sessionNames: SessionNames = { named: () => null, watching: () => null };

/** Sets who names the sessions the workbench's tools talk about. */
export function nameSessionsBy(names: SessionNames) {
  sessionNames = names;
}

/** The session an input names by its id, and the name its row shows. */
function sessionOf(input: unknown, key = "session"): { named: boolean; name: string | null } {
  const id = field(input, key);
  return { named: id !== null, name: id === null ? null : sessionNames.named(id) };
}

/** What the thing a workbench tool's ask names is: a path, a command, or
    an address. */
function askedShape(tool: string): "command" | "path" | "name" {
  if (tool === "show" || tool === "diff" || tool === "present") return "path";
  if (tool === "terminal") return "command";
  return "name";
}

/** How a phrase speaks of a call: while it runs, once it is done, or as
    what an agent asks to do. */
type Form = "now" | "then" | "to";

/** What a call on one of the workbench's own tools is, in a person's
    words: what the agent does with the workbench, drawn from the call's
    arguments where they say something. A session, a note, a theme or a
    commit is named in words between quotes; a path, an address or a
    command stays code. Null for a tool the workbench does not have, which
    is worded as any server's tool is. */
function workbenchPhrase(
  tool: string,
  input: unknown,
  call: ToolCall | null,
  form: Form,
  root: string | null,
): Phrase | null {
  const verb = (now: string, then: string, to: string) => (form === "now" ? now : form === "then" ? then : to);
  const say = (now: string, then: string, to: string, object: string | null = null): Phrase => ({
    lead: [verb(now, then, to)],
    object,
  });
  const name = (now: string, then: string, to: string, named: string): Phrase => ({
    ...say(now, then, to, named),
    quoted: true,
  });
  // An agent's ask names a path whole, for the dock to say where it is.
  const file = (path: string | null) => (path === null ? null : form === "to" ? path : shortPath(path, root));
  const aSession = (now: string, then: string, to: string) => {
    const { name: named } = sessionOf(input);
    return named === null ? say(`${now} a session`, `${then} a session`, `${to} a session`) : name(now, then, to, named);
  };
  const theirs = "the sessions it started";
  switch (tool) {
    case "wait": {
      const one = sessionOf(input);
      if (one.name !== null) return name("Waiting on", "Waited on", "wait on", one.name);
      if (one.named) return say("Waiting on a session", "Waited on a session", "wait on a session");
      const watched = form === "now" ? sessionNames.watching() : null;
      if (watched !== null && watched.length === 1) return name("Waiting on", "Waited on", "wait on", watched[0]);
      if (watched !== null && watched.length > 1)
        return say(`Waiting on ${watched.length} sessions`, `Waited on ${theirs}`, `wait on ${theirs}`);
      return say(`Waiting on ${theirs}`, `Waited on ${theirs}`, `wait on ${theirs}`);
    }
    case "start": {
      const resumes = sessionOf(input);
      const id = call === null ? null : (STARTED.exec(`${call.result ?? ""} `)?.[1] ?? null);
      const given = field(input, "name");
      const named = resumes.name ?? (id === null ? null : sessionNames.named(id)) ?? (given === null ? null : shown(given));
      const [now, then, to] = resumes.named ? ["Resuming", "Resumed", "resume"] : ["Starting", "Started", "start"];
      const started =
        named === null ? say(`${now} a session`, `${then} a session`, `${to} a session`) : name(now, then, to, named);
      // Once started, the mode it begins in, as the answer told the agent.
      const mode = form === "then" && call !== null ? (BEGINS.exec(call.result ?? "")?.[1] ?? null) : null;
      return mode === null ? started : { ...started, tail: `in ${mode} mode` };
    }
    case "send":
      return aSession("Writing to", "Wrote to", "write to");
    case "read":
      return aSession("Reading", "Read", "read");
    case "stop":
      return aSession("Stopping", "Stopped", "stop");
    case "sessions":
      return say(`Listing ${theirs}`, `Listed ${theirs}`, `list ${theirs}`);
    case "projects":
      return say("Listing the open projects", "Listed the open projects", "list the open projects");
    // The note lands on the session's row, which is where it is read.
    case "notify": {
      const note = firstLine(field(input, "text"));
      return note === null
        ? say("Leaving a note on its row", "Left a note on its row", "leave a note on its row")
        : name("Leaving a note on its row:", "Left a note on its row:", "leave a note on its row:", note);
    }
    case "note":
      return say("Keeping a note", "Kept a note", "keep a note");
    case "notes":
      return say("Reading its notes", "Read its notes", "read its notes");
    case "show":
      return say("Showing", "Showed", "show", file(field(input, "path")));
    case "diff":
      return say("Showing the changes in", "Showed the changes in", "show the changes in", file(field(input, "path")));
    case "present": {
      const listed = (input as { files?: unknown } | null)?.files;
      const files = Array.isArray(listed) ? listed.filter((one): one is string => typeof one === "string") : [];
      const shownFiles = say("Presenting", "Presented", "present", file(files[0] ?? null));
      return files.length > 1 ? { ...shownFiles, tail: `and ${files.length - 1} more` } : shownFiles;
    }
    case "selection":
      return say("Looking at what you have open", "Looked at what you have open", "look at what you have open");
    case "terminal":
      return say("Opening a terminal for", "Opened a terminal for", "open a terminal for", firstLine(field(input, "command")));
    case "browser_open":
      return say("Opening", "Opened", "open", field(input, "url"));
    case "browser_navigate": {
      const url = field(input, "url");
      if (url !== null) return say("Going to", "Went to", "go to", url);
      switch (field(input, "action")) {
        case "back":
          return say("Going back a page", "Went back a page", "go back a page");
        case "forward":
          return say("Going forward a page", "Went forward a page", "go forward a page");
        case "reload":
          return say("Reloading the page", "Reloaded the page", "reload the page");
      }
      return say("Navigating the page", "Navigated the page", "navigate the page");
    }
    case "browser_snapshot":
      return say("Reading the page", "Read the page", "read the page");
    case "browser_screenshot":
      return say("Taking a screenshot of the page", "Took a screenshot of the page", "take a screenshot of the page");
    case "browser_click":
      return say("Clicking in the page", "Clicked in the page", "click in the page");
    case "browser_type":
      return say("Typing in the page", "Typed in the page", "type in the page");
    case "browser_console":
      return say("Reading the page's console", "Read the page's console", "read the page's console");
    case "browser_eval":
      return say("Running a script in the page", "Ran a script in the page", "run a script in the page");
    case "browser_tabs":
      return say("Listing the open tabs", "Listed the open tabs", "list the open tabs");
    case "browser_close":
      return say("Closing a tab", "Closed a tab", "close a tab");
    case "settings":
      return say("Reading the workbench's settings", "Read the workbench's settings", "read the workbench's settings");
    case "settings_change":
      return say("Changing the workbench's settings", "Changed the workbench's settings", "change the workbench's settings");
    case "theme_save": {
      const theme = field(input, "label") ?? field(input, "name");
      return theme === null
        ? say("Saving a theme", "Saved a theme", "save a theme")
        : name("Saving the theme", "Saved the theme", "save the theme", shown(theme));
    }
    case "styles_write":
      return say("Writing the workbench's stylesheet", "Wrote the workbench's stylesheet", "write the workbench's stylesheet");
    case "git_status":
      return say("Checking the git status", "Checked the git status", "check the git status");
    case "git_log":
      return say("Reading the git log", "Read the git log", "read the git log");
    case "git_commit": {
      const message = firstLine(field(input, "message"));
      return message === null ? say("Committing", "Committed", "commit") : name("Committing", "Committed", "commit", message);
    }
    case "github_pr":
      return say("Looking at pull requests", "Looked at pull requests", "look at pull requests");
    case "todos_list":
      return say("Listing the todos", "Listed the todos", "list the todos");
    case "todos_add": {
      const todo = firstLine(field(input, "text") ?? field(input, "title"));
      return todo === null ? say("Adding a todo", "Added a todo", "add a todo") : name("Adding a todo", "Added a todo", "add a todo", todo);
    }
    case "todos_finish":
      return say("Finishing a todo", "Finished a todo", "finish a todo");
    default:
      return null;
  }
}

/** What a call is, as a step in the work: what it did, and the thing it
    did it to, which is drawn as code. Present tense while it runs. */
export function stepTitle(
  call: ToolCall,
  root: string | null = null,
): Phrase {
  const running = !call.done;
  const input = call.inputDone ? call.input : partialInput(call.inputText);
  const path = inputPath(input);
  const shown = path === null ? null : shortPath(path, root);
  const say = (now: string, then: string, object: string | null, owner: string | null = null): Phrase => {
    const verb = running ? now : then;
    return { lead: owner === null ? [verb] : [`${verb} `, { name: owner }, "'s"], object };
  };
  if (call.plan) return say("Updating the plan", "Updated the plan", null);
  const more = changeCount(input);
  const many = shown !== null && more > 1 ? `${shown} and ${more - 1} more` : shown;
  switch (call.tool) {
    case "command":
      return say("Running", "Ran", firstLine(field(input, "command")));
    case "edit":
      return writesWhole(call, input) ? say("Writing", "Wrote", many) : say("Editing", "Edited", many);
    case "read":
      return say("Reading", "Read", shown);
    case "search": {
      const pattern = field(input, "pattern") ?? field(input, "query");
      return say("Searching for", "Searched for", pattern);
    }
    case "web": {
      const url = field(input, "url");
      if (url !== null) return say("Fetching", "Fetched", url);
      const query = field(input, "query");
      if (query !== null) return say("Searching the web for", "Searched the web for", query);
      return say("Using", "Used", call.name);
    }
    case "agent": {
      const description = field(input, "description") ?? firstLine(field(input, "prompt"));
      return say("Working with a subagent on", "A subagent worked on", description);
    }
    case "mcp": {
      const named = mcpName(call.name);
      if (named === null) return say("Using", "Used", call.name);
      if (isOwn(named.server)) {
        const own = workbenchPhrase(named.tool, input, call, running ? "now" : "then", root);
        if (own !== null) return own;
      }
      return say("Using", "Used", named.tool, serverShown(named.server));
    }
    default:
      return say("Using", "Used", call.name);
  }
}

/** A call's input as far as it is known: whole, or the fields that have
    closed while it streams. */
export function callInput(call: ToolCall): unknown {
  return call.inputDone ? call.input : partialInput(call.inputText);
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
    if (part.kind !== "tool" || part.done || !drawnPart(part)) continue;
    return runningCall(part.parts) ?? part;
  }
  return null;
}

/** The workbench's own wait the run is in, when it is in one. */
function runningWait(parts: Part[]): ToolCall | null {
  for (let at = parts.length - 1; at >= 0; at--) {
    const part = parts[at];
    if (part.kind !== "tool" || part.done) continue;
    const named = mcpName(part.name);
    if (named !== null && isOwn(named.server) && named.tool === "wait") return part;
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
  if (call !== null) return phraseText(stepTitle(call));
  // A wait is no step of the run, but while the agent is only waiting its
  // foot says on what.
  const waiting = runningWait(parts);
  if (waiting !== null) return phraseText(stepTitle(waiting));
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

/** How a thread ends a sentence about earlier messages it could not draw:
    that they could not be read and why, on one short line, where it is
    known, and that they are not shown otherwise. */
export function notRead(why: string | null): string {
  const first = why?.split("\n")[0].trim().replace(/[.\s]+$/, "") ?? "";
  if (first === "") return "are not shown here.";
  const said = first.length > 160 ? `${first.slice(0, 159).trimEnd()}…` : first;
  return `could not be read: ${said}.`;
}

/** The name the agent's runs go under: the model it ran on, or the agent's
    own name where no model is known or the model is its default. */
export function speaker(conversation: Conversation, model: string | null, agent: string): string {
  if (model === null || model === "default") return agent;
  return modelName(conversation, model) ?? agent;
}

/** The model the agent offered that a model it reports is: the same, or
    for the model it resolved one to, the one named among its words, as
    claude-sonnet-5-5 is the Sonnet it offers. */
export function offeredModel(
  conversation: Conversation,
  model: string | null,
): NonNullable<Conversation["ready"]>["models"][number] | null {
  if (model === null) return null;
  const words = model.toLowerCase().split(/[-_.\s]/);
  const models = conversation.ready?.models ?? [];
  return (
    models.find((option) => option.value === model) ??
    models.find((option) => option.value !== "default" && words.includes(option.value.toLowerCase())) ??
    null
  );
}

/** A model as the agent names it in what it offers, or as it is written;
    null for none. */
export function modelName(conversation: Conversation, model: string | null): string | null {
  if (model === null) return null;
  const name = (offeredModel(conversation, model)?.name ?? model).replace(/\s*\(.*\)\s*$/, "").trim();
  return name === "" ? null : name;
}

/** What the agent said in a run, as the Markdown it wrote: its text parts
    joined, without its work, its plans or the sessions it started. */
export function replyMarkdown(parts: Part[]): string {
  return parts
    .filter((part): part is TextPart => part.kind === "text")
    .map((part) => part.text.replace(/^\n+|\s+$/g, ""))
    .filter((text) => text !== "")
    .join("\n\n");
}

/** The ids of the sessions a run started with the workbench's `start`
    tool, read off what each call answered. */
export function startedIds(parts: Part[]): string[] {
  const ids: string[] = [];
  for (const part of parts) {
    if (part.kind !== "tool" || !part.done || part.error || !startsSession(part)) continue;
    const match = STARTED.exec(`${part.result ?? ""} `);
    if (match !== null && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

type Permission = Extract<IntegratedEventBody, { type: "permissionAsked" }>;

/** Every path a permission request names: its own fields, each change it
    lists, the folder it runs in, and the place the core says it is for. */
export function requestPaths(asked: Permission): string[] {
  const out: string[] = [];
  const add = (path: unknown) => {
    if (typeof path === "string" && path !== "" && !out.includes(path)) out.push(path);
  };
  const input = asked.input;
  if (input !== null && typeof input === "object") {
    const fields = input as Record<string, unknown>;
    for (const name of ["file_path", "notebook_path", "path", "cwd"]) add(fields[name]);
    if (Array.isArray(fields.changes))
      for (const change of fields.changes as Record<string, unknown>[]) {
        add(change?.path);
        add(change?.move_path);
      }
  }
  if (asked.path !== null && /^(\/|~|\.{1,2}(\/|$)|[A-Za-z]:[\\/])/.test(asked.path)) add(asked.path);
  return out;
}

/** The folder a request runs in, when it says. */
export function requestCwd(asked: Permission): string | null {
  return field(asked.input, "cwd");
}

/** Where a path a request names lies: inside the project, outside it, or
    not known. Only a path that plainly resolves into the project is
    inside: one that starts at a home folder, names a variable or a glob,
    or has no project to be read against is not known, and a relative path
    is read from the folder the request runs in. A link inside the project
    that leads out of it cannot be seen from here. The text is the path
    from the project when it is inside, and whole otherwise. */
export function place(
  path: string,
  root: string | null,
  cwd: string | null = null,
): { text: string; where: "inside" | "outside" | "unknown" } {
  const unknown = { text: path, where: "unknown" as const };
  if (root === null || !absolute(root)) return unknown;
  if (/^~|[$`%*?{}\[\]]/.test(path) || (cwd !== null && /^~|[$`%*?{}\[\]]/.test(cwd))) return unknown;
  const windows = root.includes("\\");
  const slashes = (text: string) => (windows ? text.replace(/\\/g, "/") : text);
  let full = slashes(path);
  if (!absolute(path)) {
    const base = cwd === null ? root : absolute(cwd) ? cwd : `${root}/${cwd}`;
    full = `${slashes(base)}/${full}`;
  }
  const resolved = normal(full);
  const home = normal(slashes(root));
  if (resolved === home) return { text: ".", where: "inside" };
  if (resolved.startsWith(`${home}/`)) {
    // Shown from the project only when the path says no more than that.
    const given = slashes(path);
    const plain = given.startsWith(`${home}/`) && normal(given) === given;
    return { text: plain ? given.slice(home.length + 1) : path, where: "inside" };
  }
  return { text: path, where: "outside" };
}

function absolute(path: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

/** A path with its `.` and `..` read and its doubled slashes made one. */
function normal(path: string): string {
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of path.slice(drive.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${drive.toLowerCase()}/${parts.join("/")}`;
}

/** What a permission request asks, in words: the lead, and the thing it
    is for, drawn as code, which is a command, a path or a name. It goes by
    the kind of the call that asks, as its start said, and only where that
    is not known by the shape of what it asks with; never by what an agent
    calls its tools. It says "run" only for a call known to be a command,
    and a tool of an MCP server is always named as one. Every name in it is
    the agent's or a server's, drawn as it is. */
export function asks(asked: Permission, call: ToolCall | null = null): Phrase & { shape: "command" | "path" | "name" | null } {
  const input = asked.input;
  if (call?.plan) return { lead: ["go ahead with the plan"], object: null, shape: null };
  const named = mcpName(asked.tool);
  if (named !== null && isOwn(named.server)) {
    const own = workbenchPhrase(named.tool, input, call, "to", null);
    if (own !== null) return { ...own, shape: own.quoted || own.object === null ? null : askedShape(named.tool) };
  }
  if (named !== null)
    return { lead: ["use ", { name: serverShown(named.server) }, "'s"], object: named.tool, shape: "name" };
  const kind = call?.tool ?? null;
  const command = field(input, "command");
  if (command !== null && kind === "command") return { lead: ["run"], object: command, shape: "command" };
  if (command !== null && kind === null)
    return { lead: ["use ", { name: asked.tool }, " to run"], object: command, shape: "command" };
  const path = inputPath(input) ?? (requestPaths(asked)[0] ?? null);
  const more = changeCount(input);
  const paths = path !== null && more > 1 ? `${path} and ${more - 1} more` : path;
  const shaped =
    more > 0 || (input !== null && typeof input === "object" && ("old_string" in input || "content" in input));
  if (kind === "edit" || (kind === null && shaped)) {
    const whole = input !== null && typeof input === "object" && "content" in input && !("old_string" in input);
    return { lead: [whole ? "write" : "edit"], object: paths, shape: path === null ? null : "path" };
  }
  if (kind === "read" && path !== null) return { lead: ["read"], object: path, shape: "path" };
  if (kind === "web" || kind === null) {
    const url = field(input, "url");
    if (url !== null) return { lead: ["fetch"], object: url, shape: "name" };
    const query = field(input, "query");
    if (kind === "web" && query !== null) return { lead: ["search the web for"], object: query, shape: "name" };
  }
  if (kind === "agent") {
    const about = field(input, "description") ?? firstLine(field(input, "prompt"));
    return { lead: ["start a subagent for"], object: about, shape: about === null ? null : "name" };
  }
  if (path !== null) return { lead: ["use ", { name: asked.tool }, " on"], object: path, shape: "path" };
  return { lead: ["use"], object: asked.tool, shape: "name" };
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

/** The words the core ends what a choice keeps with, said of the session
    that asks, and the same said of a session named before them working in
    the folder `where`: a rule kept in a folder's local settings holds for
    every session there, the one on screen included when it shares it. */
function keptFor(remembers: string, where: string): string {
  const ends: [string, string][] = [
    [" for the rest of this session", " for the rest of that session"],
    [" for the rest of this turn", " for the rest of its turn"],
    [" in this project's uncommitted local settings", ` in ${where}'s uncommitted local settings, for every session in ${where}`],
  ];
  // Only the end the core adds is said again; what the agent asked to keep
  // stays as it wrote it.
  for (const [own, named] of ends)
    if (remembers.endsWith(own)) return `${remembers.slice(0, -own.length)}${named}`;
  return remembers;
}

/** What a choice does and keeps, for a request of another session answered
    from the dock of the session that started it: the session's name is
    the middle piece, so the call and what the choice keeps read as that
    session's and never as the one on screen. `where` is the folder it
    works in, as the user knows it. */
export function choiceMeansIn(offer: PermissionOffer, name: string, where: string): [string, string, string] {
  switch (offer.choice) {
    case "allow":
      return ["Allows this call in ", name, " and remembers nothing."];
    case "allowSession":
    case "allowAlways":
      return ["Allows this call in ", name, ` and remembers ${offer.remembers === null ? "it" : keptFor(offer.remembers, where)}.`];
    case "deny":
      return ["Refuses this call in ", name, offer.message ? " and its turn goes on. You can tell it why." : " and its turn goes on."];
    case "cancel":
      return ["Refuses this call and stops ", name, "'s turn."];
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

/** How a command that is over ended, as the line under it says it, with
    the error the core gave, and whether that reads as bad news, as an
    error always does; null for one that ended well, which says nothing,
    and for one not over. */
export function commandEnd(command: Command): { text: string; bad: boolean } | null {
  const said = (text: string, bad: boolean) => (command.error === null ? { text, bad } : { text: `${text}: ${command.error}`, bad: true });
  switch (command.state) {
    case "done":
      if (command.exitCode !== null && command.exitCode !== 0) return said(`Exit code ${command.exitCode}`, true);
      return command.error === null ? null : said("Ran", true);
    case "stopped":
      return said("Stopped", false);
    case "timedOut":
      return said("Timed out", false);
    case "failed":
      return { text: command.error ?? "Could not run", bad: true };
    case "dropped":
      return said("Not finished", true);
    default:
      return null;
  }
}

/** How many lines a command printed: a newline at the end closes the last
    line rather than starting one. */
export function lineCount(output: string): number {
  if (output === "") return 0;
  let lines = output.endsWith("\n") ? 0 : 1;
  for (let at = output.indexOf("\n"); at !== -1; at = output.indexOf("\n", at + 1)) lines += 1;
  return lines;
}

let clockFormat: Intl.DateTimeFormat | null = null;

/** A clock time as the thread shows it, in the user's own format. One
    format is made and kept, since a thread can show thousands of times. */
export function clock(at: number): string {
  clockFormat ??= new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
  return clockFormat.format(at);
}

/** The day a time falls on, as the thread names it beside the time: today,
    the day of the week within the six days before, and the date further
    back, with the year when it is not this one. */
export function dayName(at: number, now: number = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const back = Math.round((midnight(today) - midnight(day)) / 86_400_000);
  if (back === 0) return "today";
  if (back > 0 && back < 7) return day.toLocaleDateString([], { weekday: "short" });
  return day.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The times a thread shows, in the order it shows them, as it writes
    them: the first time of each day with the day's name, unless every one
    is today's, and a time marked `day` with it whatever comes before. */
export function stamps(times: { at: number; day?: boolean }[], now: number = Date.now()): string[] {
  const dayOf = (at: number) => new Date(at).toDateString();
  const today = dayOf(now);
  const earlier = times.some((time) => dayOf(time.at) !== today);
  const named = new Set<string>();
  return times.map((time) => {
    const day = dayOf(time.at);
    const first = !named.has(day);
    named.add(day);
    return time.day === true || (first && (earlier || day !== today))
      ? `${dayName(time.at, now)} ${clock(time.at)}`
      : clock(time.at);
  });
}

/**
 * What a screen reader is to hear of the latest entries: each message, each
 * block of the agent's text once whole, and each note that came at or after
 * `since` and is not in `told`, which it is then added to, in the order they
 * stand. Only the last `last` entries are looked at. `words` makes what is
 * said of a message and of a block's Markdown, and is asked only for what is
 * to be heard: never for what came before or was heard already.
 */
export function toHear(
  conversation: Conversation,
  told: Set<string>,
  since: number,
  words: { message: (message: Message) => string; block: (markdown: string) => string },
  last = 12,
): string[] {
  const heard: string[] = [];
  const hear = (key: string, at: number | null, say: () => string) => {
    if (at === null || at < since || told.has(key)) return;
    const text = say();
    if (text === "") return;
    told.add(key);
    heard.push(text);
  };
  const entries = conversation.entries;
  for (let at = Math.max(0, entries.length - last); at < entries.length; at++) {
    const entry = entries[at];
    if (entry.kind === "user") {
      const message = conversation.messages[entry.message];
      if (message !== undefined) hear(`m:${message.id}`, message.at, () => words.message(message));
    } else if (entry.kind === "agent") {
      for (const part of entry.parts)
        if (part.kind === "text" && part.done) hear(`b:${part.block}`, part.at, () => words.block(part.text));
    } else if (entry.kind === "command") {
      const command = conversation.commands[entry.command];
      if (command !== undefined) hear(`c:${command.id}`, command.at, () => `!${command.text}`);
    } else if (entry.kind === "note") hear(`n:${entry.key}`, entry.at, () => entry.text);
  }
  return heard;
}

/** What the agent last said and did, as plain text for another agent to
    read: its last run with the messages it answered, a line per step, and
    what it is doing or waiting for now. At most `lines` lines, the latest
    kept. */
export function lastRun(
  conversation: Conversation,
  lines: number,
  /** The name of the session that sent a message, or null for the user. */
  who: (message: { id: string; text: string }) => string | null = () => null,
): string {
  const out: string[] = [];
  const entries = conversation.entries;
  let at = entries.length - 1;
  while (at >= 0 && entries[at].kind !== "agent") at--;
  let from = at;
  while (from > 0 && entries[from - 1].kind === "user") from--;
  for (let index = Math.max(0, from); index >= 0 && index <= at; index++) {
    const entry = entries[index];
    if (entry.kind === "user") {
      const message = conversation.messages[entry.message];
      if (message !== undefined) {
        const from = who(message);
        const said = spoken(message.text, from === null).text;
        out.push(from === null ? `The user said: ${said}` : `${capital(from)} said: ${said}`);
      }
    } else if (entry.kind === "agent") {
      for (const part of entry.parts) out.push(...partLines(part));
      const turn = conversation.turns[entry.turn];
      if (turn?.outcome === "interrupted") out.push("The turn was interrupted.");
      else if (turn?.outcome === "failed")
        out.push(`The turn failed${turn.error ? `: ${turn.error}` : "."}`);
    }
  }
  for (const request of conversation.open) {
    const asked = request.asked;
    if (asked.type === "permissionAsked") {
      out.push(`It is waiting for the user to allow it to ${phraseText(asks(asked))}.`);
    } else
      out.push(
        `It is waiting for the user to answer: ${asked.questions.map((question) => question.question).join(" ")}`,
      );
  }
  if (conversation.open.length === 0 && conversation.current !== null) {
    const run = entries[at];
    const doing = run?.kind === "agent" ? nowDoing(conversation, run.parts) : null;
    out.push(`It is at work${doing === null ? "" : `: ${doing}`}.`);
  }
  for (const message of conversation.waiting)
    if (message.state === "queued" || message.state === "sending")
      out.push(
        `A message from ${who(message) ?? "the user"} waits for the turn: ${spoken(message.text, who(message) === null).text}`,
      );
  return out.slice(-lines).join("\n");
}

function partLines(part: Part): string[] {
  switch (part.kind) {
    case "text":
      return part.text.split("\n");
    case "thinking":
      return [];
    case "plan":
      return part.steps.length > 0
        ? [
            "Its plan:",
            ...part.steps.map(
              (step) =>
                `  [${step.status === "done" ? "x" : step.status === "active" ? ">" : " "}] ${step.text}`,
            ),
          ]
        : (part.text ?? "").split("\n");
    case "question":
      return part.questions.map((question, at) => {
        const answer = part.answers?.[at];
        return part.outcome === "answered"
          ? `It asked: ${question.question} The user answered${answer ? `: ${answer.join(", ")}` : ", and the answer is not shown."}`
          : `It asked: ${question.question} No answer was given.`;
      });
    case "tool": {
      const title = phraseText(stepTitle(part));
      const how = !part.done
        ? " (running)"
        : part.answer?.choice === "deny" || part.answer?.choice === "cancel"
          ? " (denied)"
          : part.error
            ? " (failed)"
            : "";
      return [`- ${title}${how}`];
    }
  }
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Where an address leads, as a reader of it must know: the host the URL
    standard reads, the host a client that reads addresses its own way
    would go to when that is another, and what in its authority could
    mislead. Null for text that is not an address with a host. */
export interface Address {
  host: string;
  /** The host a client such as curl reads, when it is not `host`. */
  other: string | null;
  warnings: string[];
}

const HOSTED = /^(https?|wss?|ftp):/i;

export function address(text: string): Address | null {
  const trimmed = text.trim();
  if (!HOSTED.test(trimmed)) return null;
  let host: string;
  try {
    host = new URL(trimmed).host;
  } catch {
    return null;
  }
  if (host === "") return null;
  // The authority as a client that follows the old rules reads it: after
  // the scheme and any slashes, up to the first slash, query or fragment;
  // a backslash is part of it, and the host follows its last @.
  const rest = trimmed.slice(trimmed.indexOf(":") + 1).replace(/^\/+/, "");
  const authority = /^[^/?#]*/.exec(rest)?.[0] ?? "";
  const plainHost = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "");
  let other: string | null = null;
  try {
    const read = new URL(`http://${plainHost}`).host;
    if (read !== "" && read !== host.replace(/:\d+$/, "")) other = read;
  } catch {
    other = plainHost === "" ? null : plainHost;
  }
  const warnings: string[] = [];
  if (authority.includes("@")) warnings.push("it names a user before the host");
  if (authority.includes("\\")) warnings.push("it holds a backslash");
  const letters = [...plainHost].filter((char) => /\p{L}/u.test(char));
  const latin = letters.filter((char) => /\p{Script=Latin}/u.test(char)).length;
  if (latin > 0 && latin < letters.length) warnings.push("its host mixes scripts");
  else if (latin === 0 && letters.length > 0) warnings.push("its host is not in Latin letters");
  return { host, other, warnings };
}

/** The key a fold of the thread is kept open by: a stretch of work by the
    call or block it starts with, a step by its own. */
export function foldKey(kind: "work" | "step", part: ToolCall | TextPart): string {
  return `${kind}:${part.kind === "tool" ? part.call : part.block}`;
}

/** A call's input as its step shows it under the row: a command as
    typed, the rest as its fields, each named, leaving out what the row
    already says. Nothing when the row says all of it; while it streams,
    as it comes. */
export type StepInput = { command: string } | { fields: { name: string; value: string }[] } | { json: string } | null;

export function stepInput(part: ToolCall, title: Phrase): StepInput {
  const value = part.inputDone ? part.input : null;
  if (value === null || value === undefined) return part.inputText ? { json: part.inputText } : null;
  if (typeof value !== "object" || Array.isArray(value)) return { json: JSON.stringify(value, null, 2) };
  const record = value as Record<string, unknown>;
  if (part.tool === "command" && typeof record.command === "string") return { command: record.command };
  const said = new Set([inputPath(value), title.object].filter((known) => known !== null));
  const fields = Object.entries(record)
    .filter(([, field]) => field !== null && field !== undefined && field !== "" && !said.has(field as string))
    .map(([name, field]) => ({
      name: name.replace(/_/g, " "),
      value: typeof field === "string" ? field : JSON.stringify(field, null, 2),
    }));
  return fields.length === 0 ? null : { fields };
}

/** Whether a step shows its command whole under the row, which shows a
    short one whole itself. */
export function longCommand(command: string): boolean {
  return command.includes("\n") || command.length > 72;
}

/** Whether a step shows its input's fields: an edit that has its changes
    shows them instead. */
export function showsFields(part: ToolCall): boolean {
  return part.tool !== "edit" || part.changes.length === 0;
}

/** What a step's output shows: what came while it ran, then its result. */
export function stepOutput(part: ToolCall): string {
  return part.done ? (part.result ?? part.output) : part.output;
}

/** Whether a step shows its output: an edit says what it did as diffs. */
export function showsOutput(part: ToolCall): boolean {
  return part.tool !== "edit" && stepOutput(part) !== "";
}

export interface ChangeLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

/** A changed file's lines as its diff shows them: each hunk's head, then
    its lines without their marks; a new file whole, as added lines. */
export function changeLines(change: IntegratedFileChange): ChangeLine[] {
  if (change.kind === "create" && change.content !== null)
    return change.content
      .replace(/\n$/, "")
      .split("\n")
      .map((text) => ({ kind: "add", text }));
  const out: ChangeLine[] = [];
  for (const hunk of change.hunks) {
    out.push({ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
    for (const line of hunk.lines) {
      const mark = line.charAt(0);
      out.push({ kind: mark === "+" ? "add" : mark === "-" ? "del" : "ctx", text: line.slice(1) });
    }
  }
  return out;
}

/** What opening a step shows of a call, in the order drawn: its input,
    the files it changed, each by its path and its lines, its output, and
    what the user told the agent when refusing it. A subagent's run, drawn
    there too, is held apart. */
export function stepShows(part: ToolCall, root: string | null = null): string[] {
  const pieces: string[] = [];
  if (part.tool !== "agent") {
    const input = stepInput(part, stepTitle(part, root));
    if (input !== null) {
      if ("command" in input) {
        if (longCommand(input.command)) pieces.push(input.command);
      } else if ("fields" in input) {
        if (showsFields(part)) pieces.push(...input.fields.map((field) => field.value));
      } else pieces.push(input.json);
    }
    for (const change of part.changes) {
      pieces.push(shortPath(change.path, root));
      if (change.to !== null) pieces.push(shortPath(change.to, root));
      for (const line of changeLines(change)) if (line.kind !== "hunk") pieces.push(line.text);
    }
  }
  if (showsOutput(part)) pieces.push(stepOutput(part));
  // What the user told the agent with a refusal, under its label.
  if (part.answer?.message) pieces.push(part.answer.message);
  return pieces;
}

/** Something the thread holds that can be looked for and brought into
    view: a message, a block of text or thinking, a call, a plan, a
    question or a note, by its id; the entry it stands in; the folds that
    must open for it to show, outermost first; and what it shows. A call
    is held twice: by its row, and by what opening its step shows. */
export interface Held {
  id: string;
  /** What the thread marks where it draws this, the id but for what a
      step shows of a call. */
  key: string;
  /** Null for a message waiting under the thread, which is always drawn. */
  entry: string | null;
  folds: string[];
  /** What it shows as plain text, each piece on a line of its own. */
  text: string;
  /** What it shows rendered from Markdown, after its text. */
  markdown: string | null;
}

export interface HeldOptions {
  /** The folder paths in the thread are shown from. */
  root?: string | null;
  /** A message's words as its bubble shows them. */
  words?: (message: Message) => string;
}

/** Everything the thread holds, in the order it is drawn, folded work and
    a subagent's run under its call included, each with what it shows as
    the reader sees it: what a tool or the agent chose with every unseen
    character as its marker, and the labels the thread puts around it left
    out. */
export function held(conversation: Conversation, options: HeldOptions = {}): Held[] {
  const ended = endedWith(conversation);
  return [
    ...conversation.entries.flatMap((entry) => (entry.key === ended ? [] : heldIn(conversation, entry, options))),
    ...heldWaiting(conversation, options),
  ];
}

/** The error a session ended with, which is said where it offers to
    resume, not in the thread: the key of its note, or null. */
export function endedWith(conversation: Conversation): string | null {
  const last = conversation.entries[conversation.entries.length - 1];
  return conversation.ended !== null && last?.kind === "note" && last.tone === "error" ? last.key : null;
}

const plainWords = (message: Message) => spoken(message.text, true).text;

/** What one entry of the thread holds, as `held` gives it. */
export function heldIn(conversation: Conversation, entry: Entry, options: HeldOptions = {}): Held[] {
  const root = options.root ?? null;
  const words = options.words ?? plainWords;
  const out: Held[] = [];
  const add = (id: string, folds: string[], text: string, markdown: string | null = null, key = id) =>
    out.push({ id, key, entry: entry.key, folds, text, markdown });
  const lines = (pieces: (string | null | undefined)[]) =>
    pieces
      .filter((piece): piece is string => typeof piece === "string" && piece !== "")
      .map(shown)
      .join("\n");
  const walk = (parts: Part[], around: string[]) => {
    for (const segment of segments(parts)) {
      if (segment.kind === "text" || segment.kind === "thought") add(segment.part.block, around, "", segment.part.text);
      else if (segment.kind === "plan") {
        const plan = segment.part;
        add(`plan-${plan.at}`, around, lines(plan.steps.map((step) => step.text)), plan.text);
      } else if (segment.kind === "question") {
        const asked = segment.part;
        const answered = asked.outcome === "answered";
        const pieces = asked.questions.flatMap((question, at) => [
          question.question,
          answered ? asked.answers?.[at]?.join(", ") : null,
        ]);
        add(asked.request, around, lines(pieces));
      } else {
        const work = [...around, foldKey("work", segment.parts[0])];
        for (const part of segment.parts) {
          const step = [...work, foldKey("step", part)];
          if (part.kind !== "tool") {
            add(part.block, step, "", part.text);
            continue;
          }
          add(part.call, work, lines([stepTitle(part, root).object]));
          // A subagent's run is drawn before the output of the call that
          // started it.
          const shows = () => add(part.call, step, lines(stepShows(part, root)), null, `${part.call}:shows`);
          if (part.tool === "agent") {
            walk(part.parts, step);
            shows();
          } else {
            shows();
            walk(part.parts, step);
          }
        }
      }
    }
  };
  if (entry.kind === "user") {
    const message = conversation.messages[entry.message];
    if (message !== undefined) add(message.id, [], shown(words(message)));
  } else if (entry.kind === "command") {
    const command = conversation.commands[entry.command];
    if (command !== undefined) out.push(...heldCommand(command, entry.key));
  } else if (entry.kind === "agent") walk(entry.parts, []);
  else if (entry.kind === "note") add(entry.key, [], shown(entry.text));
  return out;
}

/** A command of the user's, as `held` gives it: its line with the `!`,
    and what it printed, each where the thread draws it. */
function heldCommand(command: Command, entry: string | null): Held[] {
  const line = { id: command.id, key: command.id, entry, folds: [], text: shown(`!${command.text}`), markdown: null };
  if (command.output === "") return [line];
  return [line, { id: command.id, key: `${command.id}:output`, entry, folds: [], text: shown(command.output), markdown: null }];
}

/** The messages and commands under the thread, as `held` gives them. */
export function heldWaiting(conversation: Conversation, options: HeldOptions = {}): Held[] {
  const words = options.words ?? plainWords;
  return conversation.below.flatMap((below) =>
    below.kind === "command"
      ? heldCommand(below.command, null)
      : [
          {
            id: below.message.id,
            key: below.message.id,
            entry: null,
            folds: [],
            text: shown(words(below.message)),
            markdown: null,
          },
        ],
  );
}

/**
 * What an entry is made of that what it holds is read from, as a list of
 * values: two prints with the same values, compared one by one, hold the
 * same. Cheap to take, so what was read from an entry can be kept until
 * its print changes.
 */
export function entryPrint(conversation: Conversation, entry: Entry): unknown[] {
  const out: unknown[] = [entry.kind];
  const parts = (list: Part[]) => {
    out.push(list.length);
    for (const part of list) {
      out.push(part.kind);
      if (part.kind === "text" || part.kind === "thinking") out.push(part.block, part.text);
      else if (part.kind === "tool")
        out.push(part.call, part.tool, part.plan, part.input, part.inputText, part.inputDone);
      if (part.kind === "tool")
        out.push(part.output, part.result, part.done, part.changes, part.changes.length, part.answer, part.answer?.message);
      else if (part.kind === "plan") {
        out.push(part.at, part.text, part.steps.length);
        for (const step of part.steps) out.push(step.text);
      } else if (part.kind === "question") out.push(part.request, part.outcome, part.questions, part.answers);
      if (part.kind === "tool") parts(part.parts);
    }
  };
  if (entry.kind === "user") {
    const message = conversation.messages[entry.message];
    out.push(message, message?.text);
  } else if (entry.kind === "command") {
    const command = conversation.commands[entry.command];
    out.push(command, command?.text, command?.output);
  } else if (entry.kind === "agent") parts(entry.parts);
  else if (entry.kind === "note") out.push(entry.text);
  return out;
}

/** Where the thread holds a message, block or call: its entry and the
    folds around it. */
export function locate(conversation: Conversation, id: string): Held | null {
  return held(conversation).find((one) => one.id === id) ?? null;
}
