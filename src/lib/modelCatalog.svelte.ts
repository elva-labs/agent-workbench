import { core, type AgentId } from "$lib/core";
import { agentProfile } from "$lib/agent.svelte";
import { accountOf, dirFor } from "$lib/accounts.svelte";

/**
 * The models an agent offers each account, as the agent lists them at run
 * time, and what each is called.
 *
 * Codex names a model by an id, such as `gpt-6.2-sol`, and its list says
 * how it reads, GPT-6.2-Sol. Every place that shows a Codex model names it
 * from here, as the composer does: a session's row and its tooltip, the
 * card of a session another started, the settings, the status bar, the
 * start tool's reply and the workflow pickers. A model no list names is
 * shown by its id. Claude Code's models are named as they always were, so
 * nothing is kept of its list.
 *
 * A list is heard when a session is ready, when a window catches up with a
 * running session, and from a read of Codex's own, asked for where the
 * account's list is wanted before a session of it has run, such as by the
 * workflow pickers. The last one heard for each account is kept while the
 * window is open, as the models each account offers are.
 */

export interface CatalogModel {
  value: string;
  name: string | null;
}

const catalogs = $state<{ byKey: Record<string, CatalogModel[]> }>({ byKey: {} });
/** The accounts whose list is being read, or was read, by this window. */
const asking = new Set<string>();

function keyOf(agent: AgentId, account: string | null): string {
  return `${agent}\n${account ?? ""}`;
}

/** The agent listed the models it offers the account. */
export function heardCatalog(agent: AgentId, account: string | null, models: readonly CatalogModel[]) {
  if (!agentProfile(agent).catalogNames || models.length === 0) return;
  catalogs.byKey[keyOf(agent, account)] = models.map(({ value, name }) => ({ value, name }));
}

/** The models the agent last listed for the account, or null where none
    has been heard. */
export function catalogOf(agent: AgentId, account: string | null): CatalogModel[] | null {
  return catalogs.byKey[keyOf(agent, account)] ?? null;
}

/** Every model the agent listed for any account, each once, in the order
    first heard. */
export function catalogsOf(agent: AgentId): CatalogModel[] {
  const all: CatalogModel[] = [];
  for (const [key, models] of Object.entries(catalogs.byKey)) {
    if (!key.startsWith(`${agent}\n`)) continue;
    for (const model of models) if (!all.some((known) => known.value === model.value)) all.push(model);
  }
  return all;
}

/** What a model of the agent is called where it is shown, for an agent
    whose models go by their list's names: as the account's list names it,
    else as any account's does, else as it is written. A note the name
    carries in brackets is left off, as the composer leaves it. Null for an
    agent whose models do not, which each place names as it always has. */
export function catalogName(agent: AgentId, model: string, account: string | null = null): string | null {
  if (!agentProfile(agent).catalogNames) return null;
  const named = (list: CatalogModel[] | null) => {
    const name = list?.find((known) => known.value === model)?.name ?? null;
    const bare = name?.replace(/\s*\(.*\)\s*$/, "").trim() ?? "";
    return bare === "" ? null : bare;
  };
  return named(catalogOf(agent, account)) ?? named(catalogsOf(agent)) ?? model;
}

/** Reads the models Codex offers the account the project runs under, on
    the project's machine, where no list of them has been heard. Each
    account's list is read once while the window is open; one that could
    not be read is read again when it is next asked for. */
export async function askCodexCatalog(project: string) {
  const account = accountOf(project);
  const key = keyOf("codex", account);
  if (catalogs.byKey[key] !== undefined || asking.has(key)) return;
  asking.add(key);
  try {
    const listed = await core().codexModels(project, dirFor(account, "codex"));
    heardCatalog("codex", account, listed.models);
  } catch {
    // Codex is not on the machine, or would not say; the ids stand.
    asking.delete(key);
  }
}

/** Test seam. */
export function resetCatalogs() {
  catalogs.byKey = {};
  asking.clear();
}
