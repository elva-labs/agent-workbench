/**
 * The notes a session keeps of its own conversation, as the window reaches
 * them: whether a session has any, its notes opened in the viewer, and
 * letting go of them once the session cannot come back. The core keeps
 * them, where the session's project is, under the session's token; the
 * agent writes and reads them through the workbench's own tools.
 */
import { core } from "./core";
import { showMedia } from "./files.svelte";

/** A session as the notes know it: the project it runs in and its token. */
export interface NotesOwner {
  project: string;
  token: string;
}

/** Whether the session keeps a brief or notes. False when that cannot be
    read: the item that opens them is then left off, nothing else. */
export async function hasNotes(owner: NotesOwner): Promise<boolean> {
  try {
    const kept = await core().notesKept(owner.project, owner.token, false);
    return kept.brief || kept.standing > 0;
  } catch {
    return false;
  }
}

/** Opens the session's brief and notes in the viewer, written out afresh
    as a document, in place of whatever the viewer shows. */
export async function openNotes(owner: NotesOwner): Promise<boolean> {
  try {
    const kept = await core().notesKept(owner.project, owner.token, true);
    if (kept.page === null) return false;
    showMedia({
      id: `notes:${owner.token}`,
      owner: `notes:${owner.token}`,
      project: owner.project,
      files: [kept.page],
      caption: "Notes",
      at: Math.floor(Date.now() / 1000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Lets go of the notes of sessions that cannot come back, grouped by the
    project whose core keeps them. A failure leaves them kept, which costs
    only room. */
export function forgetNotes(owners: NotesOwner[]) {
  const byProject = new Map<string, string[]>();
  for (const { project, token } of owners) {
    if (token === "") continue;
    byProject.set(project, [...(byProject.get(project) ?? []), token]);
  }
  for (const [project, tokens] of byProject)
    void Promise.resolve()
      .then(() => core().notesForget(project, [...new Set(tokens)]))
      .catch(() => {});
}
