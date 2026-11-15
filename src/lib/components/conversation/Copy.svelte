<script lang="ts">
  import { core } from "$lib/core";
  import { FLASH_MS, say } from "$lib/flash.svelte";
  import Icon from "./Icon.svelte";

  /**
   * A quiet Copy on something in the thread worth copying whole: a
   * message, a reply as Markdown, a code block, a command or its output.
   * It shows while the pointer is over what it copies, the element marked
   * with the same `data-copy-host`, and while the keyboard is on it. It is
   * an item of the thread's arrow walk, after the item it belongs to.
   *
   * A click copies what is there at that moment, so a reply still coming
   * is copied as far as it has come. The word turns to "Copied" for a
   * moment, and a screen reader hears it from a status beside the button,
   * whose own name stays the same throughout. The button keeps one width
   * through both words and takes no focus from a press, so nothing moves.
   */
  interface Props {
    /** The word on the button. */
    label: string;
    /** What a screen reader calls it, when the word alone says too little. */
    name?: string;
    /** What it copies, read at the click. */
    text: () => string;
    /** Which `data-copy-host` around it shows it on hover. */
    host: "message" | "code" | "command" | "output";
    /** In the line, at the line's end, over the top corner of a block, or
        drawn over the end of a row, just before what stands after it. */
    place?: "inline" | "end" | "corner" | "overlay";
    testid: string;
  }

  let { label, name, text, host, place = "inline", testid }: Props = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    copied = false;
    try {
      await core().copyText(text());
    } catch (error) {
      say(`Could not copy: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    copied = true;
    timer = setTimeout(() => {
      copied = false;
      timer = null;
    }, FLASH_MS);
  }

  $effect(() => () => {
    if (timer !== null) clearTimeout(timer);
  });
</script>

<button
  class="copy {place}"
  class:done={copied}
  tabindex="-1"
  data-thread-item
  data-copy={host}
  aria-label={name ?? label}
  onmousedown={(e) => e.preventDefault()}
  onclick={copy}
  data-testid={testid}
  data-copied={copied}
>
  <span class="face" class:off={copied} aria-hidden="true"><Icon name="copy" size={12} />{label}</span>
  <span class="face" class:off={!copied} aria-hidden="true"><Icon name="check" size={12} />Copied</span>
</button>
<span class="heard" role="status">{copied ? "Copied" : ""}</span>

<style>
  .copy {
    flex: none;
    display: inline-grid;
    align-items: center;
    height: 22px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font-family: var(--chrome);
    font-size: var(--conv-fine);
    font-weight: 400;
    line-height: 1;
    letter-spacing: normal;
    text-transform: none;
    color: var(--ink-2);
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    opacity: 0;
  }

  /* Both words in one cell, so the button is as wide for one as for the
     other. */
  .face {
    grid-area: 1 / 1;
    justify-self: center;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .end .face {
    justify-self: end;
  }

  .face.off {
    visibility: hidden;
  }

  /* Only the Copy of the innermost thing under the pointer: on a code
     block in a reply, the block's, not the reply's. */
  :global([data-copy-host="message"]:hover:not(:has([data-copy-host]:hover))) .copy[data-copy="message"],
  :global([data-copy-host="code"]:hover) .copy[data-copy="code"],
  :global([data-copy-host="command"]:hover) .copy[data-copy="command"],
  :global([data-copy-host="output"]:hover) .copy[data-copy="output"] {
    opacity: 1;
  }

  .copy:focus-visible,
  .copy.done {
    opacity: 1;
  }

  .copy:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .copy.done {
    color: var(--add);
  }

  /* In a line of text, without making the line taller, and above a
     button that reaches over the line. */
  .inline,
  .end {
    position: relative;
    z-index: 1;
    height: 20px;
    margin: -3px -4px;
  }

  .end {
    margin-left: auto;
  }

  /* Over the block's top corner, so a long first line passes under it
     rather than pushing it aside. */
  .corner {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 1;
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--divider, var(--rule));
  }

  .corner:hover {
    background: var(--surface);
  }

  /* Over the end of a row, the whole of its height, on the row's hover
     ground with a short fade into the title it covers, and a shade of its
     own under the pointer so it is told from the row. Shown only while the
     row is hovered or the keyboard is on it, so at rest the title has the
     whole row. */
  .overlay {
    position: absolute;
    top: -3px;
    bottom: -3px;
    right: 100%;
    z-index: 1;
    height: auto;
    padding: 0 8px;
    background: var(--surface-2);
    pointer-events: auto;
  }

  .overlay::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    right: 100%;
    width: 12px;
    background: linear-gradient(to right, transparent, var(--surface-2));
    pointer-events: none;
  }

  .overlay:hover {
    background: var(--rule);
  }

  .heard {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
