<script lang="ts">
  import { hook } from "$lib/hook.svelte";
  import { dismissHooksNotice, hooksNoticeDue, retireHooksNotice } from "$lib/notice.svelte";
  import { openSettings } from "$lib/settings.svelte";

  let due = $derived(hooksNoticeDue());

  // Hooks turned on while the notice was up, from the settings it opened or
  // anywhere else, is the notice taken.
  let shown = false;
  $effect(() => {
    if (due) shown = true;
  });
  $effect(() => {
    if (hook.everywhere && shown) retireHooksNotice();
  });
</script>

{#if due}
  <div class="notice" role="status" data-testid="hooks-notice">
    <p class="title">Let the agent talk to the workbench</p>
    <p class="text">
      Agent hooks tell the workbench when the agent works, waits or asks, and let it point at code
      and show you images and documents.
    </p>
    <div class="actions">
      <button class="go" onclick={() => openSettings("hooks")} data-testid="hooks-notice-settings"
        >Open settings</button
      >
      <button class="later" onclick={dismissHooksNotice} data-testid="hooks-notice-dismiss"
        >Not now</button
      >
    </div>
  </div>
{/if}

<style>
  /* Over the top of the terminal, where old output is, so the prompt at
     the bottom stays clear. */
  .notice {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 2;
    width: min(360px, calc(100% - 24px));
    padding: 10px 12px 12px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--ink);
  }

  .title {
    margin: 0 0 4px;
    font-family: var(--chrome);
    font-size: 10.5px;
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--accent);
  }

  .text {
    margin: 0 0 10px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .actions button {
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    border-radius: var(--radius);
    padding: 4px 12px;
    cursor: pointer;
  }

  .go {
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .later {
    border: 1px solid var(--rule);
    background: none;
    color: var(--ink-3);
  }

  .later:hover {
    color: var(--ink);
  }
</style>
