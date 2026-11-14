<script lang="ts">
  import { refusal, showRefusal } from "$lib/refusal.svelte";

  /** What the window shows after the refusal, when it is known. */
  let shown = $derived(
    refusal.shows === "stored"
      ? " The window shows what is stored."
      : refusal.shows === "last"
        ? " The window shows the last settings that could be read."
        : "",
  );
</script>

{#if refusal.reason !== null}
  <div class="refused" role="alert" data-testid="settings-refused">
    <p>{refusal.lead}: {refusal.reason}.{shown}</p>
    <button type="button" onclick={() => showRefusal(null)} data-testid="settings-refused-dismiss"
      >Dismiss</button
    >
  </div>
{/if}

<style>
  .refused {
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 40;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    width: min(560px, calc(100% - 24px));
    padding: 10px 12px;
    border: 1px solid var(--del);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--ink);
    font-size: 12.5px;
    line-height: 1.45;
  }

  p {
    flex: 1;
    margin: 0;
    overflow-wrap: anywhere;
  }

  button {
    flex: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    border-radius: var(--radius);
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-2);
    padding: 3px 8px;
  }
</style>
