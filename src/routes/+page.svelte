<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { cubicOut } from "svelte/easing";
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
  import ConductAsk from "$lib/components/ConductAsk.svelte";
  import { conductor, handle as conductRequested } from "$lib/conductor.svelte";
  import { handle as browserRequested } from "$lib/browserTools.svelte";
  import { load as loadOrchestrator } from "$lib/orchestrator.svelte";
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
  import { dataArrived as pluginViewData, viewChanged as pluginViewChanged } from "$lib/pluginView.svelte";
  import { loadMedia, presented } from "$lib/media.svelte";
  import { initBrowser } from "$lib/browser.svelte";
  import { loadNotices } from "$lib/notice.svelte";
  import { handle as handleDrag } from "$lib/drops.svelte";
  import { stash } from "$lib/exits";
  import { isMac, resolveAction } from "$lib/keymap";
  import { keys } from "$lib/keys.svelte";
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
    unfoldSessions,
  } from "$lib/files.svelte";
  import {
    cycle as cycleSession,
    ended as sessionEnded,
    exact,
    followCwd,
    followHistory,
    refreshHistory,
    identified,
    sessions,
    unreadCount,
    viewed,
  } from "$lib/sessions.svelte";
  import { attention, badge, followFocus } from "$lib/attention.svelte";
  import { PANE_MOTION, reduced } from "$lib/motion";
  import { cycle as cycleShell, ended as shellEnded, terminals } from "$lib/terminals.svelte";
  import { workspace } from "$lib/workspace.svelte";
  import {
    CONTROLS_INSET,
    DEFAULT,
    FOLDED,
    MIN,
    MIN_REVIEW,
    agentVisible,
    applyLayout,
    browserFocused,
    changesSpan,
    changesVisible,
    changesWidth,
    enterReview,
    exitReview,
    focusPane,
    layout,
    saveLayout,
    sessionsOpen,
    sessionsVisible,
    sliding,
    terminalOpen,
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
    void initBrowser();
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
      .onConductRequest((request) => void conductRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onBrowserRequest((request) => void browserRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onBrowserFocused(() => browserFocused())
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
      .onPluginView((event) => pluginViewChanged(event))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPluginViewData((event) => pluginViewData(event))
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
    void loadOrchestrator();
    offs.push(followCwd());
    offs.push(followHistory());
    offs.push(followFocus());
    return () => offs.forEach((off) => off());
  });

  // Looking at a session is what reads it: the one on screen, in a window
  // that has focus. Either changing is a look.
  $effect(() => {
    const key = sessions.active;
    if (attention.focused && key !== null) viewed(key);
  });

  // The platform's own window controls sit on the leftmost header's text,
  // and a look sets how tall that header is: measured once the look has
  // painted, and again whenever it changes.
  $effect(() => {
    theme.look;
    const frame = requestAnimationFrame(() => {
      const header = document.querySelector("section[data-pane] header");
      if (header === null) return;
      const box = header.getBoundingClientRect();
      void core().controlsCentre(Math.round(box.top + box.height / 2));
    });
    return () => cancelAnimationFrame(frame);
  });

  // Coming back to the window is when what happened elsewhere is wanted:
  // the histories are read again.
  $effect(() => {
    if (attention.focused) refreshHistory();
  });

  $effect(() => {
    badge(unreadCount());
  });

  // The native layer takes a chord back from a browser tab's page on the
  // app's behalf, so it needs the table again whenever a binding changes.
  $effect(() => {
    void core().browserKeys(Object.values(keys.bindings));
  });

  let reviewing = $derived(layout.mode === "reviewing");

  // Until the window has drawn a couple of frames the sessions column is
  // simply where it belongs: the saved layout and the window's width both
  // arrive then, and neither is a toggle to watch.
  let settled = false;
  $effect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => (settled = true));
    });
    return () => cancelAnimationFrame(frame);
  });

  /** How long the columns take to reach new widths: the whole motion for a
      toggle or a change of shape, nothing for a window too narrow for a pane
      or a splitter being dragged. */
  function easing(moved: boolean) {
    return settled && moved && !reduced() ? PANE_MOTION : 0;
  }

  // The sessions column eases between folded and open when the pane is
  // toggled or the shape changes, and the panes beside it take and give back
  // the room as it goes. The pane keeps its own width the whole way and the
  // column cuts it off, so no row moves.
  let sessionsWasChosen = untrack(() => layout.sessionsChosen);
  let sessionsWasMode = untrack(() => layout.mode);
  $effect.pre(() => {
    const shown = sessionsVisible();
    const chosen = layout.sessionsChosen;
    const mode = layout.mode;
    untrack(() => {
      const moved = chosen !== sessionsWasChosen || mode !== sessionsWasMode;
      sessionsWasChosen = chosen;
      sessionsWasMode = mode;
      void sessionsOpen.set(shown ? 1 : 0, { duration: easing(moved), easing: cubicOut });
    });
  });

  // The changes column eases between its working and reviewing widths on the
  // same curve as the sessions column, so the agent between them moves
  // steadily from its old width to its new one and never below either.
  let changesWasMode = untrack(() => layout.mode);
  $effect.pre(() => {
    const width = changesWidth();
    const mode = layout.mode;
    untrack(() => {
      const moved = mode !== changesWasMode;
      changesWasMode = mode;
      void changesSpan.set(width, { duration: easing(moved), easing: cubicOut });
    });
  });

  /** The sessions column's width, folded or open or on its way, the splitter
      beside it included. */
  let sessionsColumn = $derived(
    `calc(${FOLDED + (layout.sessions - FOLDED) * sessionsOpen.current}px + var(--splitter-w))`,
  );

  // The folded pane's header runs on into the header beside it, so the line
  // down the column's edge starts under the header row.
  let sessionsHead = $state(0);
  $effect(() => {
    const header = document.querySelector("section[data-pane='sessions'] > header");
    if (header === null) return;
    const observer = new ResizeObserver(() => (sessionsHead = (header as HTMLElement).offsetHeight));
    observer.observe(header);
    return () => observer.disconnect();
  });

  // The terminal panel eases up and down, and the panes above it give up
  // and take back the height as it goes. The shells in it are never
  // unmounted, so it is out of the layout only once it is all the way down.
  let terminalWasShown = untrack(() => terminalVisible());
  $effect.pre(() => {
    const shown = terminalVisible();
    untrack(() => {
      const moved = shown !== terminalWasShown;
      terminalWasShown = shown;
      void terminalOpen.set(shown ? 1 : 0, { duration: easing(moved), easing: cubicOut });
    });
  });

  let columns = $derived.by(() => {
    const cols: string[] = [];
    // The sessions pane and the splitter beside it share one column, folded
    // or open, and move together as it eases between the two.
    cols.push(sessionsColumn);
    if (agentVisible()) cols.push("1fr");
    if (changesVisible()) {
      if (agentVisible()) cols.push("var(--splitter-w)");
      // With the agent hidden the viewer is the only pane, so it takes the room
      // rather than holding a fixed width against empty space.
      cols.push(
        agentVisible() ? `${changesSpan.current}px` : "1fr",
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
        // Going to the sessions pane opens it out of its fold.
        if (action.pane === "sessions") unfoldSessions();
        focusPane(action.pane);
        break;
      case "toggle":
        if (action.pane === "sessions" && !sessionsVisible()) unfoldSessions();
        else togglePane(action.pane);
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

<div
  class="frame"
  style:--controls-inset="{CONTROLS_INSET}px"
  style:--sessions-col={sessionsColumn}
  style:--folded="{FOLDED}px"
>
  <div class="stack" bind:clientHeight={stack}>
  <main
    class="shell"
    style:grid-template-columns={columns}
    data-testid="shell"
    data-mode={layout.mode}
    bind:clientWidth={viewport}
  >
    <!-- The pane and its splitter in one slot, as wide as the column. What
         the pane holds keeps the pane's open width, so a column narrower
         than that cuts it off at the right and no row moves. Folded, the
         splitter gives way to a plain edge: there is nothing to drag. -->
    <div
      class="sessions-slot"
      class:folded={!sessionsVisible()}
      style:--sessions-w="{layout.sessions}px"
      style:--head-h="{sessionsHead}px"
    >
      <SessionsPane />
      {#if sessionsVisible()}
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
      {:else}
        <div class="fold-edge" aria-hidden="true"></div>
      {/if}
    </div>

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
       shells in it stay mounted, so hiding is free and showing is a fit. The
       panel and the bar above it go and come back together, in a group as
       tall as the share of them that is up; the panel keeps its own height
       inside, so it slides rather than squeezes. -->
  <div
    class="terminal-group"
    class:hidden={!terminalVisible() && terminalOpen.current === 0}
    style:height="calc({layout.terminal * terminalOpen.current}px + var(--splitter-w) * {terminalOpen.current})"
  >
    {#if terminalVisible() || terminalOpen.current > 0}
      <Splitter
        label="Resize the terminal"
        orientation="horizontal"
        onDelta={resizeTerminal}
        onReset={resetTerminal}
        onCommit={saveLayout}
      />
    {/if}
    <div class="terminal-slot" style:height="{layout.terminal}px" data-testid="terminal-slot">
      <TerminalPanel />
    </div>
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
{#if conductor.asking !== null}
  <ConductAsk />
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

  /* The bar and the panel, one thing to show and to hide, cut off at the
     window's foot while they are on their way. */
  .terminal-group {
    display: flex;
    flex-direction: column;
    flex: none;
    overflow: hidden;
  }

  .terminal-group.hidden {
    display: none;
  }

  .terminal-slot {
    display: flex;
    flex: none;
    min-height: 0;
  }

  .terminal-slot :global(.pane) {
    flex: 1;
    min-width: 0;
  }

  /* The pane and the splitter beside it, in the width of one column. */
  .sessions-slot {
    display: flex;
    min-width: 0;
    min-height: 0;
  }

  .sessions-slot :global(.pane) {
    flex: 1;
    min-width: 0;
  }

  /* What the pane holds keeps the open width, and the pane cuts it off
     without ever scrolling to what is past the cut. */
  .sessions-slot :global([data-pane="sessions"] > .body) {
    overflow: clip;
  }

  .sessions-slot :global([data-pane="sessions"] > .body > :not([data-testid="unfold-sessions"])) {
    min-width: calc(var(--sessions-w) - 2px);
  }

  /* Folded, the header is part of the row the header beside it starts: the
     same ground, and nothing in it. */
  .sessions-slot.folded :global([data-pane="sessions"] > header) {
    background: var(--surface);
  }

  .sessions-slot.folded :global([data-pane="sessions"] > header > *) {
    visibility: hidden;
  }

  /* The splitter's line with nothing to drag, from under the header row. */
  .fold-edge {
    position: relative;
    flex: none;
    width: var(--splitter-w);
    background: linear-gradient(var(--surface) var(--head-h), transparent var(--head-h));
  }

  .fold-edge::after {
    content: "";
    position: absolute;
    top: var(--head-h);
    bottom: 0;
    left: calc(50% - 0.5px);
    width: 1px;
    background: var(--splitter);
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
    border-top: 1px solid var(--status-rule);
    background: var(--status-bg);
    font-family: var(--chrome);
    font-size: var(--status-size);
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
