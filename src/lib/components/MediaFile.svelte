<script lang="ts">
  import { untrack } from "svelte";
  import { load, type Loaded } from "$lib/media.svelte";
  import { core } from "$lib/core";
  import { fences, renderDiagram } from "$lib/mermaid";
  import MediaPage from "$lib/components/MediaPage.svelte";

  /**
   * One file rendered for the viewer, read where it is: an image at width,
   * a PDF in its own frame, a document rendered, a page in a frame of its
   * own, a diagram drawn. The file is read again whenever `reload` changes,
   * and what is shown is replaced only when the file differs, so an edit
   * shows as it is now and an unchanged image stays still.
   */

  interface Props {
    /** The file, absolute, on the machine the project is on. */
    path: string;
    /** What an image is called when it cannot be shown. */
    alt: string;
    /** Changes when the file may have: a later call for it, or the
        working tree moving under it. */
    reload?: string;
  }

  let { path, alt, reload = "" }: Props = $props();

  let loaded = $state<Loaded | null>(null);

  /** The diagram drawn, when the file is one: the SVG, or why not. */
  let drawn = $state<{ svg: string } | { error: string } | null>(null);

  /** Which read is the current one: a slow read of an earlier state must
      not land over a newer one. */
  let read = 0;

  $effect(() => {
    const file = path;
    reload;
    const current = ++read;
    void load(file).then((result) => {
      if (current !== read) return;
      const before = untrack(() => loaded);
      if (before !== null && JSON.stringify(before) === JSON.stringify(result)) return;
      loaded = result;
      drawn = null;
      if ("diagram" in result) {
        void renderDiagram(result.diagram).then((picture) => {
          if (current !== read) return;
          drawn = picture;
        });
      }
    });
  });

  /** A link in a rendered document opens outside, never in this window. */
  function onDocumentClick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement | null)?.closest("a");
    if (anchor === null || anchor === undefined) return;
    e.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//.test(href)) core().openUrl(href).catch(() => {});
  }
</script>

{#if loaded === null}
  <p class="empty">Reading…</p>
{:else if "error" in loaded}
  <p class="empty" data-testid="media-error">{loaded.error}</p>
{:else if "html" in loaded}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="document" onclick={onDocumentClick} use:fences={loaded.html} data-testid="media-document">
    {@html loaded.html}
  </div>
{:else if "page" in loaded}
  <MediaPage html={loaded.page} title={alt} />
{:else if "diagram" in loaded}
  {#if drawn === null}
    <p class="empty">Drawing…</p>
  {:else if "error" in drawn}
    <p class="empty" data-testid="media-error">{drawn.error}</p>
  {:else}
    <figure class="diagram" data-testid="media-diagram">{@html drawn.svg}</figure>
  {/if}
{:else if loaded.mime === "application/pdf"}
  <embed src={loaded.url} type="application/pdf" title={alt} />
{:else}
  <img src={loaded.url} {alt} />
{/if}

<style>
  img {
    max-width: 100%;
    height: auto;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--bg);
  }

  embed {
    width: 100%;
    height: 70vh;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
  }

  .empty {
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-3);
  }

  .document {
    max-width: 78ch;
    padding: 4px 0;
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .document :global(h1),
  .document :global(h2),
  .document :global(h3),
  .document :global(h4) {
    line-height: 1.25;
    margin: 1.2em 0 0.5em;
    font-family: inherit;
    font-size: 1.15em;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink);
    white-space: normal;
  }

  .document :global(h1) {
    font-size: 1.5em;
    margin-top: 0.2em;
  }

  .document :global(h2) {
    font-size: 1.25em;
  }

  .document :global(p),
  .document :global(ul),
  .document :global(ol),
  .document :global(blockquote),
  .document :global(table) {
    margin: 0 0 0.9em;
  }

  .document :global(pre),
  .document :global(code) {
    font-family: var(--mono);
    font-size: 12px;
  }

  .document :global(pre) {
    padding: 10px 12px;
    background: var(--surface-2);
    border: 1px solid var(--rule);
    overflow-x: auto;
    margin: 0 0 0.9em;
  }

  .document :global(code) {
    background: var(--surface-2);
    padding: 1px 4px;
  }

  .document :global(pre code) {
    background: none;
    padding: 0;
  }

  .document :global(blockquote) {
    border-left: 3px solid var(--rule-strong);
    padding-left: 12px;
    color: var(--ink-2);
  }

  .document :global(table) {
    border-collapse: collapse;
  }

  .document :global(th),
  .document :global(td) {
    border: 1px solid var(--rule);
    padding: 4px 8px;
    text-align: left;
  }

  .document :global(a) {
    color: var(--accent);
  }

  .document :global(img) {
    max-width: 100%;
  }

  .diagram,
  .document :global(figure.diagram) {
    margin: 0;
    overflow: auto;
  }

  .diagram :global(svg),
  .document :global(figure.diagram svg) {
    max-width: 100%;
    height: auto;
  }
</style>
