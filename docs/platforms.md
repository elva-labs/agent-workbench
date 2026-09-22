# Platforms

The app runs on macOS, Linux and Windows. The core has no platform-only
paths that matter to the panes; what differs is the window, how agents are
started, and what the platform will not say.

## macOS

The window has no title bar. The traffic lights sit over the header of the
leftmost pane, placed by the app; [layout](layout.md) has the details.
Following a session into a worktree reads the process's working directory
through the kernel's process information. The embedded browser has all of
it here: tabs, and the tools an agent reads and drives a page with alike.
See [browser](browser.md).

## Linux

WebKitGTK renders the window. Building needs the WebKitGTK development
package and the few libraries Tauri lists for AppImage bundling; the driver
tier needs the WebKitGTK WebDriver package and `tauri-driver`. The window is
undecorated and the app draws its own controls. A process's working
directory comes from procfs. A browser tab opens, navigates and closes
through WebKitGTK, in a layer the app lays over its own page, and gives
Escape and the app's chords back, but the tools that read or drive its page
are not supported there.

## Windows

WebView2 renders the window, undecorated, with app-drawn controls. Agents
installed by npm are `claude.cmd` and `codex.cmd`, which the core runs
through `cmd /c`; a project path is handed to it in the plain form, since
`cmd` refuses the verbatim `\\?\` form and would start the agent in the
Windows directory. The hooks run under Git Bash, which Claude Code needs
there anyway. Following a session into a worktree is not implemented, so
the changes pane stays on the project. The driver tier attaches to a running
app rather than launching one; [testing](testing.md) says why. A browser
tab opens, navigates and closes through WebView2, but its back and forward
buttons stay usable, a page keeps every key typed into it, and the tools
that read or drive its page are not supported.

## Opening folders from a terminal

On macOS the Homebrew cask puts `awb` on the PATH. `awb` opens the folder
the terminal is in as a project, and `awb <folder> ...` the folders it names.
It hands them to the app through `open`, so the system starts the app when
it is not running and sends them to it when it is. Folders named to
`open -a "Agent Workbench"` arrive the same way.

On Linux and Windows the app takes folders as arguments. Started again while
it runs, it hands its folders to the running app, which comes to the front,
and exits. Debug builds do not: they have the installed app's identifier,
and would hand themselves over to it.

Either way the folders open after the projects the window had last time,
and the last one named is left in front. A folder already open is brought
forward rather than opened twice.

## Remotes

A project on another machine runs the daemon there. Builds ship for Linux
x86_64 and aarch64 and both macOS architectures. See [remote](remote.md).
