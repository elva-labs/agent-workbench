# Platforms

The app runs on macOS, Linux and Windows. The core has no platform-only
paths that matter to the panes; what differs is the window, how agents are
started, and what the platform will not say.

## macOS

The window has no title bar. The traffic lights sit over the header of the
leftmost pane, placed by the app; [layout](layout.md) has the details.
Following a session into a worktree reads the process's working directory
through the kernel's process information.

## Linux

WebKitGTK renders the window. Building needs the WebKitGTK development
package and the few libraries Tauri lists for AppImage bundling; the driver
tier needs the WebKitGTK WebDriver package and `tauri-driver`. The window is
undecorated and the app draws its own controls. A process's working
directory comes from procfs.

## Windows

WebView2 renders the window, undecorated, with app-drawn controls. Agents
installed by npm are `claude.cmd` and `codex.cmd`, which the core runs
through `cmd /c`; a project path is handed to it in the plain form, since
`cmd` refuses the verbatim `\\?\` form and would start the agent in the
Windows directory. The hooks run under Git Bash, which Claude Code needs
there anyway. Following a session into a worktree is not implemented, so
the changes pane stays on the project. The driver tier attaches to a running
app rather than launching one; [testing](testing.md) says why.

## Remotes

A project on another machine runs the daemon there. Builds ship for Linux
x86_64 and aarch64 and both macOS architectures. See [remote](remote.md).
