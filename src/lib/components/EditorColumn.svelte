<script lang="ts">
  /**
   * The editor's column in editor mode, beside the tree: the file in front,
   * to edit or as the viewer shows it, with the line and column, what it is
   * written in and whether it is saved at the foot. In its place goes what
   * the agent presented, a plugin's page or the browser, the way the viewer
   * shows them in agent mode. A file that cannot be edited as text says why
   * and is shown as the viewer shows it.
   *
   * Over the editor go the questions before something is lost, and the bar
   * for a file that changed on disk under unsaved edits: Compare shows the
   * disk's version against the editor's, Keep mine writes the editor's over
   * it, Load from disk drops the edits for it.
   */
  import BrowserView from "$lib/components/BrowserView.svelte";
  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";
  import CodeEditor from "$lib/components/CodeEditor.svelte";
  import FileViewer from "$lib/components/FileViewer.svelte";
  import { browser } from "$lib/browser.svelte";
  import { languageOf } from "$lib/codeEditor";
  import {
    activeBuffer,
    activeTab,
    bufferText,
    cancelAsk,
    closeWindowAnyway,
    closeWithoutSaving,
    compare,
    diskText,
    editor,
    keepMine,
    loadFromDisk,
    otherKindShown,
    putAwayOther,
    saveAllAndClose,
    saveAndClose,
    unsavedNames,
  } from "$lib/editor.svelte";
  import { lineDiff } from "$lib/lineDiff";
  import { lastSegment } from "$lib/paths";
  import { selectedEntry } from "$lib/files.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";

  let tab = $derived(activeTab());
  let buffer = $derived(activeBuffer());
  let entry = $derived(selectedEntry());
  let editable = $derived(
    tab !== null && buffer !== null && !buffer.loading && buffer.error === null && tab.view === "edit",
  );
  let comparing = $derived(editable && editor.comparing && buffer?.changed != null);
  let compared = $derived(
    comparing && editor.active !== null ? lineDiff(diskText(editor.active), bufferText(editor.active)) : [],
  );
  let gone = $derived(buffer?.changed?.stamp === null);
  let names = $derived(editor.asking?.kind === "window" ? unsavedNames() : []);
</script>

