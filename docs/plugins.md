# Plugins

A plugin adds to the workbench from outside it: tools for the agent, a
section under the file tree with rows and actions, and a view in the
changes pane. It comes from a git repository, runs on the machine the
project is on with the user's own privileges, and produces data the app
draws in its own hand. Nothing a plugin does reaches the window's DOM.

## Where plugins come from

A source is a git repository, with a ref, or a directory on the machine
for one being written. A source holds any number of plugins, named in one
manifest at its root, `workbench-plugins.toml`, the way a compose file
names its services:

```toml
[[plugin]]
name = "github"
path = "github"
description = "Pull requests, checks and review comments for the branch."
version = "0.2.0"
run = ["node", "main.js"]
tools = ["pr", "checks"]
sections = ["Pull request"]
view = "wide"

[[plugin]]
name = "git"
path = "git"
description = "Commit, stash, pull, push and a graph of the branch."
version = "0.1.0"
run = ["node", "main.js"]
tools = ["commit"]
sections = ["Git"]
view = "full"
```

Each plugin has a name, which is its identity everywhere, a path to its
directory under the source, a line of description, a version, and the
command that runs it: a runtime found on the login shell's PATH, `node`
above all, with a script, or a binary per platform. What it declares,
tools, sections, a view and how much room the view wants, is listed so the
settings can say what enabling it means before it has run.

Sources are added in the settings, by URL or by path. Adding one clones
it, pins the commit that was cloned, validates the manifest, and lists its
plugins, every one of them off. Validation reads the manifest, checks that
every path stays under the source, that the runtime the plugin runs on is
on the login shell's PATH, that every declared name is a plain identifier,
and that no plugin in any source has the name of another. A source that
fails says why on its row, "needs node", "manifest invalid at line 12",
"could not clone", and adds nothing.

Enabling a plugin shows what it declares once more, "two tools, one
section, a wide view, runs node", and that it runs with your privileges.
That question is the whole of the trust model, and it is asked once.
Enabling is per install: every project, every machine.

A source stays at its pinned commit. The app checks each source for a
newer commit once a day while it runs and on request from the settings,
and marks the row; updating is a choice made per source, never made for
you. Removing a source stops and removes its plugins.

## How a plugin runs

The core owns plugin processes, the app's own core for projects here and
the daemon's for a project on another machine, so a plugin is where the
project is and the window only draws. A plugin runs as one process per
machine, started when it is turned on and when the app comes up, and
stopped when it is turned off. A process that dies is started again, with
a growing pause between tries; its sections and its page go while it is
away, and the settings row says what happened to it.

The process speaks JSON lines over its standard input and output, the
same shape the daemon speaks. It is told about every open project on the
machine and every session in them, and every message about a project
names the project, so one process serves them all.

From the app to the plugin: a greeting with the app's version and the
projects open; a project opened or closed; a session started or ended;
the tree moved; an action taken, with its row and any
input given; a tool called, with its arguments and the session that
called it; a message from the plugin's view; a request to stop.

From the plugin to the app: a greeting with its name and version and the
full shape of what the manifest declared, the tools with their
descriptions and input schemas, the sections with their actions, the view
with its width; a section's rows for a project, sent whenever they change;
the result of a tool call or an action; a place to open in the viewer, a
file's diff, files to present, or a line for a session's row, the same
means the agent has; the view's page and the data the view shows. The app
never polls a plugin, and a plugin that has nothing to say stays silent.

A plugin gets the project path, the session events and the tree events,
and nothing else from the app. What it knows about the repository it finds
out itself, `git` and `gh` on the machine, as the agent does.

## What a plugin looks like

The manifest names the tools, sections and view; it holds no code for
them. The `run` command is the plugin's one entry point, started in the
plugin's own directory, and everything named in the manifest arrives at
that process as a message with the name in it. A tool call is one line on
stdin:

```json
{
  "type": "tool",
  "id": "c1",
  "name": "pr",
  "arguments": {},
  "project": "/srv/orbit-api",
  "session": "6f2a…"
}
```

and the plugin's answer is one line on stdout with the same id:

