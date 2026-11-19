// Puts the name Chord wherever the app's name is shown to people or to the
// agents, and says what still names the app the old way, and why.
//
//   node scripts/chord-words.mjs          rewrite every tracked text file
//   node scripts/chord-words.mjs --check  change nothing; list what is left
//
// The rewrite is safe to run again, after other branches merge: it only
// replaces the shown name, and a line that says what the app was called
// before ("formerly Agent Workbench") is left as it is. The identifiers
// that carried the old name are Chord's too, and only what an install or
// the release still needs names the old one: the bundle identifier, the
// browser's data store, the migration that moves an install over, the
// old casks, formulas and Linux package the new ones replace. The check
// lists each line that still holds one, under the reason it stays, and
// exits with an error if a line holds an old name for no reason it knows.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");

/** The shown name, the release assets named after it, and the
    repository's address, in order. */
const WORDS = [
  [/Agent\.Workbench_/g, "Chord_"],
  [/Agent Workbench/g, "Chord"],
  [/elva-labs\/agent-workbench(?!-plugins)/g, "elva-labs/chord"],
];

/** A line that says what the app was called before keeps the old name. */
const HISTORY = /formerly|was called|earlier name|earlier address/i;

/** The repository's address before it moved to elva-labs/chord. GitHub
    redirects it, but nothing in the tree should lean on that: a line
    naming it fails the check whatever else it names, unless it says what
    the address was. The plugins repository keeps its own name. */
const OLD_REPOSITORY = /elva-labs\/agent-workbench(?!-plugins)/i;

/** The migration and its tests, which name the old app on purpose: the
    check lists them, and the rewrite leaves them as they are. */
const MIGRATION = /(^|\/)migrate(_tests)?\.rs$|(^|\/)migrate(\.test)?\.ts$|tests\/upgrade\.rs$/;

/** Files that name the old app on purpose throughout. */
const SKIP = new Set(["scripts/chord-words.mjs", "src-tauri/windows/hooks.nsh"]);

/** The earlier name in any form an identifier took: the name, the
    environment variables, the window's storage keys, the custom scheme
    and the core crate. */
const OLD_NAME = /agent[ ._-]?workbench/i;
const OLD_IDENTIFIER = /\bWORKBENCH_[A-Z]|["'`]workbench\.[a-z]|awb-page|workbench[-_]core/;
const OLD = { test: (line) => OLD_NAME.test(line) || OLD_IDENTIFIER.test(line) };

/** What still names the app the old way, and why it stays: the first rule
    whose pattern matches a line, in a file its path picks when it names
    one. */
const KEPT = [
  [/com\.elva-labs\.agent-workbench/, "the bundle identifier, which the window's storage, notifications and grants are kept under"],
  [/agent-workbench-plugins/, "the plugins repository, which keeps its name"],
  [/agent-workbench1/, "the embedded browser's data store, which holds its sign-ins"],
  [OLD, "the migration from the earlier names, the one place that knows them, and its tests", MIGRATION],
  [/mcp__agent-workbench__wait|\.agent-workbench\/"|"workbench\.open"/, "the migration's tests", /thread\.test\.ts$|orchestrator\.spec\.ts$/],
  [/agent-workbench@beta|cask: \[?"agent-workbench|Casks\/agent-workbench|--cask agent-workbench|cask "agent-workbench|cask is still `agent-workbench`|"agent-workbench": "chord"|`chord` and `agent-workbench`|chord@beta\s*$|^# names agent-workbench\.|token="agent-workbench"|conflicts='.*agent-workbench/, "the old casks, which the new ones conflict with or replace"],
  [/agent-workbench-remote/, "the old formulas and daemon, which the tap renames and the migration replaces", /release\.md$/],
  [/"(conflicts|replaces|provides|obsoletes)": \["agent-workbench"\]|where it was `agent-workbench`|provides `agent-workbench`/, "the Linux package the app had under its earlier name, which Chord's replaces"],
  [HISTORY, "says what the app was called before"],
];


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
    HISTORY.test(line) || MIGRATION.test(file) ? line : WORDS.reduce((done, [from, to]) => done.replace(from, to), line),
  );
  if (!check && after.join("\n") !== before) {
    writeFileSync(join(root, file), after.join("\n"));
    changed += 1;
  }
  (check ? lines : after).forEach((line, index) => {
    if (!OLD.test(line)) return;
    const where = `${file}:${index + 1}`;
    if (OLD_REPOSITORY.test(line) && !HISTORY.test(line)) {
      unexplained.push(`${where}: ${line.trim()} (the repository is elva-labs/chord)`);
      return;
    }
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
