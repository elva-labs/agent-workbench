<script lang="ts">
  import { onMount } from "svelte";
  import { returnFocus } from "$lib/layout.svelte";
  import { cancelAction, pluginSections, run, sectionOf } from "$lib/pluginSections.svelte";

  /**
   * What an action asks for before it runs, over the workbench: a line of
   * text or a choice, one per field the plugin declared. Escape and Cancel
   * leave it alone; Run takes the answers to the plugin.
   */

  let dialog: HTMLElement;

  let pending = $derived(pluginSections.pending);
  let section = $derived(pending === null ? null : sectionOf(pending.key));
  let fields = $derived(pending?.action.input ?? []);

  /** An answer per field: empty for a line of text, the first option for a
      choice, so running without touching a choice still says something. */
  let values = $state<Record<string, string>>(
    Object.fromEntries(
      (pluginSections.pending?.action.input ?? []).map((field) => [
        field.id,
        field.kind === "choice" ? (field.options?.[0]?.id ?? "") : "",
      ]),
    ),
  );

  // The keyboard is taken on the way in, by the first field, and handed
  // back on the way out, whichever way the dialog closed.
  onMount(() => {
    const field = dialog.querySelector<HTMLElement>("input, select");
    (field ?? dialog).focus();
    return returnFocus;
  });

  function submit() {
    if (pending !== null && section !== null) {
      void run(section, pending.action, pending.row, { ...values });
    }
    cancelAction();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelAction();
    }
  }
</script>

<!-- A click on the scrim leaves the action alone, as Escape does; the
     dialog itself takes the keyboard. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="scrim" onclick={cancelAction} data-testid="action-scrim">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="action-title"
    tabindex="-1"
    bind:this={dialog}
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    data-testid="action-input"
  >
    <header>
      <h2 id="action-title">{pending?.action.label ?? ""}</h2>
    </header>

    <div class="body">
      {#each fields as field (field.id)}
        <label class="field">
          <span class="name">{field.label}</span>
          {#if field.kind === "choice"}
            <select bind:value={values[field.id]} data-field={field.id} data-testid="action-choice">
              {#each field.options ?? [] as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          {:else}
            <input
              type="text"
              bind:value={values[field.id]}
              placeholder={field.placeholder ?? ""}
              spellcheck="false"
              autocomplete="off"
              onkeydown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                submit();
              }}
              data-field={field.id}
              data-testid="action-text"
            />
          {/if}
        </label>
      {/each}
    </div>

    <footer>
      <button class="quiet" onclick={cancelAction} data-testid="action-cancel">Cancel</button>
      <button class="go" onclick={submit} data-testid="action-run">Run</button>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 14vh;
  }

  .dialog {
    width: min(420px, calc(100vw - 48px));
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    box-shadow: 0 18px 48px color-mix(in srgb, black 35%, transparent);
    outline: none;
  }

  header {
    padding: 9px var(--pane-pad);
    border-bottom: 1px solid var(--head-rule);
    flex: none;
  }

  h2 {
    margin: 0;
    font-family: var(--chrome);
    font-size: var(--title-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    font-weight: 500;
    color: var(--accent);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px var(--pane-pad);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .name {
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    color: var(--ink-3);
  }

  input,
  select {
    width: 100%;
    padding: 5px 7px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--field-bg);
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink);
  }

  input:focus,
  select:focus {
    border-color: var(--accent);
    outline: none;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 var(--pane-pad) 12px;
  }

  footer button {
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    background: var(--surface);
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-2);
    cursor: pointer;
    padding: 4px 10px;
  }

  footer button.go {
    border-color: var(--accent);
    color: var(--accent);
  }

  footer button:hover {
    background: var(--surface-2);
  }
</style>
