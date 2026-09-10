/**
 * What the user is looking at, kept on record for the agent's tools: the
 * file open in the viewer, whether as its diff or as it is, the lines
 * highlighted in it, or what was presented. The record goes to the machine
 * the project is on, since that is where the agent asks; moving to a
 * project on another machine clears the record left behind.
 */

import { core, type Selection } from "$lib/core";
import { files } from "$lib/files.svelte";
import { hostOf, pathOn } from "$lib/remote.svelte";
import { watchRoot, workspace } from "$lib/workspace.svelte";

/** The selection as the record should read, null for nothing open. Paths
    are as the machine sees them, without the host. */
export function currentSelection(): {
  project: string;
  selection: Selection | null;
} | null {
  const project = workspace.active;
  if (project === null) return null;
  const on = pathOn(project);
  if (files.media !== null) {
    return {
      project,
      selection: {
        project: on,
        file: null,
        view: null,
        from: null,
        to: null,
        media: {
          files: files.media.files.map(pathOn),
          caption: files.media.caption,
        },
      },
    };
  }
  if (files.selected === null) return { project, selection: null };
  const root = watchRoot() ?? project;
  // What the user selected with the mouse, else what the agent pointed at.
  const picked = files.picked?.path === files.selected ? files.picked : null;
  const target = files.target?.path === files.selected ? files.target : null;
  if (picked !== null) {
    return {
      project,
      selection: {
        project: on,
        file: `${pathOn(root).replace(/[\\/]+$/, "")}/${files.selected}`,
        view: files.view === "diff" ? "diff" : "file",
        from: picked.from,
        to: picked.to,
        media: null,
      },
    };
  }
  const from = target !== null && target.line > 0 ? target.line : null;
  return {
    project,
    selection: {
      project: on,
      file: `${pathOn(root).replace(/[\\/]+$/, "")}/${files.selected}`,
      view: files.view === "diff" ? "diff" : "file",
      from,
      to: from === null ? null : (target?.to ?? from),
      media: null,
    },
  };
}

let last: { project: string; sent: string } | null = null;

/** Puts the selection on record whenever it changes. Runs in an effect
    root: call once, from the page. */
export function watchSelection() {
  $effect(() => {
    const now = currentSelection();
    const sent = JSON.stringify(now?.selection ?? null);
    const project = now?.project ?? null;
    // A project on another machine than the last record's: that record is
    // cleared there, so the agent there is not told about a file here.
    if (
      last !== null &&
      project !== null &&
      hostOf(last.project) !== hostOf(project)
    ) {
      void core()
        .setSelection(last.project, null)
        .catch(() => {});
    }
    if (project === null) return;
    if (last !== null && last.project === project && last.sent === sent) return;
    last = { project, sent };
    void core()
      .setSelection(project, now?.selection ?? null)
      .catch(() => {});
  });
}

/** Test seam. */
export function resetSelection() {
  last = null;
}
