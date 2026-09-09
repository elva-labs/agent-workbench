<script lang="ts">
  import { load, type Loaded, type MediaItem } from "$lib/media.svelte";
  import { core } from "$lib/core";
  import { fences, renderDiagram } from "$lib/mermaid";
  import { lastSegment } from "$lib/paths";
  import MediaPage from "$lib/components/MediaPage.svelte";

  /**
   * What one `present` call brought, down the viewer: each file under its
   * name, an image at width, a PDF in its own frame, a document rendered,
   * a page in a frame of its own, a diagram drawn.
   */

  interface Props {
    item: MediaItem;
  }

  let { item }: Props = $props();

  /** What each file loaded as, by path. */
  let loaded = $state<Record<string, Loaded>>({});

  /** Diagrams drawn, by path: the SVG, or why not. */
  let drawn = $state<Record<string, { svg: string } | { error: string }>>({});

  $effect(() => {
    for (const file of item.files) {
      if (file in loaded) continue;
      loaded[file] = { error: "" };
      void load(file).then((result) => {
        loaded[file] = result;
        if ("diagram" in result) {
          void renderDiagram(result.diagram).then((picture) => {
            drawn[file] = picture;
          });
        }
      });
    }
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

<div class="stack" data-testid="media-stack">
  {#each item.files as file (file)}
    {@const current = loaded[file] ?? null}
    <section class="file" data-testid="media-file">
      <h3 title={file}>{lastSegment(file)}</h3>
      {#if current === null || ("error" in current && current.error === "")}
        <p class="empty">Reading…</p>
      {:else if "error" in current}
        <p class="empty" data-testid="media-error">{current.error}</p>
      {:else if "html" in current}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="document" onclick={onDocumentClick} use:fences={current.html} data-testid="media-document">
          {@html current.html}
        </div>
      {:else if "page" in current}
        <MediaPage html={current.page} title={lastSegment(file)} />
      {:else if "diagram" in current}
        {@const picture = drawn[file] ?? null}
        {#if picture === null}
          <p class="empty">Drawing…</p>
        {:else if "error" in picture}
          <p class="empty" data-testid="media-error">{picture.error}</p>
        {:else}
          <figure class="diagram" data-testid="media-diagram">{@html picture.svg}</figure>
        {/if}
      {:else if current.mime === "application/pdf"}
        <embed src={current.url} type="application/pdf" title={lastSegment(file)} />
      {:else}
        <img src={current.url} alt={item.caption ?? lastSegment(file)} />
      {/if}
    </section>
  {/each}
</div>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 12px 16px 24px;
  }

  .file {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 500;
    color: var(--ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  img {
    max-width: 100%;
    height: auto;
    border: 1px solid var(--rule);
    background: var(--bg);
  }

  embed {
    width: 100%;
    height: 70vh;
    border: 1px solid var(--rule);
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
