import type { AgentId } from "$lib/core";

/**
 * How far a permission mode lets a session go with no one asked, on one
 * scale for both agents, so that a mode of one can be held to a mode of
 * the other. Claude Code's Don't ask refuses what Default would ask about,
 * so neither does more unasked and they stand on one step. Codex's Read
 * only asks before it changes anything, as Default does; its Auto changes
 * files and runs commands without asking, but only inside its sandbox,
 * which takes it past Accept edits and short of Claude Code's Auto, which
 * has none. Full access and bypassing permissions ask nothing. A mode not
 * named here stands nowhere.
 */
const STANDING: Record<AgentId, Record<string, number>> = {
  "claude-code": { plan: 0, dontAsk: 1, default: 1, acceptEdits: 2, auto: 4, bypassPermissions: 5 },
  codex: { "read-only": 1, auto: 3, "full-access": 5 },
};

/** The modes the workbench starts a session of each agent in, widest
    first; of two on one step, the one a session of the other agent is
    given comes first. Bypassing permissions is not among them: Claude
    Code takes it only from a flag of its own. */
const STARTED_IN: Record<AgentId, readonly string[]> = {
  "claude-code": ["auto", "acceptEdits", "default", "dontAsk", "plan"],
  codex: ["full-access", "auto", "read-only"],
};

function standing(agent: AgentId, mode: string): number | null {
  return Object.hasOwn(STANDING[agent], mode) ? STANDING[agent][mode] : null;
}

/**
 * The mode a session of `agent` begins in when a session of `from` that
 * runs in `mode` starts it: that mode itself where the agents are one and
 * it is one the workbench starts a session in, else the widest one that
 * goes no further. Where none goes no further, as a Codex session started
 * from Claude Code's Plan, the narrowest. Null where `mode` is not on the
 * scale.
 */
export function fitMode(from: AgentId, mode: string, agent: AgentId): string | null {
  const most = standing(from, mode);
  if (most === null) return null;
  const modes = STARTED_IN[agent];
  if (from === agent && modes.includes(mode)) return mode;
  return modes.find((each) => STANDING[agent][each] <= most) ?? modes[modes.length - 1];
}

/** The nearest mode below `mode` that the workbench starts a session of
    the agent in. Null where none is, and for a mode not on the scale. */
export function nextNarrower(agent: AgentId, mode: string): string | null {
  const at = standing(agent, mode);
  if (at === null) return null;
  return STARTED_IN[agent].find((each) => STANDING[agent][each] < at) ?? null;
}

/** The narrower of two modes of one agent; either where the other is
    null. */
export function narrowerOf(agent: AgentId, one: string | null, other: string | null): string | null {
  if (one === null) return other;
  if (other === null) return one;
  return (standing(agent, other) ?? Infinity) < (standing(agent, one) ?? Infinity) ? other : one;
}
