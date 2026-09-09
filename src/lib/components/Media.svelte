<script lang="ts">
  import { onMount } from "svelte";
  import { closeMedia, load, media, step } from "$lib/media.svelte";
  import { lastSegment } from "$lib/paths";

  /**
   * What the agent presented, over the workbench: the file on screen with
   * its caption, and every file of the item as a small preview beneath, the
   * one on screen marked. Left and Right step, a click on a preview jumps,
   * Escape closes.
   */

  let dialog = $state<HTMLDivElement | null>(null);

  let item = $derived(media.open?.item ?? null);
  let index = $derived(media.open?.index ?? 0);
  let path = $derived(item?.files[index] ?? null);

  /** Data URLs by path, as they are read. */
  let loaded = $state<Record<string, { url: string; mime: string } | { error: string }>>({});

  onMount(() => dialog?.focus());

  // Every file of the item is read once it is open, the one on screen
  // first, so the previews fill in and stepping shows nothing loading.
  $effect(() => {
    if (item === null) return;
    const order = [...item.files.slice(index), ...item.files.slice(0, index)];
    for (const file of order) {
      if (file in loaded) continue;
      loaded[file] = { error: "" };
      void load(file).then((result) => {
        loaded[file] = result;
      });
    }
  });

  let current = $derived(path === null ? null : (loaded[path] ?? null));

  function onKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case "Escape":
        closeMedia();
        break;
      case "ArrowRight":
        step(1);
        break;
      case "ArrowLeft":
        step(-1);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
</script>

{#if item !== null && path !== null}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={closeMedia} data-testid="media-scrim">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={item.caption ?? lastSegment(path)}
      tabindex="-1"
      bind:this={dialog}
      onclick={(e) => e.stopPropagation()}
      onkeydown={onKeydown}
      data-testid="media"
    >
      <header>
        <h2 title={path}>
          {lastSegment(path)}
          {#if item.files.length > 1}
            <span class="count" data-testid="media-count">{index + 1} of {item.files.length}</span>
          {/if}
        </h2>
        <button class="tool" onclick={closeMedia} data-testid="media-close">Esc</button>
      </header>
      {#if item.caption}
        <p class="caption" data-testid="media-caption">{item.caption}</p>
      {/if}
      <div class="stage" data-testid="media-stage">
        {#if current === null || ("error" in current && current.error === "")}
          <p class="empty">Reading…</p>
        {:else if "error" in current}
          <p class="empty" data-testid="media-error">{current.error}</p>
        {:else if current.mime === "application/pdf"}
          <embed src={current.url} type="application/pdf" title={lastSegment(path)} />
        {:else}
          <img src={current.url} alt={item.caption ?? lastSegment(path)} />
        {/if}
      </div>
      {#if item.files.length > 1}
        <div class="strip" role="listbox" aria-label="Files" data-testid="media-strip">
          {#each item.files as file, i (file)}
            {@const preview = loaded[file] ?? null}
            <button
              class="preview"
              class:on={i === index}
              role="option"
              aria-selected={i === index}
              title={file}
              onclick={() => (media.open = { item: item!, index: i })}
              data-testid="media-preview"
            >
              {#if preview !== null && "url" in preview && preview.mime !== "application/pdf"}
                <img src={preview.url} alt="" />
              {:else}
                <span class="name">{lastSegment(file)}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .dialog {
    width: min(1100px, calc(100vw - 48px));
    max-height: calc(100vh - 48px);
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
    gap: 12px;
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

  .count {
    margin-left: 10px;
    color: var(--ink-3);
    text-transform: none;
    letter-spacing: 0.04em;
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

  .caption {
    margin: 0;
    padding: 8px var(--pane-pad);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink);
    background: var(--accent-soft);
    border-bottom: 1px solid var(--rule);
    flex: none;
  }

  .stage {
    flex: 1;
    min-height: 240px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    background: var(--bg);
  }

  .stage img {
    max-width: 100%;
    max-height: calc(100vh - 220px);
    object-fit: contain;
  }

  .stage embed {
    width: 100%;
    height: calc(100vh - 220px);
  }

  .empty {
    margin: 0;
    padding: 24px;
    font-size: 12.5px;
    color: var(--ink-3);
  }

  .strip {
    display: flex;
    gap: 8px;
    padding: 10px var(--pane-pad);
    border-top: 1px solid var(--rule);
    overflow-x: auto;
    flex: none;
  }

  .preview {
    flex: none;
    width: 96px;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid var(--rule);
    background: var(--bg);
    cursor: pointer;
    overflow: hidden;
  }

  .preview.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .preview .name {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-3);
    padding: 0 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
</style>
