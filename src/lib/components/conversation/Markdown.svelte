<script lang="ts">
  import { core } from "$lib/core";
  import { saidBlocks, settled } from "$lib/media.svelte";
  import { mount, tick, unmount } from "svelte";
  import Copy from "./Copy.svelte";

  /**
   * What the agent wrote, as a reader sees it: the same Markdown the viewer
   * renders for a presented document, links opening outside the window and
   * an image from an address shown as a link to it rather than fetched.
   * While it streams it is drawn again at most once a frame, a block at a
   * time: the blocks before the last are rendered once and stay as they
   * are, only the last is rendered again as words come, and a caret
   * stands where the next words will come, so the text grows in place.
   * Every code block, at the top or in a list or a quote, has a Copy in its
   * top corner that copies its code; one in a block that is done keeps its
   * Copy, and the keyboard on it, while the words after it still come.
   */
  interface Props {
    text: string;
    streaming?: boolean;
  }

  let { text, streaming = false }: Props = $props();

  let shown = $state("");
  let frame: number | null = null;

  $effect(() => {
    const next = text;
    if (!streaming || shown === "") {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      shown = next;
      return;
    }
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      shown = text;
    });
  });

  $effect(() => () => {
    if (frame !== null) cancelAnimationFrame(frame);
  });

  /** The whole blocks of a reply that streams: their text and what they
      render as, so they are rendered once. */
  let kept = { text: "", blocks: [] as string[] };
  /** A line that defines where a reference link leads. */
  const DEFINES = /^ {0,3}\[[^\]\n]+\]:/m;

  let blocks = $derived.by(() => {
    const now = shown;
    // Whole, a reply is rendered whole once more, and one that defines a
    // reference link is rendered whole as it streams, so the link finds an
    // address defined after it as soon as it comes.
    if (!streaming || DEFINES.test(now)) {
      kept = { text: "", blocks: [] };
      return saidBlocks(now);
    }
    if (!now.startsWith(kept.text)) kept = { text: "", blocks: [] };
    let rest = now.slice(kept.text.length);
    const whole = settled(rest);
    if (whole > 0) {
      kept = { text: kept.text + rest.slice(0, whole), blocks: [...kept.blocks, ...saidBlocks(rest.slice(0, whole))] };
      rest = rest.slice(whole);
    }
    return [...kept.blocks, ...saidBlocks(rest)];
  });

  let box = $state<HTMLDivElement | null>(null);

  /** The Copy put in each code block's box, by the box. A box goes when
      its block is drawn again, and its Copy with it. */
  const copies = new Map<HTMLElement, ReturnType<typeof mount>>();

  /** The code a block's box holds, as written. */
  function codeIn(code: HTMLElement): string {
    return (code.querySelector("pre code")?.textContent ?? "").replace(/\n$/, "");
  }

  // A link is walked with the arrows in the thread, which is one stop for
  // Tab, rather than being a stop of its own; and each code block gets its
  // Copy.
  $effect(() => {
    blocks;
    const node = box;
    // After the text is drawn again, which can be a turn after this runs.
    void tick().then(() => {
      for (const link of node?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []) link.tabIndex = -1;
      for (const [code, copy] of copies)
        if (!code.isConnected || node === null || !node.contains(code)) {
          void unmount(copy);
          copies.delete(code);
        }
      for (const code of node?.querySelectorAll<HTMLElement>("div.code[data-copy-host='code']") ?? []) {
        if (copies.has(code)) continue;
        copies.set(
          code,
          mount(Copy, {
            target: code,
            props: { label: "Copy", name: "Copy the code", text: () => codeIn(code), host: "code", place: "corner", testid: "copy-code" },
          }),
        );
      }
    });
  });

  $effect(() => () => {
    for (const copy of copies.values()) void unmount(copy);
    copies.clear();
  });

  function onclick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement | null)?.closest("a");
    if (anchor === null || anchor === undefined) return;
    e.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//.test(href)) core().openUrl(href).catch(() => {});
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="md" class:streaming {onclick} bind:this={box} data-testid="markdown">
  {#each blocks as block, at (at)}
    {@html block}
  {/each}
</div>

<style>
  .md {
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
    cursor: text;
  }

  .md :global(p),
  .md :global(ul),
  .md :global(ol),
  .md :global(blockquote),
  .md :global(table),
  .md :global(pre) {
    margin: 0 0 0.7em;
  }

  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.4em;
  }

  /* Words keep a measure that still reads in a wide pane; code, tables
     and what steps print use the whole width. */
  .md > :global(:is(p, ul, ol, blockquote, h1, h2, h3, h4)) {
    max-width: var(--conv-measure);
  }

  .md :global(li + li) {
    margin-top: 0.2em;
  }

  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: 1em 0 0.4em;
    font-size: 1.05em;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink);
  }

  .md :global(h1) {
    font-size: 1.2em;
  }

  .md :global(code) {
    font-family: var(--mono);
    font-size: 0.89em;
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }

  .md :global(pre) {
    padding: 10px 12px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--surface-2);
    overflow-x: auto;
    line-height: 1.5;
  }

  .md :global(.code) {
    position: relative;
    margin: 0 0 0.7em;
  }

  .md :global(.code > pre) {
    margin: 0;
  }

  .md :global(pre code) {
    padding: 0;
    background: none;
    font-size: var(--conv-meta);
    white-space: pre;
  }

  /* A block of prose wraps at the block's width, which stops at the measure
     of the prose around it, at word boundaries; each
     line hangs its continuation under its own indent and list marker. */
  .md :global(.code[data-wrap]) {
    max-width: var(--conv-measure);
  }

  .md :global(.code[data-wrap] pre) {
    overflow-x: hidden;
    tab-size: 8;
  }

  .md :global(.code[data-wrap] pre code) {
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  .md :global(.code[data-wrap] .line) {
    display: block;
    padding-left: var(--hang);
    text-indent: calc(-1 * var(--hang));
  }

  /* Declared after every block's own margins, so a message starts and ends
     flush: a rule that comes first loses to the margin of a block, a
     heading or a table. */
  .md > :global(:first-child) {
    margin-top: 0;
  }

  .md > :global(:last-child) {
    margin-bottom: 0;
  }

  .md :global(blockquote) {
    padding-left: 12px;
    border-left: 3px solid var(--rule-strong);
    color: var(--ink-2);
  }

  /* A table lays its columns out by their words, and one wider than the
     thread scrolls sideways on its own. */
  .md :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    overflow-wrap: normal;
    font-size: 0.95em;
  }

  .md :global(th),
  .md :global(td) {
    padding: 4px 10px;
    border: 1px solid var(--rule);
    text-align: left;
    vertical-align: top;
  }

  .md :global(th) {
    background: var(--surface-2);
    font-weight: 600;
  }

  .md :global(a) {
    color: var(--accent);
  }

  .md :global(img) {
    max-width: 100%;
  }

  .md :global(hr) {
    border: 0;
    border-top: 1px solid var(--rule);
    margin: 1em 0;
  }

  /* Where the next words will come. Inside the last paragraph or line
     while there is one, so the text does not move when it arrives. */
  .streaming > :global(:last-child:not(ul):not(ol):not(table):not(pre):not(.code))::after,
  .streaming > :global(:is(ul, ol):last-child > li:last-child)::after {
    content: "";
    display: inline-block;
    width: 0.5em;
    height: 1em;
    margin-left: 2px;
    vertical-align: -0.15em;
    border-radius: 2px;
    background: var(--accent);
    animation: caret 1.1s ease-in-out infinite;
  }

  @keyframes caret {
    50% {
      opacity: 0.3;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .streaming > :global(*)::after {
      animation: none !important;
    }
  }
</style>
