<script lang="ts">
  import type { WorkflowTag } from "$lib/conductor.svelte";
  import { letters } from "$lib/giveWay";
  import { putAway } from "$lib/popover";

  /**
   * The workflow a session is part of and its place in it, quietly beside
   * the pane's title, with the rules that place goes by in a popover: shown
   * while the pointer rests on the tag, and held open by a click or by
   * Enter or Space on it. Escape, wherever the keyboard is, or a press
   * anywhere else, puts it away.
   *
   * Where the header is short of room, the workflow's name gives way first,
   * cut short and then gone, and the place stands whole: it is what the
   * header keeps until its status has gone, and only then is cut short
   * itself, and gone at a letter or two.
   */
  let { tag }: { tag: WorkflowTag } = $props();

  const id = $props.id();
  let button = $state<HTMLButtonElement | null>(null);
  let popover = $state<HTMLDivElement | null>(null);
  /** Shown while the pointer is over the tag or the popover. */
  let hovered = $state(false);
  /** Held open by a click or a key. */
  let held = $state(false);
  let open = $derived(hovered || held);
  let at = $state({ left: 0, top: 0, width: 0, height: 0 });
  let leave: ReturnType<typeof setTimeout> | null = null;

  const SHOW_AFTER = 350;
  const HIDE_AFTER = 150;
  const WIDTH = 420;
  const EDGE = 12;
  let enter: ReturnType<typeof setTimeout> | null = null;

  /** Puts the popover under the tag, inside the pane it sits in. */
  function place() {
    if (button === null) return;
    const tagBox = button.getBoundingClientRect();
    const pane = button.closest(".pane")?.getBoundingClientRect() ?? document.body.getBoundingClientRect();
    const width = Math.min(WIDTH, pane.width - 2 * EDGE);
    const left = Math.max(pane.left + EDGE, Math.min(tagBox.left, pane.right - EDGE - width));
    const top = tagBox.bottom + 6;
    at = { left, top, width, height: Math.max(120, pane.bottom - EDGE - top) };
  }

  function cancelTimers() {
    if (enter !== null) clearTimeout(enter);
    if (leave !== null) clearTimeout(leave);
    enter = null;
    leave = null;
  }

  function pointerIn() {
    cancelTimers();
    if (open) {
      hovered = true;
      return;
    }
    enter = setTimeout(() => {
      place();
      hovered = true;
    }, SHOW_AFTER);
  }

  function pointerOut() {
    cancelTimers();
    leave = setTimeout(() => (hovered = false), HIDE_AFTER);
  }

  /** A click, Enter or Space holds the popover open, the one shown by
      the pointer resting on it as well, and puts a held one away. */
  function toggle() {
    cancelTimers();
    if (held) {
      held = false;
      hovered = false;
      return;
    }
    if (!open) place();
    held = true;
  }

  function close() {
    cancelTimers();
    held = false;
    hovered = false;
  }

  // Escape wherever the keyboard is, a press outside the tag and its
  // popover, or the window changing size under it puts it away.
  $effect(() => {
    if (!open) return;
    return putAway({ inside: () => [button, popover], close, control: () => button });
  });

  $effect(() => cancelTimers);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="holder" onpointerenter={pointerIn} onpointerleave={pointerOut}>
  <button
    bind:this={button}
    class="tag"
    class:open
    onclick={toggle}
    onblur={() => (held = false)}
    aria-expanded={open}
    aria-controls={open ? id : undefined}
    aria-label="{tag.workflow === null ? '' : `${tag.workflow}, `}{tag.role}. Show the rules"
    data-testid="workflow-tag"
  >
    <span class="role" use:letters={tag.role} data-keep data-testid="workflow-tag-role">{tag.role}</span>
    {#if tag.workflow !== null}
      <span class="flow" data-testid="workflow-tag-flow"><span class="name">{tag.workflow}</span><span class="sep">·</span></span>
    {/if}
  </button>
  {#if open}
    <div
      bind:this={popover}
      {id}
      class="popover"
      role="region"
      aria-label="The rules for {tag.role}"
      style:left="{at.left}px"
      style:top="{at.top}px"
      style:width="{at.width}px"
      style:max-height="{at.height}px"
      data-testid="workflow-rules"
    >
      <p class="head">{tag.workflow === null ? tag.role : `${tag.workflow} · ${tag.role}`}</p>
      {#if tag.numbered}
        <ol>
          {#each tag.rules as rule, index (index)}<li>{rule}</li>{/each}
        </ol>
      {:else}
        {#each tag.rules as rule, index (index)}<p class="rule">{rule}</p>{/each}
      {/if}
    </div>
  {/if}
</span>

<style>
  /* From its own width, so what stands beside it in the header's head
     gives way before the tag does. */
  .holder {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
  }

  /* The place is first in the source and drawn last: a row laid from the
     right that wraps, one line tall, so the workflow's name, which shrinks
     to a few letters before it gives way, is what leaves the line when the
     two do not fit. */
  /* Its padding is the hover's, and its margins bleed it into the gaps
     around: the text has all of the room the tag is given. */
  .tag {
    min-width: 0;
    max-width: calc(100% + 8px);
    height: calc(var(--meta-size) * 1.6);
    overflow: hidden;
    display: flex;
    flex-direction: row-reverse;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    column-gap: 0.5em;
    padding: 0 4px;
    margin: 0 -4px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font-family: var(--chrome);
    font-size: var(--meta-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    line-height: 1.6;
    color: var(--ink-3);
    white-space: nowrap;
    cursor: default;
  }

  .tag:hover,
  .tag.open {
    color: var(--ink-2);
    background: var(--surface-2);
  }

  .tag:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  .role {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* A place cut to a letter or two goes, and the tag with it: no empty
     button to hover or to stop on. */
  .tag:has(.role:global(.cut)) {
    visibility: hidden;
  }

  .flow {
    flex: 1 1 6ch;
    min-width: 0;
    max-width: max-content;
    display: flex;
    column-gap: 0.5em;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sep {
    flex: none;
  }

  .popover {
    position: fixed;
    z-index: 20;
    box-sizing: border-box;
    overflow-y: auto;
    padding: 10px 12px 12px;
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px color-mix(in srgb, black 25%, transparent);
    color: var(--ink-2);
    font-size: 12px;
    line-height: 1.5;
    text-transform: none;
    letter-spacing: normal;
    white-space: normal;
    cursor: auto;
  }

  .head {
    margin: 0 0 6px;
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-3);
  }

  ol {
    margin: 0;
    padding-left: 1.4em;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .rule {
    margin: 0;
  }
</style>
