# Projects on other machines

A project's path says where it is. `/home/ada/repo` is here; `ssh://ada@box/home/ada/repo`
is on `box`, as `ada`. The window never learns the difference: every command
the panes make routes by the path or pty id it was given, and results and
events come back with the host put back on. A remote project has the same
sessions, changes pane, file viewer, search and hooks as one here; the work
happens on the machine the path names.

## The pieces

**The core crate**, `src-tauri/crates/core`, is everything that does not need
a window: ptys, git, the watcher, the transcript indexes, the hooks, the
session log. It hears nothing from Tauri. Events go through a `Sink`, a
pty's bytes to the `Output` its spawner handed over. The desktop app wraps
one `Core` in Tauri commands; the daemon wraps the same `Core` in lines on
stdio.

**The daemon**, `agent-workbench-remote serve`, is the core crate's binary.
One JSON object a line: requests in (`{"id", "method", "params"}`), answers
(`{"id", "result"}` or `{"id", "error"}`) and events (`{"event", "payload"}`)
out, with a pty's bytes as base64 in an event of their own. Method names and
parameters are the desktop app's own command names and arguments, so the app
forwards what its window asked for as it is. Each request gets a thread, so
a slow `git status` never holds up a keystroke. It ends when stdin does, and
with it every session it was running.

**The connection**, `client.rs`, is the near end: the process that carries
the lines, calls that block for their answer, events to a callback, and a
pty's bytes to the output attached for it, bytes that arrive before anyone
attached kept until they do. Whatever joins two stdios will carry it; ssh is
what does in practice.

**The router**, `src-tauri/src/remote.rs` and the commands in `lib.rs`.
`route()` reads a path or id: plain means the core here, `ssh://host/…` or
`ssh://host#pty-1` means the connection to `host`, opened the first time it
is named. A remote result comes back through `project_homeward` and an event
through `homeward`, which put `ssh://host` back on paths and ids. What has no
path to route by is asked of every open connection: a session's title, and
`git_unwatch`.

## Getting onto a machine

Three doors, in the order the dialog tries them.

1. **A host the user's own ssh reaches.** Nothing to set up: the app runs
   the user's ssh client with the user's login environment, so agent keys,
   hardware keys, jump hosts and `~/.ssh/config` all apply, and the config's
   host names are offered as suggestions.
2. **A host with only a password.** The app makes itself an ed25519 key with
   `ssh-keygen` the first time it needs one, under `~/.agent-workbench`, and
   installs the public half over the password, once. The password reaches ssh
   through the app itself in askpass mode (`agent-workbench --askpass`) and a
   file only this user can read, gone again after. Before anything goes to the
   machine, what it identifies itself as (`ssh-keyscan`, `ssh-keygen -l`) is
   shown for the user to trust. Machines set up this way are remembered in
   `~/.agent-workbench/remotes.json` and reached with that key and the app's
   own `known_hosts`; any other host is the user's ssh configuration's
   business, with `StrictHostKeyChecking=accept-new`.
3. **No ssh at all** is not built. A pairing code and a relay would be the
   shape of it.

Every destination is checked to be a name and never a flag: ssh reads an
argument starting with `-` as an option, and an option can name a command to
run.

## Putting the daemon there

Opening a connection first asks the machine whether it has the daemon at this
app's version, and when it does not, sends the build for what `uname -sm`
reports and puts it at `~/.agent-workbench/bin/agent-workbench-remote` over
the same connection. The build comes from `WORKBENCH_REMOTE_BIN` when a
developer names one, else from the app's bundled resources,
`resources/remote/<target>/agent-workbench-remote`, which the release
workflow fills with Linux x86_64 and aarch64 and macOS builds. A machine of
any other kind gets an error saying which build it would need.

## What is not there yet

- **Agents are detected here, not there.** The new-session choice offers the
  agents installed on this machine; an agent missing on the remote fails when
  it starts, in the terminal.
- **Files dropped** on a remote session's terminal type this machine's
  paths, which mean nothing there.
- **Windows remotes** are untried. The daemon builds there, but the install
  step speaks to a POSIX shell.
- **Codex's index and Claude Code's transcripts** are read on the remote,
  under the remote user's home, which is right; hooks likewise install there.

## Trying it without a second machine

`WORKBENCH_REMOTE_COMMAND` names the process to run instead of ssh, `{host}`
replaced: the driver tier sets it to the daemon itself and opens
`ssh://test/<repo>`, so the whole road except ssh runs in CI. The test in
`src-tauri/tests/localhost.rs` runs the real road, key, daemon install and
all, against `sshd` on this machine when `WORKBENCH_SSH_LOCALHOST=1` is set.
