<script lang="ts">
  import { tabWithin } from "$lib/tabStops";

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
    /** The way out is the answer to give: it is drawn filled, and the
        destructive action quietly beside Cancel. */
    safe?: boolean;
    testid: string;
  }

  let {
    question,
    detail = null,
    action,
    onConfirm,
    onCancel,
    alternative = null,
    safe = false,
    testid,
  }: Props = $props();

  function cancelFirst(node: HTMLElement) {
    node.focus();
  }

  /** Three buttons that do not fit on one line stand in a column, one
      group, rather than wrap two and one. */
  let stacked = $state(false);

  /** Measures the buttons at their own widths, in a row, and stacks them
      when the strip has less room than that. The width in a row is taken
      while they are in one, and the strip is measured again on a resize. */
  function fit(node: HTMLElement) {
    const strip = node.parentElement!;
    let row = 0;
    // Widths to the fraction of a pixel: a whole-pixel sum rounds a row
    // that is a fraction too wide down to one that fits.
    const measure = () => {
      if (!stacked) {
        const buttons = [...node.children] as HTMLElement[];
        const gap = parseFloat(getComputedStyle(node).columnGap) || 0;
        row = buttons.reduce((sum, button) => sum + button.getBoundingClientRect().width, 0) + gap * (buttons.length - 1);
      }
      const style = getComputedStyle(strip);
      const room = strip.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      stacked = row > room;
    };
    measure();
    // A frame later, so what the column does to the strip's height is not
    // seen in the same round of resize notices.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(strip);
    return {
      destroy() {
        cancelAnimationFrame(frame);
        observer.disconnect();
      },
    };
  }

  /** The strip holds the keyboard while it is up: Tab goes round its
      buttons, and Escape cancels. */
  function keys(event: KeyboardEvent) {
    if (event.key === "Tab") {
      tabWithin(event, event.currentTarget as HTMLElement);
      return;
    }
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
  {#snippet buttons()}
    {#if safe && alternative !== null}
      <button type="button" class="quiet" onclick={onConfirm} data-testid="{testid}-confirm">{action}</button>
      <button type="button" class="cancel" use:cancelFirst onclick={onCancel} data-testid="{testid}-cancel">Cancel</button>
      <button type="button" class="save" onclick={alternative.onClick} data-testid="{testid}-alternative"
        >{alternative.label}</button
      >
    {:else}
      <button type="button" class="cancel" use:cancelFirst onclick={onCancel} data-testid="{testid}-cancel">Cancel</button>
      {#if alternative !== null}
        <button type="button" class="cancel" onclick={alternative.onClick} data-testid="{testid}-alternative"
          >{alternative.label}</button
        >
      {/if}
      <button type="button" class="go" onclick={onConfirm} data-testid="{testid}-confirm">{action}</button>
    {/if}
  {/snippet}
  {#if alternative !== null}
    <div class="actions" class:stacked use:fit data-testid="{testid}-actions">{@render buttons()}</div>
  {:else}
    <div class="actions">{@render buttons()}</div>
  {/if}
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

  /* In a narrow pane the buttons wrap to rows of their own, each on one
     line. */
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    margin-left: auto;
  }

  /* Three that do not fit on one line: a column the strip's width, in the
     order they stand in a row, each button as wide as the others. */
  .actions.stacked {
    flex: 1 1 100%;
    flex-direction: column;
    align-items: stretch;
    margin-left: 0;
  }

  .actions.stacked button {
    margin: 0;
    padding-block: 5px;
  }

  button {
    white-space: nowrap;
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

  /* Where keeping is the answer: it is filled in the accent, and the
     destructive one sits apart, as words in the warning's colour. */
  .save {
    background: var(--accent);
    color: var(--surface);
  }

  .quiet {
    margin-right: auto;
    background: none;
    color: var(--del);
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
