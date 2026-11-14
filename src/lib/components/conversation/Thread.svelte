<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Conversation, Entry, Message } from "$lib/conversation.svelte";
  import { clock, nowDoing, speaker, startedIds, tokens } from "$lib/thread";
  import Icon from "./Icon.svelte";
  import Parts from "./Parts.svelte";
  import Started from "./Started.svelte";

  /**
   * The thread: who said what, in the order it happened. The user's words
   * sit to the right in a tinted bubble under "You"; the agent's run on
   * the left under its name, down a quiet line at the side. Messages that
   * wait for the agent stand under the thread until a turn takes them.
   *
   * The thread stays at its foot while it is there and new content comes,
   * and stays where the user scrolled to otherwise, with a way back down.
   */
  interface Props {
    conversation: Conversation;
    /** The folder paths in the thread are shown from. */
    root: string | null;
    /** What stands above a thread with nothing in it yet. */
    intro: string | null;
    /** A message that failed to send is taken back into the composer. */
    onPutBack?: (message: Message) => void;
  }

  let { conversation, root, intro, onPutBack }: Props = $props();

  let scroller = $state<HTMLDivElement | null>(null);
  /** Whether the thread is at its foot, and so follows what comes. */
  let pinned = true;
  /** Something came while the user was scrolled up. */
  let behind = $state(false);

  /** The agent's last run in the running turn, where what it is doing now
      is said. */
  let liveKey = $derived.by(() => {
    if (!conversation.working || conversation.ended !== null) return null;
    // With no turn running the run that ended says how it ended; only a
    // compaction or subagents still to report are said under it.
    if (
      conversation.current === null &&
      !conversation.compacting &&
      !conversation.tasks.some((task) => task.kind === "agent" && !task.ambient && task.status === "running")
    )
      return null;
    for (let at = conversation.entries.length - 1; at >= 0; at--) {
      const entry = conversation.entries[at];
      if (entry.kind === "agent") return conversation.current === null || entry.turn === conversation.current ? entry.key : null;
      if (entry.kind === "user") return null;
    }
    return null;
  });

  /** The last run of each turn, which says how the turn ended. */
  let lastOfTurn = $derived.by(() => {
    const last = new Map<number, string>();
    for (const entry of conversation.entries) if (entry.kind === "agent") last.set(entry.turn, entry.key);
    return new Set(last.values());
  });

  /** A cheap reading of what the thread holds, which changes whenever
      something new comes: more entries, a longer last part, a request. */
  function pulse(): string {
    const last = conversation.entries[conversation.entries.length - 1];
    let tail = "";
    if (last?.kind === "agent") {
      const part = last.parts[last.parts.length - 1];
      if (part !== undefined)
        tail =
          part.kind === "text" || part.kind === "thinking"
            ? `${part.text.length}`
            : part.kind === "tool"
              ? `${part.done}:${part.output.length}`
              : part.kind;
      tail = `${last.parts.length}:${tail}`;
    }
    return `${conversation.entries.length}|${conversation.waiting.length}|${tail}|${conversation.open.length}|${liveKey}`;
  }

  // Follows new content down while at the foot; marks it as come while not.
  $effect(() => {
    pulse();
    untrack(() => {
      if (scroller === null) return;
      if (!pinned) {
        behind = true;
        return;
      }
      void tick().then(() => {
        if (scroller !== null && pinned) scroller.scrollTop = scroller.scrollHeight;
      });
    });
  });

  function onscroll() {
    if (scroller === null) return;
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
    if (pinned) behind = false;
  }

  function toFoot() {
    if (scroller === null) return;
    pinned = true;
    behind = false;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }

  function message(id: string): Message | null {
    return conversation.messages[id] ?? null;
  }

  function visible(entry: Entry): boolean {
    if (entry.kind !== "agent") return true;
    if (entry.parts.length > 0 || entry.key === liveKey) return true;
    const turn = conversation.turns[entry.turn];
    return lastOfTurn.has(entry.key) && (turn?.outcome === "interrupted" || turn?.outcome === "failed");
  }
</script>

