<script lang="ts">
  import { core } from "$lib/core";
  import { render } from "$lib/media.svelte";

  /**
   * What the agent wrote, as a reader sees it: the same Markdown the viewer
   * renders for a presented document, links opening outside the window.
   * While it streams it is drawn again at most once a frame, and a caret
   * stands where the next words will come, so the text grows in place.
   */
  interface Props {
    text: string;
    streaming?: boolean;
  }

  let { text, streaming = false }: Props = $props();

  let shown = $state("");
  let frame: number | null = null;

  $effect(() => {
    const next = text;
    if (!streaming || shown === "") {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      shown = next;
      return;
    }
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      shown = text;
    });
  });

  $effect(() => () => {
    if (frame !== null) cancelAnimationFrame(frame);
  });

  let html = $derived(render(shown));

  function onclick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement | null)?.closest("a");
    if (anchor === null || anchor === undefined) return;
    e.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//.test(href)) core().openUrl(href).catch(() => {});
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="md" class:streaming {onclick} data-testid="markdown">{@html html}</div>

<style>
  .md {
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
    cursor: text;
  }

  .md > :global(:first-child) {
    margin-top: 0;
  }

  .md > :global(:last-child) {
    margin-bottom: 0;
  }

  .md :global(p),
  .md :global(ul),
  .md :global(ol),
  .md :global(blockquote),
  .md :global(table),
  .md :global(pre) {
    margin: 0 0 0.7em;
  }

  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.4em;
  }

  .md :global(li + li) {
    margin-top: 0.2em;
  }

  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: 1em 0 0.4em;
    font-size: 1.05em;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink);
  }

  .md :global(h1) {
    font-size: 1.2em;
  }

  .md :global(code) {
    font-family: var(--mono);
    font-size: 0.89em;
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }

  .md :global(pre) {
    padding: 10px 12px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--surface-2);
    overflow-x: auto;
    line-height: 1.5;
  }

  .md :global(pre code) {
    padding: 0;
    background: none;
    font-size: 12px;
    white-space: pre;
  }

  .md :global(blockquote) {
    padding-left: 12px;
    border-left: 3px solid var(--rule-strong);
    color: var(--ink-2);
  }

  /* A table lays its columns out by their words, and one wider than the
     thread scrolls sideways on its own. */
  .md :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    overflow-wrap: normal;
    font-size: 0.95em;
  }

  .md :global(th),
  .md :global(td) {
    padding: 4px 10px;
    border: 1px solid var(--rule);
    text-align: left;
    vertical-align: top;
  }

  .md :global(th) {
    background: var(--surface-2);
    font-weight: 600;
  }

  .md :global(a) {
    color: var(--accent);
  }

  .md :global(img) {
    max-width: 100%;
  }

  .md :global(hr) {
    border: 0;
    border-top: 1px solid var(--rule);
    margin: 1em 0;
  }

  /* Where the next words will come. Inside the last paragraph or line
     while there is one, so the text does not move when it arrives. */
  .streaming > :global(:last-child:not(ul):not(ol):not(table):not(pre))::after,
  .streaming > :global(:is(ul, ol):last-child > li:last-child)::after {
    content: "";
    display: inline-block;
    width: 0.5em;
    height: 1em;
    margin-left: 2px;
    vertical-align: -0.15em;
    border-radius: 2px;
    background: var(--accent);
    animation: caret 1.1s ease-in-out infinite;
  }

  @keyframes caret {
    50% {
      opacity: 0.3;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .streaming > :global(*)::after {
      animation: none !important;
    }
  }
</style>
