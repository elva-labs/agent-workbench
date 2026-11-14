<script lang="ts">
  /**
   * The editor's column in editor mode, beside the tree: the editor, or in
   * its place what the agent presented, a plugin's page or the browser, the
   * way the viewer shows them in agent mode.
   */
  import BrowserView from "$lib/components/BrowserView.svelte";
  import FileViewer from "$lib/components/FileViewer.svelte";
  import { browser } from "$lib/browser.svelte";
  import { otherKindShown } from "$lib/editor.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";
</script>

<div class="column" data-testid="editor-column">
  {#if otherKindShown()}
    {#if browser.showing}
      <BrowserView />
    {:else}
      <FileViewer />
    {/if}
  {:else}
    <div class="empty" data-testid="editor-empty">
      <b>No file open</b>
      <span>Pick one in the tree, or start a new one with <kbd>{describe(chordFor("file.new"))}</kbd></span>
    </div>
  {/if}
</div>

<style>
  .column {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }

  .empty {
    flex: 1;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 6px;
    padding: 24px;
    font-family: var(--chrome);
    font-size: 12.5px;
    color: var(--ink-3);
    text-align: center;
  }

  .empty b {
    font-weight: 600;
    color: var(--ink-2);
  }

  kbd {
    font-family: var(--chrome);
    font-size: 11px;
    color: var(--ink-3);
    border: 1px solid var(--rule-strong);
    border-radius: 4px;
    padding: 0 4px;
  }
</style>
