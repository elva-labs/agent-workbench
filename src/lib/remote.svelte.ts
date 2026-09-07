/**
 * Projects on other machines, and the dialog that reaches them.
 *
 * A project's path says where it is: `ssh://user@host/path` is on that
 * machine, and the core routes everything by it. The dialog has two ways
 * in: a token pasted from `agent-workbench-remote connect` run on the
 * machine, which brings everything the desktop needs, or the name of a
 * host the user's own ssh setup already reaches. Either way the machine's
 * folders are then browsed and one is opened like any other.
 */

import { core, type RemoteDirs, type RemoteHosts } from "$lib/core";
import { openPath } from "$lib/workspace.svelte";

export const SCHEME = "ssh://";

export type Step = "connect" | "browse";

export const remote = $state({
  open: false,
  step: "connect" as Step,
  hosts: { configured: [], saved: [] } as RemoteHosts,
  /** What the machine printed, pasted. */
  token: "",
  /** A host the user's own ssh reaches, `name` or `user@name`. */
  host: "",
  /** The target the connection is open to, once it is. */
  target: null as string | null,
  listing: null as RemoteDirs | null,
  busy: false,
  error: null as string | null,
});

export function isRemote(path: string): boolean {
  return path.startsWith(SCHEME);
}

/** The `user@host` a path is on, or null for a path here. */
export function hostOf(path: string): string | null {
  if (!isRemote(path)) return null;
  const rest = path.slice(SCHEME.length);
  const end = rest.search(/[/#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The path on the machine, without the host. */
export function pathOn(path: string): string {
  if (!isRemote(path)) return path;
  const rest = path.slice(SCHEME.length);
  const at = rest.indexOf("/");
  return at === -1 ? "/" : rest.slice(at);
}

/** One directory up, staying on the machine; null at its root. */
export function parentOf(path: string): string | null {
  const host = hostOf(path);
  if (host === null) return null;
  const on = pathOn(path).replace(/\/+$/, "");
  if (on === "") return null;
  const cut = on.lastIndexOf("/");
  return `${SCHEME}${host}${cut <= 0 ? "/" : on.slice(0, cut)}`;
}

/** Whether pasted text has the shape of a token, so the field can say so
    before anything is sent. */
export function looksLikeToken(text: string): boolean {
  return /^awb1\.[A-Za-z0-9_-]+$/.test(text.trim());
}

function reset() {
  remote.step = "connect";
  remote.token = "";
  remote.target = null;
  remote.listing = null;
  remote.busy = false;
  remote.error = null;
}

export async function openRemote() {
  reset();
  remote.open = true;
  try {
    remote.hosts = await core().remoteHosts();
  } catch {
    // Nothing to suggest is not an error; the field takes any name.
  }
}

export function closeRemote() {
  remote.open = false;
  remote.token = "";
}

/** The token, pasted: the machine's key, address and user come with it. */
export async function pair() {
  const token = remote.token.trim();
  if (token === "") {
    remote.error = "Paste what the machine printed.";
    return;
  }
  if (!looksLikeToken(token)) {
    remote.error = "That is not a token from agent-workbench-remote connect.";
    return;
  }
  remote.busy = true;
  remote.error = null;
  try {
    const opened = await core().remotePair(token);
    remote.token = "";
    remote.target = opened.host;
    await browse("");
  } catch (error) {
    remote.error = String(error);
  } finally {
    remote.busy = false;
  }
}

/** A host the user's own ssh reaches, by name. */
export async function connect() {
  const target = remote.host.trim();
  if (target === "") {
    remote.error = "Say which host.";
    return;
  }
  remote.busy = true;
  remote.error = null;
  try {
    await core().remoteConnect(target);
    remote.target = target;
    await browse("");
  } catch (error) {
    remote.error = String(error);
    // A paired machine is reached at the address its token carried, and
    // addresses move. A new token from it brings the new one.
    if (remote.hosts.saved.some((saved) => saved.target === target)) {
      remote.error +=
        " If the machine's address has changed, run agent-workbench-remote connect there again and paste the new token.";
    }
  } finally {
    remote.busy = false;
  }
}

/** Lists a directory on the machine; "" is its home. */
export async function browse(path: string) {
  if (remote.target === null) return;
  remote.busy = true;
  remote.error = null;
  try {
    remote.listing = await core().remoteDirs(remote.target, path);
    remote.step = "browse";
  } catch (error) {
    remote.error = String(error);
  } finally {
    remote.busy = false;
  }
}

/** Opens a folder on the machine as a project, like any other. */
export async function choose(path: string) {
  closeRemote();
  await openPath(path);
}

/** Test seam. */
export function resetRemote() {
  reset();
  remote.open = false;
  remote.host = "";
  remote.hosts = { configured: [], saved: [] };
}
