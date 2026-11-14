<script lang="ts">
  import { revealed } from "$lib/thread";

  /** Text the agent chose, drawn so it reads as it is: every character
      that would change how it reads without being seen, a control, a mark
      that reorders text or one of no width, shows as a marker. */
  interface Props {
    text: string;
  }

  let { text }: Props = $props();

  let parts = $derived(revealed(text));
</script>

{#each parts as part, at (at)}{#if part.unseen}<span class="unseen" data-testid="unseen-character"
      >{part.text}</span
    >{:else}{part.text}{/if}{/each}

<style>
  .unseen {
    padding: 0 2px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--del) 16%, transparent);
    color: var(--del);
    font-family: var(--mono);
  }
</style>
