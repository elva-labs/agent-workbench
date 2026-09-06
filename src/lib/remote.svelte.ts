/**
 * Projects on other machines, and the dialog that reaches them.
 *
 * A project's path says where it is: `ssh://user@host/path` is on that
 * machine, and the core routes everything by it. The dialog walks three
 * steps: name the machine, and it either connects or asks for a password
 * once, after which its folders are browsed and one is opened like any
 * other. Whether the machine is reached with the user's own ssh setup or
 * the app's key is the core's business.
 */

import { core, type RemoteDirs, type RemoteHosts } from "$lib/core";
import { openPath } from "$lib/workspace.svelte";

export const SCHEME = "ssh://";

export type Step = "connect" | "password" | "browse";

export const remote = $state({
  open: false,
  step: "connect" as Step,
  hosts: { configured: [], saved: [] } as RemoteHosts,
  host: "",
  user: "",
  password: "",
  /** What the machine identifies itself as, shown before a password goes there. */
  fingerprint: null as string | null,
  /** The `user@host` the connection is open to, once it is. */
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

/** The target ssh is given: `user@host`, or the host alone when the user's
    own configuration knows which user. */
export function targetFor(host: string, user: string): string {
  const h = host.trim();
  const u = user.trim();
  if (h === "") return "";
  return u === "" ? h : `${u}@${h}`;
}

/** Whether a failure to connect is one a password would fix: the machine
    is there and would not let the app in. */
export function needsSetup(error: string): boolean {
  return /permission denied|not accepted|publickey|too many authentication|host key/i.test(
    error,
  );
}

function reset() {
  remote.step = "connect";
  remote.password = "";
  remote.fingerprint = null;
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
  remote.password = "";
}

/** Names the machine. It connects, or it asks for a password once. */
export async function connect() {
  const target = targetFor(remote.host, remote.user);
  if (target === "") {
    remote.error = "Say which machine.";
    return;
  }
  remote.busy = true;
  remote.error = null;
  try {
    await core().remoteConnect(target);
    remote.target = target;
    await browse("");
  } catch (error) {
    const text = String(error);
    if (needsSetup(text)) {
      remote.step = "password";
      remote.fingerprint = await core()
        .remoteFingerprint(remote.host.trim())
        .catch(() => null);
    } else {
      remote.error = text;
    }
  } finally {
    remote.busy = false;
  }
}

/** The password, once: the app's key goes on the machine and the connection opens. */
export async function setup() {
  if (remote.user.trim() === "") {
    remote.error = "Say which user to log in as.";
    return;
  }
  if (remote.password === "") {
    remote.error = "The password is needed this once.";
    return;
  }
  remote.busy = true;
  remote.error = null;
  try {
    const opened = await core().remoteSetup(
      remote.host.trim(),
      remote.user.trim(),
      remote.password,
    );
    remote.password = "";
    remote.target = opened.host;
    await browse("");
  } catch (error) {
    remote.error = String(error);
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
  remote.user = "";
  remote.hosts = { configured: [], saved: [] };
}
