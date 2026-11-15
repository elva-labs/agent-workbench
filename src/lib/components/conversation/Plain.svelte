<script lang="ts">
  import { revealed } from "$lib/thread";

  /** Text the agent, a tool or a server chose, drawn so it reads as it is:
      every character that would change how it reads without being seen
      shows as a marker, and the text is set apart left to right, so
      nothing in it reorders the words around it. */
  interface Props {
    text: string;
  }

  let { text }: Props = $props();

  let parts = $derived(revealed(text));
</script>

<span class="plain">{#each parts as part, at (at)}{#if part.unseen}<span class="unseen" data-testid="unseen-character"
      >{part.text}</span
    >{:else}{part.text}{/if}{/each}</span>

<style>
  .plain {
    unicode-bidi: isolate;
    direction: ltr;
  }

  .unseen {
    padding: 0 2px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--del) 16%, transparent);
    color: var(--del);
    font-family: var(--mono);
  }
</style>
