/**
 * Editor mode: the file tree and a plain text editor in the middle of the
 * window, the agent on the right.
 *
 * The mode belongs to the window and flips with the switch at the end of the
 * rightmost header. The changes pane is the files pane while editing: its
 * tree takes a column on the left and lists every file, and the editor takes
 * the rest. What the viewer held when the window flipped comes along: what
 * the agent presented, a plugin's page or the browser stays in the editor's
 * place, and going back to agent mode shows it in the viewer again.
 */

import { browser } from "$lib/browser.svelte";
import { deselect, files, setScope, type Scope } from "$lib/files.svelte";
import { enterReview, layout, setEditing } from "$lib/layout.svelte";
import { reduced } from "$lib/motion";

/** The tree's scope in agent mode, given back on leaving editor mode. */
let agentScope: Scope | null = null;
/** The tree's scope in editor mode: every file until the user narrows it. */
let editingScope: Scope = "all";

/** Whether the viewer holds something other than a file: what the agent
    presented, a plugin's page or the browser. In editor mode these take
    the editor's place. */
export function otherKindShown(): boolean {
  return files.media !== null || files.pluginView !== null || browser.showing;
}

/** The panes travel to their new places rather than jump, where the
    webview can draw the way between two layouts and the system does not
    ask for less movement. The layout changes in one step either way, so
    the agent is told one new size. */
function travel(change: () => void) {
  const start = (
    document as Document & { startViewTransition?: (update: () => void) => unknown }
  ).startViewTransition;
  if (typeof start !== "function" || reduced()) {
    change();
    return;
  }
  start.call(document, change);
}

/** Into editor mode. */
export function enterEditor() {
  if (layout.mode === "editing") return;
  travel(() => {
    agentScope = files.scope;
    setEditing(true);
    if (files.scope !== editingScope) void setScope(editingScope);
  });
}

/** Back to agent mode: the viewer opens again on what took the editor's
    place, else the agent has the middle with the changes beside it. */
export function leaveEditor() {
  if (layout.mode !== "editing") return;
  travel(() => {
    editingScope = files.scope;
    const keep = otherKindShown();
    if (!keep) deselect();
    setEditing(false);
    if (agentScope !== null && files.scope !== agentScope) void setScope(agentScope);
    agentScope = null;
    if (keep) enterReview();
  });
}

/** The switch, or its chord. */
export function flipMode() {
  if (layout.mode === "editing") leaveEditor();
  else enterEditor();
}

/** Test seam. */
export function resetEditor() {
  agentScope = null;
  editingScope = "all";
}