<div class="frame">
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="thread" bind:this={scroller} {onscroll} data-testid="thread" tabindex="-1">
  <div class="col">
    {#if conversation.late || (intro !== null && conversation.entries.length === 0 && conversation.waiting.length === 0)}
      <p class="intro" data-testid="thread-intro">
        {conversation.late ? "Earlier messages of this session are in its transcript and are not shown here." : intro}
      </p>
    {/if}

    {#each conversation.entries as entry (entry.key)}
      {#if entry.kind === "user"}
        {@const said = message(entry.message)}
        {#if said !== null}
          {@render userMessage(said)}
        {/if}
      {:else if entry.kind === "agent" && visible(entry)}
        {@const turn = conversation.turns[entry.turn]}
        {@const live = entry.key === liveKey}
        {@const doing = live ? nowDoing(conversation, entry.parts) : null}
        <article class="msg agent" data-testid="agent-run" data-turn={entry.turn}>
          <header class="who">
            <i class="mark"></i><b>{speaker(conversation, turn?.model ?? null)}</b>
            {#if entry.at !== null}<time class="num">{clock(entry.at)}</time>{/if}
          </header>
          <Parts parts={entry.parts} {root} />
          <Started ids={startedIds(entry.parts)} />
          {#if live && doing !== null}
            <p class="now" data-testid="now"><span class="caret"></span>{doing}</p>
          {/if}
          {#if lastOfTurn.has(entry.key) && turn?.outcome === "interrupted"}
            <p class="outcome" data-testid="turn-outcome">Interrupted</p>
          {:else if lastOfTurn.has(entry.key) && turn?.outcome === "failed"}
            <p class="outcome bad" data-testid="turn-outcome">
              The turn failed{turn.error ? `: ${turn.error}` : "."}
            </p>
          {/if}
        </article>
      {:else if entry.kind === "note"}
        <p class="note {entry.tone}" data-testid="note">
          <Icon name={entry.tone === "info" ? "info" : "warn"} size={13} />{entry.text}
        </p>
      {:else if entry.kind === "compaction"}
        <div class="divider" data-testid="compaction">
          <span>
            {#if !entry.done}
              Compacting the conversation…
            {:else}
              Conversation compacted{entry.reason === "full" ? ", the context was full" : ""}{#if entry.tokensBefore !== null && entry.tokensAfter !== null}<span class="num"> · {tokens(entry.tokensBefore)} → {tokens(entry.tokensAfter)} tokens</span>{/if}
            {/if}
          </span>
        </div>
      {/if}
    {/each}

    {#each conversation.waiting as said (said.id)}
      {@render userMessage(said)}
    {/each}
  </div>
</div>

{#if behind}
  <button class="latest" onclick={toFoot} data-testid="jump-latest">
    <Icon name="down" size={12} />Latest
  </button>
{/if}
</div>

{#snippet userMessage(said: Message)}
  <article
    class="msg you"
    class:waiting={!said.placed}
    class:dropped={said.state === "dropped" || said.state === "failed"}
    data-testid="user-message"
    data-state={said.state}
  >
    <header class="who">
      <b>You</b>
      {#if said.at !== null}<time class="num">{clock(said.at)}</time>{/if}
    </header>
    <div class="bubble">
      {#if said.images.length > 0}
        <div class="images">
          {#each said.images as image, at (at)}
            <img src="data:{image.mediaType};base64,{image.data}" alt="Attached image {at + 1}" />
          {/each}
        </div>
      {/if}
      {#if said.text !== ""}<p>{said.text}</p>{/if}
    </div>
    {#if said.state === "queued"}
      <p class="state" data-testid="message-waiting">Waiting for the agent to finish what it is doing</p>
    {:else if said.state === "sending"}
      <p class="state">Sending</p>
    {:else if said.state === "dropped"}
      <p class="state bad">Not answered{said.error ? `: ${said.error}` : ""}</p>
    {:else if said.state === "failed"}
      <p class="state bad">
        Not sent{said.error ? `: ${said.error}` : ""}
        {#if onPutBack}
          <button class="link" onclick={() => onPutBack(said)} data-testid="put-back">Put back in the composer</button>
        {/if}
      </p>
    {/if}
  </article>
{/snippet}

<style>
  .frame {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 22px 24px 12px;
    outline: none;
  }

  @container conversation (max-width: 520px) {
    .frame .thread {
      padding: 16px 14px 10px;
    }

    .you .bubble {
      max-width: 92%;
    }
  }

  .col {
    max-width: 740px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 22px;
    font-size: var(--conv-size);
    line-height: 1.58;
    color: var(--ink);
  }

  .intro {
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-3);
    text-align: center;
  }

  .msg {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .who {
    display: flex;
    align-items: center;
    gap: 7px;
    font-family: var(--chrome);
    font-size: 12px;
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-3);
  }

  .who b {
    font-weight: 600;
    color: var(--ink);
  }

  .num {
    font-variant-numeric: tabular-nums;
  }

  .mark {
    width: 9px;
    height: 9px;
    border-radius: min(3px, var(--radius));
    background: var(--accent);
  }

  .you {
    align-items: flex-end;
  }

  .bubble {
    max-width: 82%;
    padding: 9px 13px;
    border-radius: calc(var(--radius) * 2) calc(var(--radius) * 2) var(--radius-sm)
      calc(var(--radius) * 2);
    background: var(--accent-soft);
    color: var(--ink);
    user-select: text;
    -webkit-user-select: text;
  }

  .bubble p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .images img {
    max-width: 160px;
    max-height: 120px;
    border-radius: var(--radius-sm);
    object-fit: cover;
  }

  .you.waiting .bubble {
    background: none;
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .you.dropped .bubble {
    opacity: 0.65;
  }

  .state {
    margin: -2px 0 0;
    font-size: 11.5px;
    color: var(--ink-3);
    text-align: right;
  }

  .state.bad {
    color: var(--del);
  }

  .link {
    margin-left: 6px;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }

  .agent {
    padding-left: 16px;
    border-left: 2px solid var(--rule);
  }

  .now {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-2);
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .caret {
    flex: none;
    width: 7px;
    height: 14px;
    border-radius: 2px;
    background: var(--accent);
    animation: breathe 1.1s ease-in-out infinite;
  }

  .outcome {
    margin: 0;
    font-size: 12px;
    color: var(--ink-3);
  }

  .outcome.bad {
    color: var(--del);
  }

  .note {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 0;
    font-size: 12px;
    color: var(--ink-3);
    text-align: center;
  }

  .note.warning {
    color: var(--ink-2);
  }

  .note.error {
    color: var(--del);
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--ink-3);
  }

  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--rule);
  }

  .latest {
    position: absolute;
    left: 50%;
    bottom: 10px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border: 1px solid var(--divider, var(--rule));
    border-radius: 999px;
    background: var(--surface);
    box-shadow: 0 4px 14px color-mix(in srgb, black 14%, transparent);
    font: inherit;
    font-size: 12px;
    color: var(--ink-2);
    cursor: pointer;
    z-index: 2;
  }

  .latest:hover {
    color: var(--ink);
  }

  @keyframes breathe {
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .caret {
      animation: none;
    }
  }
</style>
