/**
 * The files the viewer shows as they are on disk, kept on record with the
 * core so it watches them where they are: what the agent presented, or a
 * picture or a document rendered from the tree, and the files open in the
 * editor's tabs. The record goes to the
 * machine the project is on, since that is where the files are; moving to
 * a project on another machine clears the record left behind, and a viewer
 * showing none of these clears it too.
 */

import { core } from "$lib/core";
import {
  absolute,
  effectiveView,
  files,
  isPicture,
  selectedEntry,
} from "$lib/files.svelte";
import { watchedFiles } from "$lib/editor.svelte";
import { hostOf, pathOn } from "$lib/remote.svelte";
import { workspace } from "$lib/workspace.svelte";

/** The files the viewer reads from disk right now, as the machine sees
    them, without the host. Empty for a diff, content or nothing at all;
    null with no project. */
export function viewedFiles(): { project: string; files: string[] } | null {
  const project = workspace.active;
  if (project === null) return null;
  const editing = watchedFiles();
  const shown = viewerFiles();
  return { project, files: [...new Set([...shown, ...editing])] };
}

/** What the viewer itself reads from disk. */
function viewerFiles(): string[] {
  if (files.media !== null) return files.media.files.map(pathOn);
  const entry = selectedEntry();
  if (entry === null || !(isPicture(entry) || effectiveView() === "rendered")) return [];
  const path = absolute(entry.path);
  return path === null ? [] : [path];
}

let last: { project: string; sent: string } | null = null;

const NONE = JSON.stringify([]);

/** Keeps the record current whenever what the viewer shows changes. Runs
    in an effect root: call once, from the page. */
export function watchViewed() {
  $effect(() => {
    const now = viewedFiles();
    const sent = JSON.stringify(now?.files ?? []);
    const project = now?.project ?? null;
    // The core that was watching is on the last project's machine. With no
    // project, or one on another machine, it is told to stop.
    if (
      last !== null &&
      last.sent !== NONE &&
      (project === null || hostOf(last.project) !== hostOf(project))
    ) {
      void core()
        .watchShown(last.project, [])
        .catch(() => {});
      last = null;
    }
    if (project === null) return;
    if (last !== null && last.project === project && last.sent === sent) return;
    if (last === null && sent === NONE) return;
    last = { project, sent };
    void core()
      .watchShown(project, now?.files ?? [])
      .catch(() => {});
  });
}

/** Test seam. */
export function resetViewed() {
  last = null;
}
