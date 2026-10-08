/**
 * What each session had in the viewer, kept while the user is elsewhere and
 * put back when they return: the file, its view and the place marked in
 * it, or what the agent presented, or nothing. Switching sessions shows
 * the one switched to as it was left, so a document open beside one
 * session is still open when the user comes back to it. The shape of the
 * window is the viewer's own: a session with nothing to show empties it
 * without closing it, and one with something opens it when it was closed.
 */

import { tick } from "svelte";
import type { MediaItem } from "$lib/media.svelte";
import {
  deselect,
  files,
  select,
  setScope,
  showMedia,
  type View,
} from "$lib/files.svelte";
import { enterReview, layout } from "$lib/layout.svelte";
import { byKey } from "$lib/sessions.svelte";
import { workspace } from "$lib/workspace.svelte";

export type Viewed =
  | {
      kind: "file";
      project: string;
      path: string;
      view: View;
      target: NonNullable<typeof files.target> | null;
      picked: NonNullable<typeof files.picked> | null;
    }
  | { kind: "media"; project: string; item: MediaItem }
  | null;

const viewed = new Map<string, Viewed>();

/** The session whose viewer is on screen. */
let shown: string | null = null;

/** What the viewer holds right now, as the session on screen will get it
    back: null for nothing, and for the viewer closed. */
export function snapshot(): Viewed {
  const project = workspace.active;
  if (project === null || layout.mode !== "reviewing") return null;
  if (files.media !== null) return { kind: "media", project, item: files.media };
  if (files.selected === null) return null;
  return {
    kind: "file",
    project,
    path: files.selected,
    view: files.view,
    target: files.target?.path === files.selected ? files.target : null,
    picked: files.picked?.path === files.selected ? files.picked : null,
  };
}

/** Puts a session's viewer back. Waits a tick first, since the switch may
    have moved the project and the tree clears itself on that. */
async function restore(what: Viewed) {
  await tick();
  if (what === null) {
    deselect();
    return;
  }
  if (what.project !== workspace.active) return;
  if (what.kind === "media") {
    showMedia(what.item);
    return;
  }
  if (
    files.scope !== "all" &&
    !files.changed.some((file) => file.path === what.path)
  ) {
    await setScope("all");
  }
  files.view = what.view;
  files.target = what.target;
  await select(what.path);
  files.picked = what.picked;
  enterReview();
}

/** The user switched to a session: what the one they left had is kept,
    and what this one had comes back. Resolves once it is on screen. */
export async function sessionShown(key: string | null) {
  if (shown !== null && shown !== key) viewed.set(shown, snapshot());
  for (const stale of viewed.keys()) {
    if (byKey(stale) === null) viewed.delete(stale);
  }
  const was = shown;
  shown = key;
  if (key === null || key === was) return;
  await restore(viewed.get(key) ?? null);
}

/** Test seam. */
export function resetViewers() {
  viewed.clear();
  shown = null;
}
