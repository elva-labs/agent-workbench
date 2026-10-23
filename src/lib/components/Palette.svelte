<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { coversBrowser } from "$lib/browser.svelte";
  import { actionFor, type Action } from "$lib/keymap";
  import { focusPane, returnFocus } from "$lib/layout.svelte";
  import { closePalette, palette, paletteItems, type PaletteItem } from "$lib/palette.svelte";
  import { isLive } from "$lib/sessions.svelte";
  import { goTo } from "$lib/workspace.svelte";

  /**
   * The command palette, over the workbench like the sessions to resume: a
   * field with the keyboard in it, the sessions and actions under it, Enter
   * or a click on one does it, Escape puts it away.
   */

  interface Props {
    /** Does what an action's chord does. */
    perform: (action: Action) => void;
  }

  let { perform }: Props = $props();

  let dialog: HTMLDivElement;
  let field = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  let chosen = $state<string | null>(null);

  // The keyboard is taken on the way in and handed back on the way out,
  // whichever way the palette closed.
  onMount(() => {
    field?.focus();
    return returnFocus;
  });

  let items = $derived(paletteItems(palette.query));

  /** Whether picking the item does anything: the jump with nothing
      waiting does not. */
  const live = (item: PaletteItem) => !(item.kind === "attention" && item.waiting === 0);

  // The cursor follows the item chosen, wherever the list moves it. When the
  // item chosen is gone it sits on the first item that does something.
  const cursor = $derived.by(() => {
    const at = items.findIndex((item) => item.id === chosen);
    return at >= 0 ? at : Math.max(0, items.findIndex(live));
  });

  // A new query, and the opening one, choose the first item that does
  // something, so the list changing under it does not move the cursor.
  $effect(() => {
    palette.query;
    chosen = untrack(() => items.find(live)?.id ?? null);
  });

  /** The cursor moves to the next item in a direction that does something. */
  function step(direction: 1 | -1) {
    for (let at = cursor + direction; at >= 0 && at < items.length; at += direction) {
      if (live(items[at])) {
        chosen = items[at].id;
        return;
      }
    }
  }

  /** The id the list's option at a position carries. */
  const optionId = (index: number) => `palette-opt-${index}`;

  // The cursor stays in view.
  $effect(() => {
    const at = cursor;
    tick().then(() => {
      list?.querySelectorAll<HTMLElement>("[role='option']")[at]?.scrollIntoView?.({ block: "nearest" });
    });
  });

  /** Puts the palette away, then does what the item does, so where the
      item puts the keyboard is where it stays. */
  async function run(item: PaletteItem | undefined) {
    if (item === undefined) return;
    if (!live(item)) return;
    closePalette();
    await tick();
    if (item.kind === "session") {
      if (goTo(item.session.key)) focusPane("agent");
    } else if (item.kind === "attention") {
      perform({ type: "attention" });
    } else {
      perform(actionFor(item.action));
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        closePalette();
        return;
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "Enter":
        void run(items[cursor]);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && !dialog.contains(e.target as Node)) closePalette();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={closePalette} use:coversBrowser data-testid="palette-scrim">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
    tabindex="-1"
    bind:this={dialog}
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    data-testid="palette"
  >
    <input
      bind:this={field}
      bind:value={palette.query}
      placeholder="Go to a session, or do something"
      autocomplete="off"
      spellcheck="false"
      role="combobox"
      aria-expanded="true"
      aria-controls="palette-list"
      aria-activedescendant={items[cursor] === undefined ? undefined : optionId(cursor)}
      aria-label="Sessions and actions"
      data-testid="palette-field"
    />
    <div class="list" id="palette-list" role="listbox" aria-label="Sessions and actions" bind:this={list}>
      {#each items as item, index (item.id)}
        {#if item.kind === "action" && (index === 0 || items[index - 1].kind !== "action")}
          <div class="group" aria-hidden="true">Actions</div>
        {/if}
        <button
          class="row"
          class:cursor={index === cursor}
          class:off={!live(item)}
          id={optionId(index)}
          role="option"
          aria-selected={index === cursor}
          aria-disabled={!live(item)}
          tabindex="-1"
          title={item.kind === "session" && item.detail !== "" ? `${item.label} · ${item.detail}` : item.label}
          onclick={() => run(item)}
          onpointerdown={(e) => e.preventDefault()}
          onpointermove={(e) => {
            if ((e.movementX !== 0 || e.movementY !== 0) && live(item)) chosen = item.id;
          }}
          data-testid="palette-row"
          data-kind={item.kind}
        >
          {#if item.kind === "session"}
            <span
              class="dot"
              class:live={isLive(item.session)}
              class:unread={item.session.unread}
              class:permission={item.session.needs === "permission"}
            ></span>
          {/if}
          <span class="label">{item.label}</span>
          {#if item.kind === "session" && item.detail !== ""}
            <span class="detail">{item.detail}</span>
          {:else if item.kind === "attention"}
            <span class="detail">{item.waiting === 0 ? "nothing waiting" : `${item.waiting} waiting`}</span>
          {/if}
          {#if item.kind !== "session"}<kbd>{item.chord}</kbd>{/if}
        </button>
      {/each}
    </div>
    {#if items.length === 0}
      <p class="note">Nothing matches.</p>
    {/if}
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
    padding-top: 12vh;
  }

  .dialog {
    width: min(560px, calc(100vw - 48px));
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px var(--pane-pad) 12px;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    box-shadow: 0 18px 48px color-mix(in srgb, black 35%, transparent);
    outline: none;
  }

  input {
    font-family: var(--chrome);
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--ink);
    outline: none;
  }

  input:focus {
    border-color: var(--accent);
  }

  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }

  .group {
    padding: 8px 10px 3px;
    font-family: var(--chrome);
    font-size: 10px;
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    color: var(--ink-3);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    padding: 5px 10px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: 12px;
    color: var(--ink-2);
    cursor: pointer;
  }

  .row.cursor {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .row.off {
    color: var(--ink-3);
    cursor: default;
  }

  .label {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
    color: var(--ink-3);
  }

  kbd {
    flex: none;
    margin-left: auto;
    font-family: var(--chrome);
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .dot {
    width: var(--dot);
    height: var(--dot);
    flex: none;
    border: 1px solid var(--ink-3);
    border-radius: 50%;
  }

  .dot.live {
    background: var(--add);
    border-color: var(--add);
  }

  .dot.unread {
    background: var(--accent);
    border-color: var(--accent);
  }

  .dot.permission {
    background: var(--surface);
    border-color: var(--accent);
  }

  .note {
    margin: 0;
    padding: 10px;
    font-size: 12px;
    color: var(--ink-3);
  }
</style>
