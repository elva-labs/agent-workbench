/**
 * The model, the effort and the permission mode the user last chose for
 * each agent, which a new session of that agent starts on.
 *
 * What is kept is the user's own choice alone: a pick on a conversation's
 * chips once the agent took it, or a mode a Claude Code terminal switched
 * to after its run began, as its hooks report it. What an agent's default
 * was, a mode it fell back to, the model a workflow sets and what a session
 * another started was given are not choices. Plan, bypassing permissions
 * and Codex's full access are never kept, so a new session does not begin
 * unable to edit, or unguarded, because of where the last one stood; a
 * pick of one leaves what was kept before.
 *
 * The choices are the user's for the agent, not for an account or a
 * project, so they follow the user into every project. Where an account does
 * not offer the kept model, its sessions start on the agent's default, and
 * the choice stays for the accounts that do. It is a setting kept with the
 * others for the machine.
 */

import type { AgentId, Settings } from "$lib/core";
import { persist } from "$lib/persist";
import { carriedOver, noWider } from "$lib/modeFit";

/** What is kept for one agent; each left out where nothing was chosen. */
export interface Chosen {
  model?: string;
  effort?: string;
  mode?: string;
}

type Setting = keyof Chosen;

/** Claude Code's entry for its own default model, which keeps none. */
const DEFAULT_MODEL = "default";
/** How long a kept value may be. */
const LONGEST = 100;

export const lastChosen = $state<{ byAgent: Record<string, Chosen> }>({ byAgent: {} });

/** The models each account was last heard to offer, by agent and account,
    for as long as the window is open. */
const offers = new Map<string, string[]>();
/** The model an agent's default stands for under each account, as its
    sessions were told, by the same key. */
const defaults = new Map<string, string>();

function offersKey(agent: AgentId, account: string | null): string {
  return `${agent}\n${account ?? ""}`;
}

/** This part of the settings. */
export function lastChosenSettings(): Pick<Settings, "lastChosen"> {
  return { lastChosen: $state.snapshot(lastChosen.byAgent) };
}

function readable(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= LONGEST;
}

/** Takes the core's word for the machine: each agent's entry, with only
    the values that read. */
export function adoptLastChosen(value: unknown) {
  const byAgent: Record<string, Chosen> = {};
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    for (const [agent, entry] of Object.entries(value)) {
      if (typeof entry !== "object" || entry === null) continue;
      const kept: Chosen = {};
      for (const setting of ["model", "effort", "mode"] as const) {
        const one = (entry as Record<string, unknown>)[setting];
        // A mode a new session is not begun in starts nothing, whoever
        // wrote it to the file.
        if (readable(one) && (setting !== "mode" || carriedOver(agent as AgentId, one))) kept[setting] = one;
      }
      if (Object.keys(kept).length > 0) byAgent[agent] = kept;
    }
  lastChosen.byAgent = byAgent;
}

/** What is kept for an agent. */
export function chosenFor(agent: AgentId): Chosen {
  return lastChosen.byAgent[agent] ?? {};
}

/** Whether anything is kept for an agent. */
export function anyChosen(agent: AgentId): boolean {
  return Object.keys(chosenFor(agent)).length > 0;
}

function store(agent: AgentId, next: Chosen) {
  const byAgent = { ...lastChosen.byAgent };
  if (Object.keys(next).length === 0) delete byAgent[agent];
  else byAgent[agent] = next;
  lastChosen.byAgent = byAgent;
  persist({ lastChosen: $state.snapshot(byAgent) });
}

/** The user chose `value` for an agent's sessions. Claude Code's default
    model keeps none, and a mode a new session is not begun in leaves what
    was kept. */
export function choose(agent: AgentId, setting: Setting, value: string) {
  if (!readable(value)) return;
  if (setting === "mode" && !carriedOver(agent, value)) return;
  const was = chosenFor(agent);
  const next: Chosen = { ...was };
  if (setting === "model" && value === DEFAULT_MODEL) delete next.model;
  else next[setting] = value;
  if (next.model === was.model && next.effort === was.effort && next.mode === was.mode) return;
  store(agent, next);
}

/** What stands in for no mode kept, when a report is weighed against it:
    the mode that asks before anything changes. */
const ASKS: Record<AgentId, string> = { "claude-code": "default", codex: "read-only" };

/** A Claude Code terminal's hooks say it switched to `mode`. Any process of
    the user's can write what the hooks report, so such a switch is kept
    only where it goes no further than what is kept now, Default standing
    in for nothing kept: a report can narrow what new sessions begin in,
    never widen it. A wider mode is kept only from a chip. */
export function narrowTo(agent: AgentId, mode: string) {
  const now = chosenFor(agent).mode ?? ASKS[agent];
  if (noWider(agent, mode, now)) choose(agent, "mode", mode);
}

/** New sessions of the agent start on its own defaults again. */
export function forget(agent: AgentId) {
  if (anyChosen(agent)) store(agent, {});
}

/** An account's sessions of the agent were told which models it offers,
    and where the agent said, which model its default stands for. */
export function heardOffers(agent: AgentId, account: string | null, models: string[], fallback: string | null = null) {
  if (models.length > 0) offers.set(offersKey(agent, account), [...models]);
  if (fallback !== null) defaults.set(offersKey(agent, account), fallback);
}

/** The model a session of the agent under the account runs on when none
    is chosen for it, where a session of it has said. Null where none has. */
export function defaultModelOf(agent: AgentId, account: string | null): string | null {
  return defaults.get(offersKey(agent, account)) ?? null;
}

/** The model a new session of the agent under the account starts on: the
    kept one, unless the account was heard not to offer it. Null for the
    agent's own default. */
export function modelToStart(agent: AgentId, account: string | null): string | null {
  const model = chosenFor(agent).model ?? null;
  if (model === null) return null;
  const offered = offers.get(offersKey(agent, account));
  return offered === undefined || offered.includes(model) ? model : null;
}

/** Test seam. */
export function resetLastChosen() {
  lastChosen.byAgent = {};
  offers.clear();
  defaults.clear();
}
