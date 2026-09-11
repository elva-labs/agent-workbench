<script lang="ts">
  import { onMount, untrack } from "svelte";
  import Splitter from "$lib/components/Splitter.svelte";
  import SessionsPane from "$lib/panes/SessionsPane.svelte";
  import AgentPane from "$lib/panes/AgentPane.svelte";
  import ChangesPane from "$lib/panes/ChangesPane.svelte";
  import TerminalPanel from "$lib/panes/TerminalPanel.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import Remote from "$lib/components/Remote.svelte";
  import { remote } from "$lib/remote.svelte";
  import Resume from "$lib/components/Resume.svelte";
  import { resume } from "$lib/resume.svelte";
  import { core } from "$lib/core";
  import { ensure as ensureHooks } from "$lib/hook.svelte";
  import { diffRequested, notified, showRequested, terminalRequested } from "$lib/show.svelte";
  import { watchSelection } from "$lib/selection.svelte";
  import { watchProcesses } from "$lib/processes.svelte";
  import {
    stateChanged as pluginStateChanged,
    watchPluginProjects,
    watchPluginUpdates,
  } from "$lib/plugins.svelte";
  import ActionInput from "$lib/components/ActionInput.svelte";
  import { noticed as pluginNoticed, pluginSections, sectionChanged } from "$lib/pluginSections.svelte";
  import { loadMedia, presented } from "$lib/media.svelte";
  import { loadNotices } from "$lib/notice.svelte";
  import { handle as handleDrag } from "$lib/drops.svelte";
  import { stash } from "$lib/exits";
  import { isMac, resolveAction } from "$lib/keymap";
  import { openSettings, settings } from "$lib/settings.svelte";
  import { cycleTheme, theme } from "$lib/theme.svelte";
  import {
    closeViewer,
    files,
    listed,
    requestField,
    select,
    toggleScope,
    toggleView,
  } from "$lib/files.svelte";
  import {
    cycle as cycleSession,
    ended as sessionEnded,
    exact,
    followCwd,
    identified,
    sessions,
    unreadCount,
    viewed,
  } from "$lib/sessions.svelte";
  import { attention, badge, followFocus } from "$lib/attention.svelte";
  import { cycle as cycleShell, ended as shellEnded, terminals } from "$lib/terminals.svelte";
  import { workspace } from "$lib/workspace.svelte";
  import {
    CONTROLS_INSET,
    DEFAULT,
    MIN,
    MIN_REVIEW,
    agentVisible,
    applyLayout,
    changesVisible,
    enterReview,
    exitReview,
    focusPane,
    layout,
    saveLayout,
    sessionsVisible,
    terminalVisible,
    togglePane,
    toggleTerminal,
  } from "$lib/layout.svelte";

  let viewport = $state(1200);
  let stack = $state(800);

  // What the agent presented before this window opened, back on the lists,
  // and which words to the user were already taken.
  loadMedia();
  loadNotices();

  // What is on screen, on record for the agent's tools, and what runs
  // under the sessions, for the section under the tree.
  watchSelection();
  watchProcesses();
  watchPluginUpdates();
  // Which projects are open, told to the core of each machine they are on,
  // so the plugins running there know them.
  watchPluginProjects();

  // Every project opened is brought to the hooks answer, once.
  $effect(() => {
    for (const project of workspace.open) ensureHooks(project.path);
  });

  // Every pty ends through one event, agent or shell. Whichever store has the
  // row takes it; an exit that beat its own spawn result waits to be claimed.
  onMount(() => {
    const offs: (() => void)[] = [];
    core()
      .onSessionEnded((event) => {
        if (!sessionEnded(event) && !shellEnded(event)) stash(event);
      })
      .then((unlisten) => offs.push(unlisten));
    core()
      .onSessionIdentified((event) => identified(event.ptyId, event.sessionId, event.title))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onSessionEvent((event) => exact(event.sessionId, event.kind))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onShowRequest((request) => void showRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPresentRequest((request) => presented(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onDiffRequest((request) => void diffRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onTerminalRequest((request) => terminalRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onNotifyRequest((request) => notified(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPluginState((event) => pluginStateChanged(event))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPluginSection((event) => sectionChanged(event))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPluginNotice((event) => pluginNoticed(event))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onFileDrag(handleDrag)
      .then((unlisten) => offs.push(unlisten));
    core()
      .onOpenSettings(openSettings)
      .then((unlisten) => offs.push(unlisten));
    // A connection going away takes every pty on it: each ends the way a
    // killed one does, and the pane says why.
    core()
      .onRemoteClosed((closed) => {
        const prefix = `ssh://${closed.host}#`;
        for (const session of sessions.all) {
          if (session.ptyId?.startsWith(prefix)) {
            sessionEnded({ id: session.ptyId, code: null, clean: false });
          }
        }
        for (const shell of terminals.all) {
          if (shell.ptyId?.startsWith(prefix)) {
            shellEnded({ id: shell.ptyId, code: null, clean: false });
          }
        }
        workspace.error = `${closed.host}: ${closed.reason}`;
      })
      .then((unlisten) => offs.push(unlisten));
    offs.push(followCwd());
    offs.push(followFocus());
    return () => offs.forEach((off) => off());
  });

  // Looking at a session is what reads it: the one on screen, in a window
  // that has focus. Either changing is a look.
  $effect(() => {
    const key = sessions.active;
    if (attention.focused && key !== null) viewed(key);
  });

  $effect(() => {
    badge(unreadCount());
  });

  let reviewing = $derived(layout.mode === "reviewing");

  let columns = $derived.by(() => {
    const cols: string[] = [];
    if (sessionsVisible()) cols.push(`${layout.sessions}px`, "var(--splitter-w)");
    if (agentVisible()) cols.push("1fr");
    if (changesVisible()) {
      if (agentVisible()) cols.push("var(--splitter-w)");
      // With the agent hidden the viewer is the only pane, so it takes the room
      // rather than holding a fixed width against empty space.
      cols.push(
        agentVisible() ? `${reviewing ? layout.review : layout.changes}px` : "1fr",
      );
    }
    return cols.join(" ");
  });

  function resizeSessions(dx: number) {
    layout.sessions = Math.max(MIN.sessions, layout.sessions + dx);
    applyLayout(viewport);
  }

  function resizeChanges(dx: number) {
    if (reviewing) {
      layout.review = Math.max(MIN_REVIEW, layout.review - dx);
      layout.reviewTouched = true;
    } else {
      layout.changes = Math.max(MIN.changes, layout.changes - dx);
    }
    applyLayout(viewport);
  }

  function resetChanges() {
    if (reviewing) {
      layout.review = DEFAULT.review;
      layout.reviewTouched = true;
    } else {
      layout.changes = DEFAULT.changes;
    }
    applyLayout(viewport);
    saveLayout();
  }

  // The bar sits above the panel, so dragging it down makes the panel shorter.
  function resizeTerminal(dy: number) {
    layout.terminal = Math.max(MIN.terminal, layout.terminal - dy);
    applyLayout(viewport, stack);
  }

  function resetTerminal() {
    layout.terminal = DEFAULT.terminal;
    applyLayout(viewport, stack);
    saveLayout();
  }

  function onKeydown(e: KeyboardEvent) {
    const action = resolveAction(e, { focus: layout.focus, reviewing });
    if (!action) return;
    e.preventDefault();
    switch (action.type) {
      case "focus":
        focusPane(action.pane);
        break;
      case "toggle":
        togglePane(action.pane);
        break;
      case "cycleTheme":
        cycleTheme();
        break;
      case "toggleReview":
        if (reviewing) closeViewer();
        else {
          // Opening the viewer with nothing chosen shows the first file rather
          // than an empty pane; with nothing listed, the empty pane is honest.
          if (files.selected === null) {
            const first = listed()[0];
            if (first !== undefined) select(first.path);
          }
          enterReview();
        }
        break;
      case "toggleView":
        toggleView();
        break;
      case "toggleScope":
        toggleScope();
        break;
      case "toggleTerminal":
        toggleTerminal();
        break;
      case "openSettings":
        openSettings();
        break;
      case "find":
        // The field lives in the changes pane, so the pane comes out if it
        // was closed, and takes focus.
        if (!changesVisible()) togglePane("changes");
        focusPane("changes");
        requestField(action.mode);
        break;
      case "cycle":
        // Shells when the keyboard is in the panel, sessions anywhere else,
        // and the keyboard lands in what was switched to.
        if (workspace.active === null) break;
        if (layout.focus === "terminal") cycleShell(workspace.active, action.direction);
        else if (cycleSession(workspace.active, action.direction)) focusPane("agent");
        break;
      case "exitReview":
        closeViewer();
        break;
    }
  }

  // Clamp against the grid's own content box rather than the window: the frame
  // has padding, and counting it as usable width is how the agent pane ends up
  // below its minimum on a small display. The height is the stack's, which
  // the panes and the terminal divide between them.
  $effect(() => {
    const width = viewport;
    const height = stack;
    untrack(() => applyLayout(width, height));
  });
</script>

<svelte:window on:keydown={onKeydown} />

<div class="frame" style:--controls-inset="{CONTROLS_INSET}px">
  <div class="stack" bind:clientHeight={stack}>
  <main
    class="shell"
    style:grid-template-columns={columns}
    data-testid="shell"
    data-mode={layout.mode}
    bind:clientWidth={viewport}
  >
    {#if sessionsVisible()}
      <SessionsPane />
      <Splitter
        label="Resize projects and sessions"
        onDelta={resizeSessions}
        onReset={() => {
          layout.sessions = DEFAULT.sessions;
          applyLayout(viewport);
          saveLayout();
        }}
        onCommit={saveLayout}
      />
    {/if}

    <!-- Hidden rather than unmounted, always. Unmounting would destroy the
         terminal; hiding leaves the pane at its width, so the PTY is never
         resized and the agent comes back exactly as it was. -->
    <div class="agent-slot" class:hidden={!agentVisible()}>
      <AgentPane />
    </div>

    {#if changesVisible()}
      {#if agentVisible()}
        <Splitter
          label={reviewing ? "Resize the viewer" : "Resize changes"}
          onDelta={resizeChanges}
          onReset={resetChanges}
          onCommit={saveLayout}
        />
      {/if}
      <ChangesPane />
    {/if}
  </main>

  <!-- Hidden rather than unmounted, for the same reason as the agent: the
       shells in it stay mounted, so hiding is free and showing is a fit. -->
  {#if terminalVisible()}
    <Splitter
      label="Resize the terminal"
      orientation="horizontal"
      onDelta={resizeTerminal}
      onReset={resetTerminal}
      onCommit={saveLayout}
    />
  {/if}
  <div
    class="terminal-slot"
    class:hidden={!terminalVisible()}
    style:height="{layout.terminal}px"
    data-testid="terminal-slot"
  >
    <TerminalPanel />
  </div>
  </div>
</div>

{#if settings.open}
  <Settings />
{/if}
{#if remote.open}
  <Remote />
{/if}
{#if resume.open}
  <Resume />
{/if}
{#if pluginSections.pending !== null}
  <ActionInput />
{/if}


<footer class="status no-select">
  <span class="focus" data-testid="focus-readout">focus: {layout.focus}</span>
  <span class="mode" data-testid="mode-readout">{layout.mode}</span>
  {#if unreadCount() > 0}
    <span class="waiting" data-testid="waiting-readout">
      {unreadCount()} waiting for you
    </span>
  {/if}
</footer>

<style>
  /* Wide enough that a pane's sharp corner stays clear of the window's
     rounded one on macOS. */
  .frame {
    --frame-pad: 10px;
    height: calc(100vh - 26px);
    padding: var(--frame-pad);
    background: var(--bg);
  }

  .stack {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  /* No padding here: clientWidth is then exactly the width the panes divide up. */
  .shell {
    display: grid;
    gap: 0;
    flex: 1;
    min-height: 0;
    align-items: stretch;
  }

  .terminal-slot {
    display: flex;
    flex: none;
    min-height: 0;
  }

  .terminal-slot.hidden {
    display: none;
  }

  .terminal-slot :global(.pane) {
    flex: 1;
    min-width: 0;
  }

  .agent-slot {
    display: flex;
    min-width: 0;
    min-height: 0;
  }

  .agent-slot.hidden {
    display: none;
  }

  .agent-slot :global(.pane) {
    flex: 1;
    min-width: 0;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 26px;
    padding: 0 12px;
    border-top: 1px solid var(--rule);
    background: var(--surface-2);
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
  }

  .focus {
    color: var(--accent);
  }

  .mode {
    color: var(--ink-3);
  }



  .waiting {
    color: var(--accent);
  }



  /* The status bar is the first thing to lose room; drop the least useful
     reminders rather than letting the row clip mid-word. */
  @media (max-width: 1100px) {
  }
</style>
