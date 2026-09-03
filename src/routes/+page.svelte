<script lang="ts">
  import { untrack } from "svelte";
  import Splitter from "$lib/components/Splitter.svelte";
  import SessionsPane from "$lib/panes/SessionsPane.svelte";
  import AgentPane from "$lib/panes/AgentPane.svelte";
  import ChangesPane from "$lib/panes/ChangesPane.svelte";
  import { BINDINGS, resolveAction } from "$lib/keymap";
  import { cycleTheme, theme } from "$lib/theme.svelte";
  import { files, toggleScope, toggleView } from "$lib/files.svelte";
  import {
    DEFAULT,
    MIN,
    agentVisible,
    applyLayout,
    changesVisible,
    enterReview,
    exitReview,
    focusPane,
    layout,
    saveLayout,
    sessionsVisible,
    togglePane,
  } from "$lib/layout.svelte";

  let viewport = $state(1200);

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
      layout.review = Math.max(MIN.review, layout.review - dx);
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
        if (reviewing) exitReview();
        else {
          if (files.selected === null) files.selected = "src/cache/mod.rs";
          enterReview();
        }
        break;
      case "toggleView":
        toggleView();
        break;
      case "toggleScope":
        toggleScope();
        break;
      case "exitReview":
        exitReview();
        break;
    }
  }

  // Clamp against the grid's own content box rather than the window: the frame
  // has padding, and counting it as usable width is how the agent pane ends up
  // below its minimum on a small display.
  $effect(() => {
    const width = viewport;
    untrack(() => applyLayout(width));
  });
</script>

<svelte:window on:keydown={onKeydown} />

<div class="frame">
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
</div>

<footer class="status no-select">
  <span class="focus" data-testid="focus-readout">focus: {layout.focus}</span>
  <span class="mode" data-testid="mode-readout">{layout.mode}</span>
  <span class="spacer"></span>
  {#each BINDINGS as binding (binding.keys)}
    <span class="binding" class:minor={binding.minor}>
      <kbd>{binding.keys}</kbd>{binding.does}
    </span>
  {/each}
  <span class="binding minor"><kbd>theme</kbd>{theme.choice}</span>
</footer>

<style>
  .frame {
    height: calc(100vh - 26px);
    padding: 8px;
    background: var(--bg);
  }

  /* No padding here: clientWidth is then exactly the width the panes divide up. */
  .shell {
    display: grid;
    gap: 0;
    height: 100%;
    align-items: stretch;
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

  .spacer {
    flex: 1;
  }

  .binding {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  kbd {
    font-family: inherit;
    color: var(--ink-2);
  }

  /* The status bar is the first thing to lose room; drop the least useful
     reminders rather than letting the row clip mid-word. */
  @media (max-width: 1100px) {
    .binding.minor {
      display: none;
    }
  }
</style>
