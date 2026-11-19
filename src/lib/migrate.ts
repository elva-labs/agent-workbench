/**
 * What the window stored under the app's earlier name, Agent Workbench,
 * moved to Chord's names once, before anything reads it. This and the
 * core's migration are the only places that know the earlier names.
 *
 * Each key under `workbench.` becomes the same key under `chord.`, and a
 * path into the app's folder in the home, `.agent-workbench`, says
 * `.chord`, where the core moved the folder: open projects, the
 * orchestrator folder's record, session names and tokens, themes and the
 * rest are kept, and a session's notes, kept by the core under its token,
 * are found by the same token as before. A key Chord has written already
 * is kept as it is. Running again finds nothing to move.
 */

const OLD_PREFIX = "workbench.";
const NEW_PREFIX = "chord.";

/** The folder's earlier name, as a whole segment of a path, plain or as
    JSON writes one. */
const OLD_FOLDER = /([\\/])\.agent-workbench(?=[\\/"]|$)/g;

/** The tool server's names in transcripts written before the rename: to
    Claude Code, and as Codex's key. */
export const EARLIER_SERVER_NAMES: readonly string[] = ["agent-workbench", "agent_workbench"];

/** Moves every key stored under the earlier name to Chord's. */
export function migrateStorage(storage: Storage): void {
  const old: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(OLD_PREFIX)) old.push(key);
  }
  for (const key of old) {
    const value = storage.getItem(key);
    const renamed = NEW_PREFIX + key.slice(OLD_PREFIX.length);
    if (value !== null && storage.getItem(renamed) === null) {
      storage.setItem(renamed, value.replace(OLD_FOLDER, "$1.chord"));
    }
    storage.removeItem(key);
  }
}
