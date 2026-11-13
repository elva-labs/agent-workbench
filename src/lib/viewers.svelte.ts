/**
 * What each session had in the viewer, kept while the user is elsewhere and
 * put back when they return: the file, its view and the place marked in
 * it, what the agent presented, a plugin's page, the browser, or nothing.
 * Switching sessions shows the one switched to as it was left, so a
 * document open beside one session is still open when the user comes back
 * to it, and the viewer is closed for a session that had nothing in it,
 * and opened again for one that had, as a file opened there would.
 */

import { tick } from "svelte";
import type { MediaItem } from "$lib/media.svelte";
import {
  activate as activateTab,
  browser,
  ownTabs,
  syncOwner,
} from "$lib/browser.svelte";
import {
  closeViewer,
  files,
  select,
  setScope,
  showBrowser,
  showMedia,
  showPluginView,
  treeSettled,
  type View,
} from "$lib/files.svelte";
import { enterReview, layout, togglePane } from "$lib/layout.svelte";
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
  | {
      kind: "plugin";
      project: string;
      page: NonNullable<typeof files.pluginView>;
    }
  | { kind: "browser"; project: string; tab: number | null }
  | null;

const viewed = new Map<string, Viewed>();

/** The session whose viewer is on screen. */
let shown: string | null = null;

/** What the viewer held when opening the sessions pane closed it. The
    pane is opened to pick a session, not to put the document away, so the
    session on screen keeps this as its viewer when the user switches from
    it; a document opened in the meantime takes its place. */
let parked: Viewed = null;

/** What the viewer holds right now, as the session on screen will get it
    back: null for nothing, and for the viewer closed. It belongs to the
    project given, the session's own: by the time a switch is seen the
    active project may already be the one switched to. */
export function snapshot(project = workspace.active): Viewed {
  if (project === null || layout.mode !== "reviewing") return null;
  if (files.media !== null) return { kind: "media", project, item: files.media };
  if (files.pluginView !== null)
    return { kind: "plugin", project, page: files.pluginView };
  if (browser.showing) return { kind: "browser", project, tab: browser.active };
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

/** Puts a session's viewer back, closed when it had nothing. Waits a tick
    first, since the switch may have moved the project or the worktree and
    the tree clears itself on that, and then for the tree to be read again,
    so a changed file is found in the list it is in. The keyboard stays
    where picking the session put it: this is the viewer coming back, not a
    file being opened. */
async function restore(what: Viewed) {
  await tick();
  if (what === null) {
    closeViewer();
    return;
  }
  if (what.project !== workspace.active) return;
  await treeSettled();
  if (what.project !== workspace.active) return;
  const focus = layout.focus;
  if (what.kind === "media") {
    showMedia(what.item);
  } else if (what.kind === "plugin") {
    showPluginView(what.page);
  } else if (what.kind === "browser") {
    // On the tab it was left on, if that is still open: the session's own
    // agent may have brought another to the front in between.
    await syncOwner();
    if (
      what.tab !== null &&
      what.tab !== browser.active &&
      ownTabs().some((tab) => tab.id === what.tab)
    ) {
      await activateTab(what.tab);
    }
    showBrowser();
  } else {
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
  layout.focus = focus;
}

/** Opens the sessions pane from its folded column. Reviewing is what folds
    it, so the viewer closes first, parked for its session, and the pane
    comes back with the working shape. A window too narrow for the pane
    leaves it folded. */
export function unfoldSessions() {
  if (layout.mode === "reviewing") {
    parked = snapshot();
    closeViewer();
  }
  if (!layout.sessionsChosen) togglePane("sessions");
}

/** The user switched to a session: what the one they left had is kept,
    and what this one had comes back. Resolves once it is on screen. */
export async function sessionShown(key: string | null) {
  if (shown !== null && shown !== key) {
    const own = byKey(shown)?.project ?? workspace.active;
    viewed.set(shown, layout.mode === "reviewing" ? snapshot(own) : parked);
  }
  parked = null;
  // The tabs on screen are the new session's from here on.
  const switching = syncOwner();
  for (const stale of viewed.keys()) {
    if (byKey(stale) === null) viewed.delete(stale);
  }
  const was = shown;
  shown = key;
  await switching;
  if (key === null || key === was) return;
  await restore(viewed.get(key) ?? null);
}

/** Test seam. */
export function resetViewers() {
  viewed.clear();
  shown = null;
  parked = null;
}
