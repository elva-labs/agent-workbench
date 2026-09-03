import { core } from "$lib/core";

/**
 * The optional `PostToolUse` hook, per project.
 *
 * Off by default, and deliberately so: it writes into the project's
 * `.claude/settings.local.json`, and nothing should edit a person's
 * configuration because they happened to open a folder. The filesystem watcher
 * covers the same ground without asking anyone's permission.
 *
 * What turning it on buys is immediacy and provenance: the pane hears from the
 * agent the moment a tool finishes, rather than after the filesystem has
 * settled, and it hears what the agent actually did.
 */

export const hook = $state({
  /** By project path, so switching projects shows the right answer. */
  installed: {} as Record<string, boolean>,
  busy: false,
  error: null as string | null,
});

export function isInstalled(project: string | null): boolean {
  return project !== null && hook.installed[project] === true;
}

export function isKnown(project: string | null): boolean {
  return project !== null && hook.installed[project] !== undefined;
}

export async function check(project: string) {
  try {
    hook.installed[project] = (await core().hookStatus(project)).installed;
  } catch {
    // Not knowing is not an error worth showing: the watcher works regardless.
    hook.installed[project] = false;
  }
}

export async function toggle(project: string) {
  hook.busy = true;
  hook.error = null;
  try {
    const status = isInstalled(project)
      ? await core().hookUninstall(project)
      : await core().hookInstall(project);
    hook.installed[project] = status.installed;
  } catch (error) {
    hook.error = String(error);
  } finally {
    hook.busy = false;
  }
}

/** Test seam. */
export function reset() {
  hook.installed = {};
  hook.busy = false;
  hook.error = null;
}
