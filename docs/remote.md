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

Two doors.

**A token from the machine.** Install the daemon there and run
`agent-workbench-remote connect`. It makes a key pair, authorises the public
half in the user's `authorized_keys` restricted to running the daemon and
nothing else, no shell, no forwarding, and prints a token holding the
private half, the machine's name and address, the user, and the machine's
own host key. Pasted into the desktop under Remote, that is everything:
the key goes to a file only this user can read, the host key to the app's
own known hosts, and the connection opens. When the machine's own name is
not one the desktop can resolve, `connect --host <address>` says where to
reach it instead; `--port` likewise. The token is a credential: whoever
has it can run the daemon on that machine as that user. To take it back,
remove the `agent-workbench` line from `authorized_keys` there.

**A host the user's own ssh reaches.** Named as it would be on the command
line, `name` or `user@name`. The app runs the user's ssh client with the
user's login environment, so agent keys, hardware keys, jump hosts and the
ssh configuration all apply, the configuration's host names are offered as
suggestions, and the daemon is put on the machine over the same connection
when it is missing or old, from the builds the app carries.

Every destination is checked to be a name and never a flag, since ssh reads
an argument starting with `-` as an option and an option can name a command
to run.

## A machine is its host key

A paired machine is known by its host key. Its name is what every project
path carries, `ssh://ada@lab/home/ada/repo`, and never changes; its address
and port are kept beside it and are what ssh is told to reach, with the host
key checked under the name whatever the address. When the address changes,
running `connect` on the machine again and pasting the new token is the
whole of it: the desktop recognises the host key, keeps the name, and takes
the new address and key, so every open project on it keeps working. Two
different machines with the same name get a suffix on the second.

## Installing the daemon on a machine

```
curl -fsSL https://raw.githubusercontent.com/elva-labs/agent-workbench/main/scripts/install-remote.sh | sh
```

puts the build for the machine under `~/.agent-workbench/bin`. With Homebrew
on the machine, `brew install elva-labs/elva/agent-workbench-remote` does the
same into its own bin, and `brew upgrade` keeps it current; the token from
`connect` names whichever daemon printed it. Each release carries the
builds as assets, for Linux x86_64 and aarch64 and both macOS
architectures. The desktop refuses a daemon at another version than its
own and says so, since the two speak the same protocol only when they match.

## What is not there yet

- Agents are detected here, not there. The new-session choice offers the
  agents installed on this machine; an agent missing on the remote fails when
  it starts, in the terminal.
- Files dropped on a remote session's terminal type this machine's paths.
- Windows remotes are untried. The daemon builds there, but `connect` and
  the install step speak to a POSIX shell.

## Trying it without a second machine

`WORKBENCH_REMOTE_COMMAND` names the process to run instead of ssh, `{host}`
replaced. The driver tier sets it to the daemon itself and opens the test
repository as `ssh://test/…`, so the whole road except ssh runs in CI. A
further test runs the real road, key, daemon install and all, against `sshd`
on the machine running the tests, when `WORKBENCH_SSH_LOCALHOST=1` is set.
