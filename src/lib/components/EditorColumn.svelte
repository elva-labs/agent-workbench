<script lang="ts">
  /**
   * The editor's column in editor mode, beside the tree: the file in front,
   * to edit or as the viewer shows it, with the line and column, what it is
   * written in and whether it is saved at the foot. In its place goes what
   * the agent presented, a plugin's page or the browser, the way the viewer
   * shows them in agent mode. A file that cannot be edited as text says why
   * and is shown as the viewer shows it.
   */
  import BrowserView from "$lib/components/BrowserView.svelte";
  import CodeEditor from "$lib/components/CodeEditor.svelte";
  import FileViewer from "$lib/components/FileViewer.svelte";
  import { browser } from "$lib/browser.svelte";
  import { languageOf } from "$lib/codeEditor";
  import {
    activeBuffer,
    activeTab,
    editor,
    otherKindShown,
    putAwayOther,
  } from "$lib/editor.svelte";
  import { selectedEntry } from "$lib/files.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";

  let tab = $derived(activeTab());
  let buffer = $derived(activeBuffer());
  let entry = $derived(selectedEntry());
  let editable = $derived(
    tab !== null && buffer !== null && !buffer.loading && buffer.error === null && tab.view === "edit",
  );
</script>

<div class="column" data-testid="editor-column">
  {#if otherKindShown()}
    {#if browser.showing}
      <BrowserView />
    {:else}
      <FileViewer onClose={putAwayOther} />
    {/if}
  {:else if tab === null || buffer === null}
    <div class="empty" data-testid="editor-empty">
      <b>No file open</b>
      <span>Pick one in the tree, or start a new one with <kbd>{describe(chordFor("file.new"))}</kbd></span>
    </div>
  {:else}
    {#if tab.note}
      <p class="note" data-testid="editor-note">{tab.note}</p>
    {/if}
    {#if buffer.error !== null}
      <p class="reason" data-testid="editor-reason">{buffer.error}. Shown as the viewer shows it.</p>
    {/if}
    <div class="body">
      {#if editable}
        <CodeEditor buffer={editor.active!} />
      {:else if buffer.loading}
        <p class="wait">Reading…</p>
      {:else}
        <FileViewer bare />
      {/if}
    </div>
    <footer class="foot" data-testid="editor-foot">
      {#if editable}
        <span class="num" data-testid="editor-position">Ln {editor.cursor.line}, Col {editor.cursor.col}</span>
        <span>{languageOf(tab.path)}</span>
        <span class="end" data-testid="editor-state">
          {#if buffer.dirty}
            Unsaved <kbd>{describe(chordFor("file.save"))}</kbd>
          {:else}
            Saved
          {/if}
        </span>
      {:else if buffer.error !== null}
        <span>Read only</span>
      {:else if tab.view === "diff"}
        <span>Against HEAD, read only</span>
        {#if entry !== null}
          <span class="end num">
            {#if entry.add}<span class="add">+{entry.add}</span>{/if}
            {#if entry.del}<span class="del">−{entry.del}</span>{/if}
          </span>
        {/if}
      {:else}
        <span>Rendered, read only</span>
      {/if}
    </footer>
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

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .body > :global(.viewer) {
    flex: 1;
    min-height: 0;
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
    font-size: 10.5px;
    color: var(--ink-3);
    border: 1px solid var(--rule-strong);
    border-radius: 4px;
    padding: 0 4px;
    line-height: 15px;
  }

  .note,
  .reason {
    flex: none;
    margin: 0;
    padding: 8px var(--pane-pad);
    font-size: 12.5px;
    line-height: 1.5;
    border-bottom: 1px solid var(--head-rule);
  }

  .note {
    color: var(--ink);
    background: var(--accent-soft);
  }

  .reason {
    color: var(--ink-2);
    background: var(--surface-2);
  }

  .wait {
    margin: 0;
    padding: 16px var(--pane-pad);
    font-size: 13px;
    color: var(--ink-3);
  }

  .foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    height: 26px;
    padding: 0 var(--pane-pad);
    border-top: 1px solid var(--head-rule);
    font-family: var(--chrome);
    font-size: var(--status-size);
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
  }

  .end {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .num {
    font-variant-numeric: tabular-nums;
  }

  .add {
    color: var(--add);
  }

  .del {
    color: var(--del);
  }
</style>
