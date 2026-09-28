<script lang="ts">
  import type { MediaItem } from "$lib/media.svelte";
  import { files as changes } from "$lib/files.svelte";
  import { lastSegment } from "$lib/paths";
  import MediaFile from "$lib/components/MediaFile.svelte";

  /**
   * What one item of the media list holds, down the viewer: each file
   * under its name, rendered. The files are read again when the agent
   * presents them again and when the working tree moves.
   */

  interface Props {
    item: MediaItem;
  }

  let { item }: Props = $props();
</script>

<div class="stack" data-testid="media-stack">
  {#each item.files as file (file)}
    <section class="file" data-testid="media-file">
      <h3 title={file}>{lastSegment(file)}</h3>
      <MediaFile
        path={file}
        alt={item.caption ?? lastSegment(file)}
        reload="{item.at}:{changes.treeReads}"
      />
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
    font-family: var(--chrome);
    font-size: 10.5px;
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    font-weight: 500;
    color: var(--ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
