# Projects on other machines

A project's path says where it is. `/home/ada/repo` is here;
`ssh://ada@box/home/ada/repo` is on `box`, as `ada`. The window never learns
the difference: every command the panes make routes by the path or pty id it
was given, and results and events come back with the host put back on. A
remote project has the same sessions, changes pane, file viewer, search and
hooks as one here; the work happens on the machine the path names.

## The pieces

**The core** is everything that does not need a window, as
[architecture](architecture.md) describes. The desktop app wraps one core in
Tauri commands; the daemon wraps the same core in lines on stdio.

**The daemon**, `agent-workbench-remote serve`, speaks one JSON object a
line: requests in, answers and events out, with a pty's bytes as base64 in an
event of their own. Method names and parameters are the desktop app's own
command names and arguments, so the app forwards what its window asked for
as it is. Each request gets a thread, so a slow `git status` never holds up
a keystroke. It ends when stdin does, and with it every session it was
running.

**The connection** is the near end: the process that carries the lines,
calls that block for their answer, events to a callback, and a pty's bytes
to the output attached for it. Bytes that arrive before anyone attached are
kept until they do. Whatever joins two stdios will carry it; ssh is what
does.

**The router** reads a path or id: plain means the core here, `ssh://host/…`
or `ssh://host#pty-1` means the connection to `host`, opened the first time
it is named. What has no path to route by, a session's title, the end of
watching, is asked of every open connection.

## Getting onto a machine

Three doors, in the order the dialog tries them.

1. **A host the user's own ssh reaches.** Nothing to set up: the app runs the
   user's ssh client with the user's login environment, so agent keys,
   hardware keys, jump hosts and the ssh configuration all apply, and the
   configuration's host names are offered as suggestions.
2. **A host with only a password.** The app makes itself an ed25519 key with
   `ssh-keygen` the first time it needs one and installs the public half over
   the password, once. The password reaches ssh through the app itself as its
   askpass program and a file only this user can read, gone again after.
   Before anything goes to the machine, what it identifies itself as is shown
   for the user to trust. Machines set up this way are remembered and reached
   with that key and the app's own known hosts; any other host is the user's
   ssh configuration's business, with new host keys accepted and changed ones
   refused.
3. **No ssh at all** is not built. A pairing code and a relay would be the
   shape of it.

Every destination is checked to be a name and never a flag, since ssh reads
an argument starting with `-` as an option and an option can name a command
to run.

## Putting the daemon there

Opening a connection first asks the machine whether it has the daemon at this
app's version, and when it does not, sends the build for what `uname -sm`
reports and installs it under the user's home there over the same
connection. Every app carries builds for Linux x86_64 and aarch64 and both
macOS architectures; a developer can name another build with
`WORKBENCH_REMOTE_BIN`. A machine of any other kind gets an error saying
which build it would need.

## What is not there yet

- Agents are detected here, not there. The new-session choice offers the
  agents installed on this machine; an agent missing on the remote fails when
  it starts, in the terminal.
- Files dropped on a remote session's terminal type this machine's paths.
- Windows remotes are untried. The daemon builds there, but the install step
  speaks to a POSIX shell.

## Trying it without a second machine

`WORKBENCH_REMOTE_COMMAND` names the process to run instead of ssh, `{host}`
replaced. The driver tier sets it to the daemon itself and opens the test
repository as `ssh://test/…`, so the whole road except ssh runs in CI. A
further test runs the real road, key, daemon install and all, against `sshd`
on the machine running the tests, when `WORKBENCH_SSH_LOCALHOST=1` is set.