```json
{
  "type": "result",
  "id": "c1",
  "content": "#42 Retry with jitter · checks 3 of 4 passed · 2 comments"
}
```

An action on a row comes the same way, `{"type":"action","id":"a7",
"section":"pull-request","action":"open","row":"checks/lint","input":{},
"project":"…"}`, the section named by its id, and is answered with a
`result` too. The plugin decides
what each name does; the app carries names, ids and arguments and nothing
more. Written with the helper package, a plugin is a handler per name:

```js
import { plugin } from "@elva-labs/workbench-plugin";

const p = plugin({ name: "github", version: "0.2.0" });

p.tool(
  "pr",
  { description: "The branch's pull request, its checks and review comments." },
  async ({ project }) =>
    text(
      await gh(project, [
        "pr",
        "view",
        "--json",
        "title,statusCheckRollup,reviews",
      ]),
    ),
);

p.section("pull-request", {
  title: "Pull request",
  actions: { refresh: { label: "Refresh" } },
  rows: async ({ project }) =>
    (await checks(project)).map((check) => ({
      id: check.name,
      label: check.name,
      state: check.conclusion === "success" ? "ok" : "failed",
      actions: { open: { label: "Open", default: true } },
    })),
});

p.action("pull-request", "open", ({ row }) => p.openUrl(row.id));
p.on("tree", ({ project }) => p.refresh("pull-request", project));

p.run();
```

Without the helper it is a loop over stdin lines and a switch on the
message's type, in any language that can read and write lines.

## Tools

A plugin's tools join the six of the app's on the tool server, each under
the plugin's name, `github_pr`, `git_commit`, so nothing collides with the
app's or another plugin's. A call lands in the request log as the app's
own do; the core hands it to the plugin's process and writes the plugin's
answer where the tool server waits for it, so the agent sees one server
and one round trip. A plugin that does not answer within a minute is
reported to the agent as such, and the call is over.

## Sections and actions

A section sits under the tree with media and processes, folded to its
header by default and counting its rows there. A row has a label, a line
of detail, a state, ok, busy, waiting or failed, drawn as the session dot
is, and actions. An action either runs at once or asks first: the plugin
declares the fields it needs, one or two, a line of text or a choice among
named options, and the app asks in a small dialog of its own. A section
can carry actions on its header too, "Commit", "Pull". Enter on a row runs
its default action; the rest show on hover and under the cursor, as the
stop button on a process does. The tree's cursor walks a plugin's rows as
it walks the others.

## The view

A plugin's view is a page it sends, written out or read from a file in its
own directory, shown in the changes pane's viewer in the frame the present tool uses for HTML: scripts run,
but the frame has no origin, no storage and no way at the window or the
machine. A bridge passes a fixed set of messages between the frame and the
plugin, through the app: data from the plugin to the page, and from the
page a request to open a file at lines, to put text in the agent's prompt,
or a message for the plugin. The page reaches nothing else.

The view declares how much room it wants. Wide is the viewer as a file
opens it, beside the tree; full is the whole changes pane, the tree folded
away while the view shows, which is what a graph of the branch needs. The
layout's rules stand either way: the agent keeps its minimum, and a dragged
splitter is remembered.

## Projects on other machines

A plugin runs on the machine the app does, and hears about every project
open there, a project on another machine among them. Its rows and its page
come home the way everything else from a remote does, with the host put
back on the paths it names, and what it runs to find them out runs here.
A plugin of the remote machine's own, cloned and run by the daemon there,
is the next piece of this and is not built.

## Writing one

A source can be a directory on the machine, added by path, with no clone,
so a plugin is written against the running app: build it, turn it off and
on again in the settings, and the next process is the new one. The
manifest is read afresh each time, so a tool or a section added to it
needs no more than that.

The `@elva-labs/workbench-plugin` package carries the protocol's types and
the loop, so a plugin in TypeScript is a manifest, a handler per tool,
section and action, and a line to run it.

## Settings

The plugins section lists the sources, each with its URL or path, its
pinned commit, its state and the actions to check for a newer commit,
update and remove, and under each source its plugins, each with what it
declares and a switch. A check across every source sits at the top of the
section.
