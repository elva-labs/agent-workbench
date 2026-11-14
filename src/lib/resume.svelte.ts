/**
 * The sessions an agent already has in a project, offered to resume.
 *
 * Under a project sit the sessions this app ran; the rest, everything the
 * agents ran there from anywhere, can be many, so they are behind one row
 * that opens a dialog with a filter over them, every agent's together. Picking one starts it as a
 * live session, in the worktree it ran in when it had one, under the
 * account it ran under.
 */

import type { AgentId } from "$lib/core";
import { focusPane } from "$lib/layout.svelte";
import { lastSegment } from "$lib/paths";
import { touch } from "$lib/projects.svelte";
import {
  create,
  historyLabel,
  outsideFor,
  type HistoryEntry,
} from "$lib/sessions.svelte";

export const resume = $state({
  open: false,
  project: null as string | null,
  agent: null as AgentId | null,
  query: "",
});

/** Opens the dialog over a project's earlier sessions: one agent's, or
    every agent's with no agent named. */
export function openResume(project: string, agent: AgentId | null = null) {
  resume.project = project;
  resume.agent = agent;
  resume.query = "";
  resume.open = true;
}

export function closeResume() {
  resume.open = false;
}

/** What the dialog lists: the project's outside sessions, the agent's or
    every agent's, newest first, narrowed to the ones holding every word of the query in
    their name, their id or the worktree they ran in. */
export function offered(): HistoryEntry[] {
  if (resume.project === null) return [];
  const all = outsideFor(resume.project, resume.agent);
  const words = resume.query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return all;
  return all.filter((entry) => {
    const text = [
      historyLabel(entry),
      entry.title ?? "",
      entry.id,
      entry.cwd ? lastSegment(entry.cwd) : "",
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Starts the session as a live one and closes. */
export function pickResume(entry: HistoryEntry) {
  if (resume.project === null) return;
  touch(resume.project);
  create(resume.project, entry.id, entry.agent, entry.cwd ?? null, null, null, entry.account);
  closeResume();
  focusPane("agent");
}

/** Test seam. */
export function resetResume() {
  resume.open = false;
  resume.project = null;
  resume.agent = null;
  resume.query = "";
}
