<script lang="ts">
  import Plain from "./Plain.svelte";
  import { agentLabel } from "$lib/agent.svelte";
  import { focusPane } from "$lib/layout.svelte";
  import { modelLabel } from "$lib/models";
  import { isLive, label, sessions, statusLabel, type Session } from "$lib/sessions.svelte";
  import { goTo } from "$lib/workspace.svelte";

  /** The sessions a run started with the workbench's start tool, one row
      each: how it stands, its name, its model, and the way to it. */
  interface Props {
    ids: string[];
  }

  let { ids }: Props = $props();

  let rows = $derived(
    ids
      .map((id) => sessions.all.find((session) => session.id === id))
      .filter((session): session is Session => session !== undefined),
  );

  function open(session: Session) {
    if (goTo(session.key)) focusPane("agent");
  }
</script>

{#if rows.length > 0}
  <div class="card" data-testid="started-sessions">
    {#each rows as session (session.key)}
      <div class="row" data-testid="started-session">
        <span
          class="dot"
          class:live={isLive(session)}
          class:working={session.working}
          class:asking={session.needs === "permission"}
          class:dormant={session.status === "dormant"}
          title={statusLabel(session)}
        ></span>
        <span class="name"><Plain text={label(session)} /></span>
        <span class="state" class:asking={session.needs === "permission"}>
          {session.needs === "permission" ? "asking" : statusLabel(session)}
        </span>
        <span class="model"><Plain text={session.model !== null ? modelLabel(session.agent, session.model) : agentLabel(session.agent)} /></span>
        <button class="open" tabindex="-1" data-thread-item onclick={() => open(session)} data-testid="open-started">Open</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .card {
    border: 1px solid var(--divider, var(--rule));
    border-radius: calc(var(--radius) + 3px);
    overflow: hidden;
    background: var(--surface);
  }

  .row {
    display: grid;
    grid-template-columns: 17px minmax(0, 1fr) auto auto auto;
    align-items: center;
    column-gap: 10px;
    padding: 5px 6px 5px 12px;
    font-size: var(--conv-small);
  }

  .row + .row {
    border-top: 1px solid var(--divider, var(--rule));
  }

  .dot {
    width: var(--dot);
    height: var(--dot);
    border-radius: 50%;
    background: var(--ink-3);
    opacity: 0.6;
  }

  .dot.live {
    background: var(--add);
    opacity: 1;
  }

  .dot.working {
    animation: breathe 1.6s ease-in-out infinite;
  }

  .dot.asking {
    background: none;
    box-shadow: inset 0 0 0 1.75px var(--accent);
    animation: none;
  }

  .dot.dormant {
    background: var(--dormant);
    opacity: 1;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink);
  }

  .state,
  .model {
    font-size: var(--conv-meta);
    color: var(--ink-2);
    white-space: nowrap;
  }

  .state.asking {
    color: var(--accent);
  }

  .open {
    padding: 2px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    font-size: var(--conv-meta);
    color: var(--accent);
    cursor: pointer;
  }

  .open:hover {
    background: var(--accent-soft);
  }

  @keyframes breathe {
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot.working {
      animation: none;
    }
  }
</style>
