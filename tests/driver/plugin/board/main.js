// @ts-nocheck
// The type checker reaches every .js under tests; this one is data the app
// runs, not source the app builds.
//
// The plugin the driver tier runs: plain node over JSON lines, with no
// dependencies, so the tier exercises the real runtime and nothing else.
//
// It greets with one tool, one section and a view; sends the section's rows
// for every project it hears about; answers a tool call with text; answers
// an action by sending the section again with a row that says what the
// action and the input were; sends its page when the page action is taken;
// answers a message from that page; and goes on stop.

const NAME = "driverboard";
const VERSION = "1.2.3";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

/** What the last action was, on the row that shows it. */
let echoed = null;

function section(project) {
  if (typeof project !== "string" || project === "") return;
  send({
    type: "section",
    id: "board",
    title: "Driver board",
    project,
    rows: [
      {
        id: "ready",
        label: "ready",
        detail: "the fixture is up",
        state: "ok",
      },
      {
        id: "notes",
        label: echoed === null ? "notes" : echoed,
        detail: "run an action to change this",
        state: "waiting",
        actions: [{ id: "echo", label: "Echo" }],
        default: "echo",
      },
    ],
    actions: [
      {
        id: "note",
        label: "Note",
        input: [
          { id: "text", label: "Text", kind: "text", placeholder: "a line" },
        ],
      },
      { id: "page", label: "Page" },
    ],
  });
}

function handle(message) {
  const project = message.project;
  switch (message.type) {
    case "hello":
      for (const path of message.projects || []) section(path);
      break;
    case "project":
      if (message.event === "opened") section(message.path);
      break;
    case "tool":
      send({
        type: "result",
        id: message.id,
        content: "pong: " + ((message.arguments || {}).text || ""),
      });
      break;
    case "action":
      echoed =
        "did " +
        message.action +
        " on " +
        (message.row || "the header") +
        " with " +
        ((message.input || {}).text || "nothing");
      send({ type: "result", id: message.id, content: echoed });
      if (message.action === "page") {
        send({
          type: "view",
          project,
          html: "<h1>Driver board</h1><p>A page from the fixture.</p>",
          open: false,
        });
      }
      section(project);
      break;
    case "view_message":
      send({ type: "view_data", project, data: { got: message.payload } });
      break;
    case "stop":
      process.exit(0);
  }
}

send({
  type: "hello",
  name: NAME,
  version: VERSION,
  tools: [
    {
      name: "ping",
      description: "Answers with what it was given.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
    },
  ],
  sections: [{ id: "board", title: "Driver board" }],
  view: { width: "wide" },
});

let rest = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  rest += chunk;
  let at;
  while ((at = rest.indexOf("\n")) !== -1) {
    const line = rest.slice(0, at).trim();
    rest = rest.slice(at + 1);
    if (line === "") continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // A line that is not a message is not this plugin's business.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
