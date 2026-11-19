/**
 * The mode each conversation last ran in where the window knows it, by the
 * conversation's id, so that one resumed or reopened, after a restart too,
 * starts in it again.
 *
 * An integrated run keeps its conversation's record as the agent says it
 * runs: a mode is kept only while it is one the agent offers, and one
 * taken from the agent's own settings that a session cannot switch to is
 * left to those settings again.
 *
 * A terminal run started in the kept mode holds the record, since the
 * window cannot see the mode a terminal runs in, and Claude Code writes
 * down the mode its terminal ran in only as it shuts down, having written
 * the one it resumed in as it started. A run that shut down by itself, on
 * a quit or a hang-up, has written its own, and the record is let go: the
 * agent decides the next start as for any resume. A run that was killed
 * wrote nothing, and the record is kept, no longer held. A record
 * still held when the window starts belongs to a run whose end the window
 * never heard, as when the app quit under it, which hangs up on it: it is
 * let go then.
 *
 * Each conversation's record is its own and is never taken for another's.
 * The newest few hundred are kept.
 */

const KEY = "chord.modes";
const MOST = 500;
/** How a record a terminal run holds is marked where it is stored. */
const HELD = "terminal";

interface Kept {
  mode: string;
  held: boolean;
}

let kept: Map<string, Kept> | null = null;

function read(): Map<string, Kept> {
  if (kept !== null) return kept;
  kept = new Map();
  let lapsed = false;
  try {
    const raw = localStorage.getItem(KEY);
    const stored: unknown = raw === null ? null : JSON.parse(raw);
    if (Array.isArray(stored))
      for (const entry of stored) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
        // Held by a terminal run when the window last went: that run's
        // agent wrote down its own mode as it was hung up on.
        if (entry[2] === HELD) lapsed = true;
        else kept.set(entry[0], { mode: entry[1], held: false });
      }
  } catch {
    // No mode is kept, then: each conversation starts as its agent's
    // settings say.
  }
  if (lapsed) write(kept);
  return kept;
}

function write(modes: Map<string, Kept>) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify([...modes].map(([id, { mode, held }]) => (held ? [id, mode, HELD] : [id, mode]))),
    );
  } catch {
    // Non-fatal: the modes do not outlast the window.
  }
}

/** The mode the conversation last ran in where the window knows it. */
export function modeOf(id: string): string | null {
  return read().get(id)?.mode ?? null;
}

/** The conversation now runs integrated in `mode`: kept when it is one the
    agent offers, and let go otherwise. */
export function keepMode(id: string, mode: string | null, offered: boolean) {
  const modes = read();
  if (mode === null || !offered) {
    if (modes.delete(id)) write(modes);
    return;
  }
  const was = modes.get(id);
  if (was?.mode === mode && !was.held) return;
  // The newest last, so the oldest go first.
  modes.delete(id);
  modes.set(id, { mode, held: false });
  while (modes.size > MOST) modes.delete(modes.keys().next().value!);
  write(modes);
}

/** A terminal run of the conversation is up, in the mode kept for it where
    there is one: that run holds the record until it ends. */
export function holdMode(id: string) {
  const modes = read();
  const was = modes.get(id);
  if (was === undefined || was.held) return;
  was.held = true;
  write(modes);
}

/** The terminal run that holds the conversation's record has ended: by a
    shutdown of its own, which wrote the mode it ran in down, or killed. */
export function terminalEnded(id: string, shutDown: boolean) {
  const modes = read();
  const was = modes.get(id);
  if (was === undefined || !was.held) return;
  if (shutDown) modes.delete(id);
  else was.held = false;
  write(modes);
}

/** Test seam: reads the record again on next use, as a window starting
    does. */
export function resetModes() {
  kept = null;
}
