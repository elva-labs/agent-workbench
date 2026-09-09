<script lang="ts">
  import { onMount } from "svelte";
  import { agentTag } from "$lib/agent.svelte";
  import { lastSegment } from "$lib/paths";
  import { returnFocus } from "$lib/layout.svelte";
  import { closeResume, offered, pickResume, resume } from "$lib/resume.svelte";
  import { ago, historyLabel } from "$lib/sessions.svelte";
  import { workspace } from "$lib/workspace.svelte";

  /**
   * The sessions to resume, over the workbench like the settings: a filter
   * with the keyboard in it, the sessions under it, Enter or a click on one
   * starts it, Escape closes.
   */

  let dialog: HTMLDivElement;
  let field = $state<HTMLInputElement | null>(null);
  let cursor = $state(0);

  // The keyboard is taken on the way in and handed back on the way out,
  // whichever way the dialog closed.
  onMount(() => {
    dialog.focus();
    field?.focus();
    return returnFocus;
  });

  let rows = $derived(offered());
  let project = $derived(workspace.open.find((open) => open.path === resume.project));
  let heading = $derived(
    `${rows.length} ${resume.agent === null ? "" : agentTag(resume.agent)} ${rows.length === 1 ? "session" : "sessions"} to resume`,
  );

  // The cursor stays within whatever the filter leaves.
  $effect(() => {
    if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);
  });

  function onKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        closeResume();
        return;
      case "ArrowDown":
        cursor = Math.min(cursor + 1, Math.max(0, rows.length - 1));
        break;
      case "ArrowUp":
        cursor = Math.max(cursor - 1, 0);
        break;
      case "Enter":
        if (rows[cursor] !== undefined) pickResume(rows[cursor]);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && !dialog.contains(e.target as Node)) closeResume();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={closeResume} data-testid="resume-scrim">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="resume-title"
    tabindex="-1"
    bind:this={dialog}
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    data-testid="resume"
  >
    <header>
      <h2 id="resume-title">{project?.name ?? ""}: {heading}</h2>
      <button class="tool" onclick={closeResume} data-testid="resume-close">Esc</button>
    </header>
    <div class="body">
      <input
        bind:this={field}
        bind:value={resume.query}
        placeholder="filter by name or worktree"
        autocomplete="off"
        spellcheck="false"
        aria-label="Filter"
        data-testid="resume-filter"
      />
      <div class="list" role="listbox" aria-label="Sessions to resume">
        {#each rows as entry, index (entry.id)}
          <button
            class="row"
            class:cursor={index === cursor}
            role="option"
            aria-selected={index === cursor}
            onclick={() => pickResume(entry)}
            title={entry.title ?? entry.id}
            data-testid="resume-row"
          >
            <span class="label">{historyLabel(entry)}</span>
            {#if entry.cwd}<span class="where" title={entry.cwd} data-testid="session-where">{lastSegment(entry.cwd)}</span>{/if}
            <span class="state">{ago(entry.modified)}</span>
          </button>
        {:else}
          <p class="note">Nothing matches.</p>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 8vh;
  }

  .dialog {
    width: min(560px, calc(100vw - 48px));
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--accent);
    box-shadow: 0 18px 48px color-mix(in srgb, black 35%, transparent);
    outline: none;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 9px var(--pane-pad);
    border-bottom: 1px solid var(--rule);
    flex: none;
  }

  h2 {
    margin: 0;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    font-weight: 500;
    color: var(--accent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool {
    border: 0;
    background: none;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px 6px;
  }

  .tool:hover {
    color: var(--accent);
  }

  .body {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 10px var(--pane-pad) 12px;
    gap: 8px;
  }

  input {
    font-family: var(--mono);
    font-size: 12.5px;
    padding: 5px 8px;
    border: 1px solid var(--rule);
    background: var(--bg);
    color: var(--ink);
    outline: none;
  }

  input:focus {
    border-color: var(--accent);
  }

  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--rule);
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    text-align: left;
    padding: 4px 10px;
    border: 0;
    border-bottom: 1px solid var(--rule);
    background: none;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink-2);
    cursor: pointer;
  }

  .row:last-child {
    border-bottom: 0;
  }

  .row:hover,
  .row.cursor {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .where {
    flex: none;
    max-width: 14ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--accent);
  }

  .state {
    flex: none;
    font-size: 10px;
    color: var(--ink-3);
  }

  .note {
    margin: 0;
    padding: 10px;
    font-size: 12px;
    color: var(--ink-3);
  }
</style>
