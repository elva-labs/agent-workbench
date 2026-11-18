// Puts the name Chord wherever the app's name is shown to people or to the
// agents, and says what still names the app the old way, and why.
//
//   node scripts/chord-words.mjs          rewrite every tracked text file
//   node scripts/chord-words.mjs --check  change nothing; list what is left
//
// The rewrite is safe to run again, after other branches merge: it only
// replaces the shown name, and a line that says what the app was called
// before ("formerly Agent Workbench") is left as it is. The names that
// existing installs depend on are not shown names and are not touched:
// the bundle identifier, the home folder, the tool server and its tools,
// the daemon, environment variables, storage keys, the custom scheme,
// crate and package names and the repository. The check lists each line
// that still holds one, under the reason it stays, and exits with an
// error if a line holds the old name for no reason it knows.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");

/** The shown name and the release assets named after it, in order. */
const WORDS = [
  [/Agent\.Workbench_/g, "Chord_"],
  [/Agent Workbench/g, "Chord"],
];

/** A line that says what the app was called before keeps the old name. */
const HISTORY = /formerly|was called|earlier name/i;

/** Files that name the old app on purpose throughout. */
const SKIP = new Set(["scripts/chord-words.mjs", "src-tauri/windows/hooks.nsh"]);

/** What still names the app the old way, and why it stays: the first rule
    whose pattern matches a line, in a file its path picks when it names
    one. */
const SERVER = "the tool server's name, which agents' tool names and saved rules hold";
const KEPT = [
  [/com\.elva-labs\.agent-workbench/, "the bundle identifier, which the window's storage, notifications and grants are kept under"],
  [/elva-labs\/agent-workbench/, "the repository's name"],
  [/\.agent-workbench|agent-workbench-pair|agent-workbench-\{what\}/, "the home folder, and scratch files named like it"],
  [/agent-workbench-remote|AgentWorkbenchRemote|AGENT_WORKBENCH_VERSION/, "the daemon, its formula and its install script's variable"],
  [/agent-workbench@beta|cask: \[?"agent-workbench|Casks\/agent-workbench|--cask agent-workbench|cask "agent-workbench|cask is still `agent-workbench`|"agent-workbench": "chord"/, "the old casks, which the new ones conflict with or replace"],
  [/"(conflicts|replaces|provides|obsoletes)": \["agent-workbench"\]|where it was `agent-workbench`|provides `agent-workbench`/, "the Linux package the app had under its earlier name, which Chord's replaces"],
  [/agent-workbench`? line|AAAA agent-workbench|"agent-workbench\\n"|restrict \{\} agent-workbench|^\s*"agent-workbench",$/, "the comment on the daemon's line in authorized_keys, which pairing finds its own line by", /pair\.rs$|remote\.md$|agent-workbench-remote\.rs$/],
  [/^name = "agent-workbench"|^\s*"name": "agent-workbench",$|agent_workbench_lib/, "crate and package names", /Cargo\.(toml|lock)$|package(-lock)?\.json$|src-tauri\/(src|tests)\//],
  [/target\/\w+\/agent-workbench|<string>agent-workbench<|agent-workbench-driver|"agent-workbench(\.exe)?"|"agent-workbench", "\."/, "the binary the app's crate builds, and a test's scratch folder named like it", /harness\.ts$|launch\.rs$|testing\.md$|driver\.sh$|smoke\.sh$|scripts\//],
  [/mcp__agent[-_]workbench|"agent-workbench"|agent_workbench|SERVER_NAME|TOOL_SERVER|CLIENT_NAME|agent-workbench\/(wait|start)/, SERVER],
  [/agent-workbench1/, "the embedded browser's data store, which holds its sign-ins"],
  [/"agent-workbench\/[0-9]/, "Codex's user agent, which echoes the name the app gives Codex in its handshake"],
  [/agent-workbench-plugins/, "a project folder's name"],
  [HISTORY, "says what the app was called before"],
];

const OLD = /agent[ ._-]?workbench/i;

const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "" && !SKIP.has(file));

/** The file as text, or null for one that is not. */
function text(file) {
  const bytes = readFileSync(join(root, file));
  return bytes.includes(0) ? null : bytes.toString("utf8");
}

const check = process.argv.includes("--check");
let changed = 0;
const kept = new Map();
const unexplained = [];

for (const file of files) {
  const before = text(file);
  if (before === null) continue;
  const lines = before.split("\n");
  const after = lines.map((line) =>
    HISTORY.test(line) ? line : WORDS.reduce((done, [from, to]) => done.replace(from, to), line),
  );
  if (!check && after.join("\n") !== before) {
    writeFileSync(join(root, file), after.join("\n"));
    changed += 1;
  }
  (check ? lines : after).forEach((line, index) => {
    if (!OLD.test(line)) return;
    const where = `${file}:${index + 1}`;
    const reason = KEPT.find(([pattern, , path]) => pattern.test(line) && (path === undefined || path.test(file)))?.[1];
    if (reason === undefined) unexplained.push(`${where}: ${line.trim()}`);
    else kept.set(reason, [...(kept.get(reason) ?? []), where]);
  });
}

if (!check) console.log(`rewrote ${changed} files`);
for (const [reason, places] of kept) {
  const byFile = new Map();
  for (const place of places) {
    const file = place.slice(0, place.lastIndexOf(":"));
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  console.log(`\n${places.length} kept: ${reason}`);
  for (const [file, count] of byFile) console.log(`  ${file} (${count})`);
}
if (unexplained.length > 0) {
  console.log(`\n${unexplained.length} name the old app for no known reason:`);
  for (const line of unexplained) console.log(`  ${line}`);
  process.exitCode = 1;
}
