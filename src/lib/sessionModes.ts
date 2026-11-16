/**
 * The mode each integrated conversation last ran in, by the conversation's
 * id, so that one resumed or reopened integrated, after a restart too,
 * starts in it again.
 *
 * A mode is kept only while it is one the agent offers, as the agent says
 * it runs in it: one taken from the agent's own settings that a session
 * cannot switch to is left to those settings again. A run of the
 * conversation in a terminal lets its record go, since the window cannot
 * see the mode a terminal runs in; the agent's own record of that run
 * decides. Each conversation's record is its own and is never taken for
 * another's. The newest few hundred are kept.
 */

const KEY = "workbench.modes";
const MOST = 500;

let kept: Map<string, string> | null = null;

function read(): Map<string, string> {
  if (kept !== null) return kept;
  kept = new Map();
  try {
    const raw = localStorage.getItem(KEY);
    const stored: unknown = raw === null ? null : JSON.parse(raw);
    if (Array.isArray(stored))
      for (const entry of stored)
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string")
          kept.set(entry[0], entry[1]);
  } catch {
    // No mode is kept, then: each conversation starts as its agent's
    // settings say.
  }
  return kept;
}

function write(modes: Map<string, string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...modes]));
  } catch {
    // Non-fatal: the modes do not outlast the window.
  }
}

/** The mode the conversation last ran in integrated, where it is kept. */
export function modeOf(id: string): string | null {
  return read().get(id) ?? null;
}

/** The conversation now runs in `mode`: kept when it is one the agent
    offers, and let go otherwise. */
export function keepMode(id: string, mode: string | null, offered: boolean) {
  const modes = read();
  if (mode === null || !offered) {
    forgetMode(id);
    return;
  }
  if (modes.get(id) === mode) return;
  // The newest last, so the oldest go first.
  modes.delete(id);
  modes.set(id, mode);
  while (modes.size > MOST) modes.delete(modes.keys().next().value!);
  write(modes);
}

/** The conversation ran somewhere the window cannot see its mode. */
export function forgetMode(id: string) {
  const modes = read();
  if (modes.delete(id)) write(modes);
}

/** Test seam: reads the record again on next use. */
export function resetModes() {
  kept = null;
}
