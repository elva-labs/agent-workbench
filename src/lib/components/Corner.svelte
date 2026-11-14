<script lang="ts">
  /**
   * The window's top right corner: the button that shows and hides the right
   * pane, and the switch between agent mode and editor mode. It stands at the
   * end of whichever header is rightmost, so it is in the same place in both
   * modes whatever the panes under it do. It is window chrome rather than
   * part of the pane it sits in: pressing it leaves the keyboard where it is.
   */
  import { flipMode } from "$lib/editor.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";
  import { layout, toggleRightPane } from "$lib/layout.svelte";

  let editing = $derived(layout.mode === "editing");
  /** Whether the right pane is asked for, the agent while editing and the
      changes otherwise; the window may still be too narrow to show it. */
  let rightShown = $derived(editing ? layout.agentChosen : layout.changesChosen);
  let rightTitle = $derived(`Show or hide the right pane  ${describe(chordFor("toggle.changes"))}`);
  let modeTitle = $derived(`Agent or editor in the middle  ${describe(chordFor("mode"))}`);

  function chrome(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function pick(toEditor: boolean) {
    if (toEditor !== editing) flipMode();
  }
</script>

<div class="corner" data-testid="corner">
  <button
    class="right"
    class:off={!rightShown}
    onpointerdown={chrome}
    onclick={toggleRightPane}
    aria-pressed={rightShown}
    aria-label="Show or hide the right pane"
    title={rightTitle}
    data-testid="toggle-right"
  >
    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M10 3v10" /></svg>
  </button>
  <div class="mode" role="radiogroup" aria-label="What takes the middle" title={modeTitle}>
    <button
      role="radio"
      aria-checked={!editing}
      class:on={!editing}
      onpointerdown={chrome}
      onclick={() => pick(false)}
      data-testid="mode-agent">Agent</button
    >
    <button
      role="radio"
      aria-checked={editing}
      class:on={editing}
      onpointerdown={chrome}
      onclick={() => pick(true)}
      data-testid="mode-editor">Editor</button
    >
  </div>
</div>

<style>
  /* Within the header's own height: the controls overhang its padding
     rather than make the row taller than the headers beside it. */
  .corner {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    align-self: center;
    margin: -6px 0 -6px 4px;
  }

  .right {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .right svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .right:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .right.off svg path {
    opacity: 0.45;
  }

  .mode {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 2px;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--surface-2) 70%, var(--ink) 6%);
  }

  .mode button {
    padding: 1px 9px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    line-height: 18px;
    color: var(--ink-3);
    cursor: pointer;
    white-space: nowrap;
  }

  .mode button:hover {
    color: var(--ink);
  }

  .mode button.on {
    background: var(--surface);
    color: var(--ink);
    font-weight: var(--btn-weight);
    box-shadow: 0 0 0 1px var(--head-rule);
  }

  .right:focus-visible,
  .mode button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
