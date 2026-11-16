<script lang="ts">
  /**
   * The path asked for before an untitled file is first written, put over
   * the editor: a path from the top of the project the file was started
   * in, which the field names, the folder it was started in already
   * written and its name selected to type over. Enter or Save writes it,
   * and Escape or Cancel puts the field away with the file still
   * untitled. A path that will not do says why under the field;
   * one that holds a file already asks whether to replace it, and Cancel
   * there comes back to the field.
   *
   * The field holds the keyboard while it is up, as a question in a strip
   * does: Tab goes round its field and buttons, and close and the chords
   * that move the keyboard leave it be.
   */
  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";
  import { cancelSaveAs, editor, keepName, setSaveAsName } from "$lib/editor.svelte";
  import { commitSaveAs, confirmReplace } from "$lib/fileOps.svelte";
  import { tabWithin } from "$lib/tabStops";
  import { projectLabel } from "$lib/workspace.svelte";

  let asked = $derived(editor.savingAs);
  let name = $derived(asked === null ? "" : (editor.buffers[asked.key]?.path ?? ""));
  // The project the file was started in, which it is written to, whichever
  // is on screen.
  let project = $derived(asked === null ? "" : projectLabel(asked.project));

  /** The field takes the keyboard each time it is put up, with the file's
      name selected up to its extension, so typing replaces the name and
      keeps the folder before it. */
  function takeKeyboard(input: HTMLInputElement, _session: number) {
    const take = () => {
      input.focus();
      const start = Math.max(input.value.lastIndexOf("/"), input.value.lastIndexOf("\\")) + 1;
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(start, dot > start ? dot : input.value.length);
    };
    take();
    return { update: take };
  }

  function keys(event: KeyboardEvent) {
    if (event.key === "Tab") {
      tabWithin(event, event.currentTarget as HTMLElement);
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelSaveAs();
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void commitSaveAs();
  }
</script>

{#if asked !== null}
  {#if asked.replace !== null}
    <ConfirmStrip
      question="Replace {asked.replace}?"
      detail="A file is already there. Replacing it writes {name} over it."
      action="Replace"
      onConfirm={() => void confirmReplace()}
      onCancel={keepName}
      testid="save-replace"
    />
  {:else}
    <!-- A question in a strip, as the app's others are: while it has the
         keyboard, close and the chords that move the keyboard leave it. -->
    <div role="alertdialog" aria-label="Save {name}" tabindex="-1">
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <form
        class="strip"
        onkeydown={keys}
        onsubmit={submit}
        data-testid="save-as"
      >
        <label class="what" for="save-as-path">Save {name} as</label>
        <div class="field">
          <span class="box" class:wrong={asked.problem !== null}>
            {#if project !== ""}<span class="root" title={project} data-testid="save-as-root">{project}/</span>{/if}
            <input
              id="save-as-path"
              value={asked.value}
              oninput={(e) => setSaveAsName((e.currentTarget as HTMLInputElement).value)}
              use:takeKeyboard={asked.session}
              readonly={asked.busy}
              spellcheck="false"
              autocomplete="off"
              autocapitalize="off"
              aria-invalid={asked.problem !== null}
              aria-describedby={asked.problem === null ? undefined : "save-as-problem"}
              data-testid="save-as-field"
            />
          </span>
          {#if asked.problem !== null}
            <p class="problem" id="save-as-problem" role="alert" data-testid="save-as-problem">{asked.problem}</p>
          {/if}
        </div>
        <div class="actions">
          <button type="button" class="cancel" onclick={cancelSaveAs} data-testid="save-as-cancel">Cancel</button>
          <button type="submit" class="save" disabled={asked.busy} data-testid="save-as-save">Save</button>
        </div>
      </form>
    </div>
  {/if}
{/if}

<style>
  /* The question's shape, in the accent: nothing goes, something is asked. */
  .strip {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 10px;
    margin: 0;
    padding: 8px 10px;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 60%, transparent);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }

  .what {
    flex: none;
    line-height: 26px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
  }

  .field {
    flex: 1 1 240px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .box {
    display: flex;
    align-items: center;
    min-width: 0;
    height: 26px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    background: var(--field-bg);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    font-family: var(--mono);
    font-size: 12px;
  }

  .box:focus-within {
    box-shadow: 0 0 0 1.5px var(--accent);
  }

  .box.wrong {
    box-shadow: 0 0 0 1.5px var(--del);
  }

  .root {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-3);
  }

  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--ink);
    outline: none;
  }

  .problem {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--del);
  }

  .actions {
    flex: none;
    display: flex;
    gap: 6px;
    margin-left: auto;
  }

  button {
    height: 26px;
    padding: 0 11px;
    border: 0;
    border-radius: var(--radius);
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    white-space: nowrap;
    cursor: pointer;
  }

  .cancel {
    background: var(--clear-surface);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    color: var(--ink);
  }

  .save {
    background: var(--accent);
    color: var(--surface);
  }

  .save:disabled {
    opacity: 0.6;
    cursor: default;
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
