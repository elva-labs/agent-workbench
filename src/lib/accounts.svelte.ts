import type { AccountDirs, AgentId, Settings } from "$lib/core";
import { persist } from "$lib/persist";

/**
 * The agents' logins kept apart.
 *
 * An account is a name for a Claude Code configuration directory and a
 * Codex home of their own, each holding that agent's login, its settings
 * and its past sessions. Every project runs under one account: the one
 * chosen for every project, unless the project has a word of its own; and
 * a session can be started under another. The agents' own directories are
 * an account without a name, which every setup has, so a setup with no
 * accounts named is what it always was.
 *
 * The core keeps the accounts for the machine with the rest of the
 * settings. The window holds its copy and sends each change; what the
 * core answers, or announces from another window, is taken as it comes.
 */

export const accounts = $state({
  /** The user's own accounts, by name. */
  list: {} as Record<string, AccountDirs>,
  /** The account every project runs under; null is the agents' own. */
  everywhere: null as string | null,
  /** The projects with a word of their own: a name, or null for the
      agents' own, whatever the rest. */
  overrides: {} as Record<string, string | null>,
});

/** What the agents' own directories are called where a name is shown. */
export const OWN_LABEL = "Default";

/** How long a name may be, and how many accounts there may be; what the
    core holds the settings to. */
const LONGEST_NAME = 40;
const MOST_ACCOUNTS = 16;

/** The accounts' part of the settings. */
export function accountsSettings(): Settings["accounts"] {
  return {
    list: { ...accounts.list },
    everywhere: accounts.everywhere,
    overrides: { ...accounts.overrides },
  };
}

function isDirs(value: unknown): value is AccountDirs {
  if (typeof value !== "object" || value === null) return false;
  const { claude, codex } = value as Record<string, unknown>;
  return (
    (claude === null || typeof claude === "string") &&
    (codex === null || typeof codex === "string")
  );
}

/** Takes the core's word for the accounts, which is the machine's. A name
    the list does not hold is dropped from the choices. */
export function adoptAccounts(settings: Settings["accounts"] | undefined) {
  const list: Record<string, AccountDirs> = {};
  for (const [name, dirs] of Object.entries(settings?.list ?? {})) {
    if (isDirs(dirs)) list[name] = { claude: dirs.claude, codex: dirs.codex };
  }
  const everywhere =
    typeof settings?.everywhere === "string" && settings.everywhere in list
      ? settings.everywhere
      : null;
  const overrides: Record<string, string | null> = {};
  for (const [project, choice] of Object.entries(settings?.overrides ?? {})) {
    if (choice === null || (typeof choice === "string" && choice in list))
      overrides[project] = choice;
  }
  accounts.list = list;
  accounts.everywhere = everywhere;
  accounts.overrides = overrides;
}

/** The accounts' names, in the order they are offered. */
export function names(): string[] {
  return Object.keys(accounts.list).sort((a, b) => a.localeCompare(b));
}

/** Whether there is anything to choose between. */
export function hasAccounts(): boolean {
  return Object.keys(accounts.list).length > 0;
}

/** What an account is called where a name is shown. */
export function accountLabel(account: string | null): string {
  return account ?? OWN_LABEL;
}

/** The account a project runs under: its own word, else the one for
    every project. Null is the agents' own. */
export function accountOf(project: string): string | null {
  const own = accounts.overrides[project];
  const chosen = own === undefined ? accounts.everywhere : own;
  return chosen !== null && chosen in accounts.list ? chosen : null;
}

/** A project's own word: a name, null for the agents' own, or undefined
    when it follows the rest. */
export function overrideOf(project: string): string | null | undefined {
  const own = accounts.overrides[project];
  if (own === undefined) return undefined;
  if (own === null) return null;
  return own in accounts.list ? own : undefined;
}

/** Where an agent keeps its configuration under an account, or nothing
    for the agent's own directory. */
export function dirFor(
  account: string | null,
  agent: AgentId,
): string | undefined {
  if (account === null) return undefined;
  const dirs = accounts.list[account];
  if (dirs === undefined) return undefined;
  const dir = agent === "codex" ? dirs.codex : dirs.claude;
  return dir === null || dir.trim() === "" ? undefined : dir;
}

/** Every account's directories, for what is written into each account's
    agent state. */
export function dirsOf(): AccountDirs[] {
  return names().map((name) => accounts.list[name]);
}

/** A name as a directory spells it: lower case, a dash for anything that
    is not a letter or a digit. */
export function slug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "account" : slug;
}

/** The directories a name suggests: beside the agents' own, under the
    home, named after the account. */
export function suggest(name: string): AccountDirs {
  const tail = slug(name);
  return { claude: `~/.claude-${tail}`, codex: `~/.codex-${tail}` };
}

function tidy(dir: string | null): string | null {
  const text = dir?.trim() ?? "";
  return text === "" ? null : text;
}

/** Why a name will not do, or null when it will. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "An account needs a name.";
  if (trimmed.length > LONGEST_NAME)
    return `A name is ${LONGEST_NAME} characters at most.`;
  const taken = Object.keys(accounts.list).some(
    (known) => known.toLowerCase() === trimmed.toLowerCase(),
  );
  if (taken || trimmed.toLowerCase() === OWN_LABEL.toLowerCase())
    return `There is an account called ${trimmed} already.`;
  if (Object.keys(accounts.list).length >= MOST_ACCOUNTS)
    return `The settings hold ${MOST_ACCOUNTS} accounts at most.`;
  return null;
}

/** Adds an account, and says why not when it cannot. */
export function addAccount(name: string, dirs: AccountDirs): string | null {
  const problem = nameProblem(name);
  if (problem !== null) return problem;
  const claude = tidy(dirs.claude);
  const codex = tidy(dirs.codex);
  if (claude === null && codex === null)
    return "An account needs a directory for at least one agent.";
  accounts.list[name.trim()] = { claude, codex };
  save();
  return null;
}

/** Takes an account away. The projects that named it follow the rest
    again, and the rest run on the agents' own if it was theirs. */
export function removeAccount(name: string) {
  if (!(name in accounts.list)) return;
  delete accounts.list[name];
  if (accounts.everywhere === name) accounts.everywhere = null;
  for (const [project, choice] of Object.entries(accounts.overrides))
    if (choice === name) delete accounts.overrides[project];
  save();
}

/** The account for every project without a word of its own. */
export function setEverywhere(account: string | null) {
  if (account !== null && !(account in accounts.list)) return;
  accounts.everywhere = account;
  save();
}

/** A project's own word, or undefined to have it follow the rest again. */
export function setOverride(project: string, choice: string | null | undefined) {
  if (typeof choice === "string" && !(choice in accounts.list)) return;
  if (choice === undefined) delete accounts.overrides[project];
  else accounts.overrides[project] = choice;
  save();
}

function save() {
  persist({ accounts: accountsSettings() });
}

/** Test seam. */
export function reset() {
  accounts.list = {};
  accounts.everywhere = null;
  accounts.overrides = {};
}