{#snippet asking()}
  {#if editor.asking?.kind === "close" && tab !== null}
    <div class="strip">
      <ConfirmStrip
        question="Close {lastSegment(tab.path)} without saving?"
        detail="Its unsaved edits are dropped."
        action="Close without saving"
        alternative={{ label: "Save and close", onClick: () => void saveAndClose() }}
        onConfirm={closeWithoutSaving}
        onCancel={cancelAsk}
        testid="close-unsaved"
      />
    </div>
  {:else if editor.asking?.kind === "window"}
    <div class="strip">
      <ConfirmStrip
        question="Close the window with unsaved edits?"
        detail="{names.length === 1 ? '1 file has' : `${names.length} files have`} edits not yet saved: {names.join(', ')}."
        action="Close without saving"
        alternative={{ label: "Save all and close", onClick: () => void saveAllAndClose() }}
        onConfirm={closeWindowAnyway}
        onCancel={cancelAsk}
        testid="close-window"
      />
    </div>
  {/if}
{/snippet}

<div class="column" data-testid="editor-column">
  {#if otherKindShown()}
    {#if browser.showing}
      <BrowserView />
    {:else}
      <FileViewer onClose={putAwayOther} />
    {/if}
  {:else if tab === null || buffer === null}
    {@render asking()}
    <div class="empty" data-testid="editor-empty">
      <b>No file open</b>
      <span>Pick one in the tree, or start a new one with <kbd>{describe(chordFor("file.new"))}</kbd></span>
    </div>
  {:else}
    {@render asking()}
    {#if buffer.changed !== null && editable}
      <div class="banner" role="status" data-testid="disk-bar">
        <span class="what">
          <span class="mark" aria-hidden="true"></span>
          <span>
            {gone
              ? "This file was deleted on disk while you have unsaved edits"
              : "This file changed on disk while you have unsaved edits"}
          </span>
        </span>
        <span class="btns">
          <button class="btn primary" onclick={() => void compare()} data-testid="disk-compare"
            >{editor.comparing ? "Back to editing" : "Compare"}</button
          >
          <button class="btn" onclick={() => void keepMine()} data-testid="disk-keep">Keep mine</button>
          <button class="btn" onclick={() => void loadFromDisk()} data-testid="disk-load"
            >{gone ? "Close" : "Load from disk"}</button
          >
        </span>
      </div>
    {/if}
    {#if editor.failed !== null}
      <p class="failed" role="alert" data-testid="editor-failed">{editor.failed}</p>
    {/if}
    {#if tab.note}
      <p class="note" data-testid="editor-note">{tab.note}</p>
    {/if}
    {#if buffer.error !== null}
      <p class="reason" data-testid="editor-reason">{buffer.error}. Shown as the viewer shows it.</p>
    {/if}
    <div class="body">
      {#if comparing}
        <!-- The disk's version against the editor's, as the viewer draws a
             diff, read only. -->
        <div class="viewer compare" data-testid="disk-compare-view">
          <table class="lines diff">
            <tbody>
              {#each compared as line, i (i)}
                <tr class={line.kind}>
                  <td class="num">{line.old ?? ""}</td>
                  <td class="num">{line.new ?? ""}</td>
                  <td class="sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
                  <td class="text">{line.text}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if editable}
        <CodeEditor buffer={editor.active!} />
      {:else if buffer.loading}
        <p class="wait">Reading…</p>
      {:else}
        <FileViewer bare />
      {/if}
    </div>
    <footer class="foot" data-testid="editor-foot">
      {#if comparing}
        <span>The disk's version against yours, read only</span>
      {:else if editable}
        <span class="num" data-testid="editor-position">Ln {editor.cursor.line}, Col {editor.cursor.col}</span>
        <span>{languageOf(tab.path)}</span>
        <span class="end" class:warn={buffer.changed !== null} data-testid="editor-state">
          {#if buffer.changed !== null}
            Unsaved, and changed on disk
          {:else if buffer.saving}
            Saving…
          {:else if buffer.dirty}
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

  .strip {
    flex: none;
    padding: 8px 10px 0;
  }

  /* The question's shape, in the accent: something changed, nothing is
     lost yet. */
  .banner {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 10px;
    margin: 8px 10px 0;
    padding: 8px 10px 8px 12px;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--accent);
    font-size: 12.5px;
  }

  .what {
    flex: 1;
    min-width: 220px;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ink-2);
  }

  .mark {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.75px var(--accent);
  }

  .btns {
    display: flex;
    gap: 6px;
  }

  .btn {
    height: 26px;
    padding: 0 11px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink);
    white-space: nowrap;
    cursor: pointer;
  }

  .btn.primary {
    background: var(--accent);
    box-shadow: none;
    color: var(--surface);
  }

  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .failed {
    flex: none;
    margin: 8px 10px 0;
    font-size: 12.5px;
    color: var(--del);
  }

  .compare {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .lines {
    border-collapse: collapse;
    width: 100%;
    font-family: var(--mono);
    font-size: var(--editor-size, 12px);
    line-height: 1.55;
  }

  td {
    padding: 0 6px;
    vertical-align: top;
    white-space: pre;
  }

  td.num {
    width: 1%;
    text-align: right;
    color: var(--ink-3);
    user-select: none;
  }

  td.sign {
    width: 1%;
    text-align: center;
    color: var(--ink-3);
    user-select: none;
  }

  td.text {
    width: 100%;
    color: var(--ink-2);
  }

  .diff .add {
    background: color-mix(in srgb, var(--add) 12%, transparent);
  }

  .diff .add .text,
  .diff .add .sign {
    color: var(--add);
  }

  .diff .del {
    background: color-mix(in srgb, var(--del) 12%, transparent);
  }

  .diff .del .text,
  .diff .del .sign {
    color: var(--del);
  }

  .end.warn {
    color: var(--accent);
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
