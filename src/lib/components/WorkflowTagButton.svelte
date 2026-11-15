<script lang="ts">
  import type { WorkflowTag } from "$lib/conductor.svelte";

  /**
   * The workflow a session is part of and its place in it, quietly beside
   * the pane's title, with the rules that place goes by in a popover: shown
   * while the pointer rests on the tag, and held open by a click or by
   * Enter or Space on it. Escape, or a press anywhere else, puts it away.
   *
   * Where the header is short of room, the workflow's name gives way first,
   * cut short and then gone, and the place stands whole.
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

  function toggle() {
    cancelTimers();
    if (open) {
      held = false;
      hovered = false;
      return;
    }
    place();
    held = true;
  }

  function close() {
    cancelTimers();
    held = false;
    hovered = false;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      event.preventDefault();
      close();
      button?.focus();
    }
  }

  // A press outside the tag and its popover puts it away, as does the
  // window changing size under it.
  $effect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && (button?.contains(target) || popover?.contains(target))) return;
      close();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", close);
    };
  });

  $effect(() => cancelTimers);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="holder" {onkeydown} onpointerenter={pointerIn} onpointerleave={pointerOut}>
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
    <span class="role" data-testid="workflow-tag-role">{tag.role}</span>
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
  .holder {
    flex: 1;
    min-width: 0;
    display: flex;
  }

  /* The place is first in the source and drawn last: a row laid from the
     right that wraps, one line tall, so the workflow's name, which shrinks
     to a few letters before it gives way, is what leaves the line when the
     two do not fit. */
  .tag {
    min-width: 0;
    max-width: 100%;
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
    flex: none;
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
