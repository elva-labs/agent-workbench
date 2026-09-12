<script lang="ts">
  import { allow, conductor, once, refuse } from "$lib/conductor.svelte";

  let ask = $derived(conductor.asking);
</script>

{#if ask !== null}
  <div class="ask" role="alertdialog" aria-label="Start a session" data-testid="conduct-ask">
    <p class="title">{ask.caller} wants to start a session</p>
    <p class="where">
      In {ask.project}{ask.worktree ? ", in a worktree of its own" : ""}.
    </p>
    <p class="prompt">{ask.prompt}</p>
    <div class="actions">
      <button class="go" onclick={allow} data-testid="conduct-allow">Allow this session</button>
      <button class="later" onclick={once} data-testid="conduct-once">Once</button>
      <button class="later" onclick={refuse} data-testid="conduct-no">No</button>
    </div>
  </div>
{/if}

<style>
  /* Over the agent pane, near the top, where the question is read before
     the terminal under it. */
  .ask {
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    width: min(420px, calc(100vw - 48px));
    padding: 10px 12px 12px;
    border: 1px solid var(--accent);
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

  .where {
    margin: 0 0 8px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .prompt {
    margin: 0 0 10px;
    padding: 6px 8px;
    border-left: 2px solid var(--rule);
    background: var(--surface);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink);
    overflow-wrap: anywhere;
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
