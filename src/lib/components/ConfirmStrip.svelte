<script lang="ts">
  /**
   * A question put in place before something is taken away: what goes and
   * what follows from it, with the destructive action and Cancel. Cancel
   * takes the keyboard when it opens, so Return alone does no harm, and
   * Escape cancels without closing the settings around it.
   */
  interface Props {
    /** The question, such as Delete "Quick fix"? */
    question: string;
    /** What else changes, if anything. */
    detail?: string | null;
    /** The destructive action's label. */
    action: string;
    onConfirm: () => void;
    onCancel: () => void;
    /** A way out that keeps what would go, such as saving first. */
    alternative?: { label: string; onClick: () => void } | null;
    testid: string;
  }

  let { question, detail = null, action, onConfirm, onCancel, alternative = null, testid }: Props = $props();

  function cancelFirst(node: HTMLElement) {
    node.focus();
  }

  function keys(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="strip" role="alertdialog" aria-label={question} onkeydown={keys} data-testid={testid} tabindex="-1">
  <p>
    <b>{question}</b>
    {#if detail}<span>{detail}</span>{/if}
  </p>
  <div class="actions">
    <button type="button" class="cancel" use:cancelFirst onclick={onCancel} data-testid="{testid}-cancel">Cancel</button>
    {#if alternative !== null}
      <button type="button" class="cancel" onclick={alternative.onClick} data-testid="{testid}-alternative"
        >{alternative.label}</button
      >
    {/if}
    <button type="button" class="go" onclick={onConfirm} data-testid="{testid}-confirm">{action}</button>
  </div>
</div>

<style>
  .strip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    padding: 8px 10px;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--del) 55%, transparent);
    background: color-mix(in srgb, var(--del) 7%, transparent);
    outline: none;
  }

  p {
    flex: 1 1 200px;
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ink-2);
  }

  b {
    font-weight: 600;
    color: var(--ink);
  }

  .actions {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }

  button {
    padding: 4px 10px;
    border: 0;
    border-radius: var(--radius);
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    cursor: pointer;
  }

  .cancel {
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    color: var(--ink);
  }

  .go {
    background: var(--del);
    color: var(--surface);
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
