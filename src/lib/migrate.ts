/**
 * What the window stored under the app's earlier name, Agent Workbench,
 * moved to Chord's names before anything reads it. This and the core's
 * migration are the only places that know the earlier names.
 *
 * Each key under `workbench.` is copied to the same key under `chord.`,
 * unless Chord has written that key already. The core keeps to the folder
 * of the earlier name, `.agent-workbench`, until it has moved it to
 * `.chord`, and says which it is on through the orchestrator folder's
 * path. While it is on the old folder the values are copied as they are
 * and the old keys stay. Once it is on `.chord`, a path into the old
 * folder says `.chord` in every `chord.` value, which covers open
 * projects, the orchestrator folder's record, session rows and remote
 * paths, and the old keys go. Session tokens move with their key
 * unchanged, and the core moved the notes store with the folder, so a
 * session's notes are found by the same token. With no old key left there
 * is nothing to do and nothing to ask the core.
 */

const OLD_PREFIX = "workbench.";
const NEW_PREFIX = "chord.";

/** The folder's earlier name, as a whole segment of a path, plain or as
    JSON writes one. */
const OLD_FOLDER = /([\\/])\.agent-workbench(?=[\\/"]|$)/g;
const IN_OLD_FOLDER = /[\\/]\.agent-workbench(?=[\\/"]|$)/;

/** The tool server's names in transcripts written before the rename: to
    Claude Code, and as Codex's key. */
export const EARLIER_SERVER_NAMES: readonly string[] = ["agent-workbench", "agent_workbench"];

function keysUnder(storage: Storage, prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** Moves every key stored under the earlier name to Chord's. `folder`
    asks the core for the orchestrator folder's path; a core that cannot
    say is taken to be on the old folder still. */
export async function migrateStorage(storage: Storage, folder: () => Promise<string>): Promise<void> {
  const old = keysUnder(storage, OLD_PREFIX);
  if (old.length === 0) return;
  let moved: boolean;
  try {
    moved = !IN_OLD_FOLDER.test(await folder());
  } catch {
    moved = false;
  }
  for (const key of old) {
    const value = storage.getItem(key);
    const renamed = NEW_PREFIX + key.slice(OLD_PREFIX.length);
    if (value !== null && storage.getItem(renamed) === null) storage.setItem(renamed, value);
  }
  if (!moved) return;
  for (const key of keysUnder(storage, NEW_PREFIX)) {
    const value = storage.getItem(key);
    if (value === null) continue;
    const renamed = value.replace(OLD_FOLDER, "$1.chord");
    if (renamed !== value) storage.setItem(key, renamed);
  }
  for (const key of old) storage.removeItem(key);
}
