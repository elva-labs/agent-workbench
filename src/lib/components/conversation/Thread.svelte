<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Conversation, Entry, Message } from "$lib/conversation.svelte";
  import { clock, nowDoing, replyMarkdown, speaker, stamps, startedIds, tokens } from "$lib/thread";
  import { reportsShown, spoken, wakeShown } from "$lib/instructions";
  import { sentParts, unsent } from "$lib/mention";
  import { mentionsOf } from "$lib/mentioned.svelte";
  import { sessionName, timeOf, type Sender } from "$lib/senders.svelte";
  import { focusPane } from "$lib/layout.svelte";
  import { goTo } from "$lib/workspace.svelte";
  import Copy from "./Copy.svelte";
  import Icon from "./Icon.svelte";
  import Parts from "./Parts.svelte";
  import Plain from "./Plain.svelte";
  import Started from "./Started.svelte";

  /**
   * The thread: who said what, in the order it happened. The user's words
   * sit to the right in a tinted bubble under "You", and what another
   * session sent sits there too, in a plain bubble under that session's
   * name; the agent's run on the left under its name, down a quiet line at
   * the side. Messages that wait for the agent stand under the thread until
   * a turn takes them. The workbench's own sentence after a started
   * session's prompt is never shown as part of it, only behind a fold.
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
    /** The agent's own name, for a run on its default model. */
    agent: string;
    /** A message that failed to send is taken back into the composer. */
    onPutBack?: (message: Message) => void;
    /** The session that sent a message, or null for the user. */
    sender?: (message: Message) => Sender | null;
    /** What opens a file a message mentions, or null for one the viewer
        does not show. */
    opener?: (path: string) => (() => void) | null;
  }

  let { conversation, root, intro, agent, onPutBack, sender, opener }: Props = $props();

  /** The messages whose workbench sentence stands open. */
  let unfolded = $state<Record<string, boolean>>({});

  function goToSender(from: Sender) {
    if (from.key !== null && goTo(from.key)) focusPane("agent");
  }

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

  let col = $state<HTMLDivElement | null>(null);
  /** When the user last pressed or clicked in the thread: the thread
      growing then is a fold they opened, not something new to follow. */
  let touched = Number.NEGATIVE_INFINITY;

  // Marks new content as come while the user is scrolled up.
  $effect(() => {
    pulse();
    untrack(() => {
      heard();
      if (!pinned) behind = true;
    });
  });

  // Follows the thread's own size while at the foot, so text that is drawn
  // a frame after it arrives, or grows as a whole replaces its pieces, is
  // followed all the same; and the size of the space it is shown in, which
  // shrinks as the dock or the composer under it grows.
  $effect(() => {
    if (col === null || scroller === null) return;
    const scrolled = scroller;
    const inner = col;
    const observer = new ResizeObserver((seen) => {
      heard();
      if (!pinned) return;
      // A fold the user opened in the thread grows it; the space shrinking
      // under it is never the user's doing in the thread.
      const grew = seen.some((entry) => entry.target === inner);
      const shrank = seen.some((entry) => entry.target === scrolled);
      if (shrank || (grew && performance.now() - touched > 400)) toEnd(scrolled);
    });
    observer.observe(col);
    observer.observe(scroller);
    return () => observer.disconnect();
  });

  // What the user sends goes on screen: the thread goes to its foot.
  let lastSent = 0;
  $effect(() => {
    const now = conversation.sentHere;
    untrack(() => {
      if (now > lastSent && scroller !== null) {
        pinned = true;
        behind = false;
        void tick().then(() => {
          if (scroller !== null) toEnd(scroller);
        });
      }
      lastSent = now;
    });
  });

  /** Where the thread last scrolled itself to: a scroll that lands there
      is its own, and says nothing of where the user wants to be. */
  let ownTop = Number.NEGATIVE_INFINITY;

  function toEnd(node: HTMLDivElement) {
    node.scrollTop = node.scrollHeight;
    ownTop = node.scrollTop;
  }

  /** When the user last scrolled the thread themselves: the wheel, a
      touch, a key that scrolls, or the scrollbar. */
  let scrolledBy = Number.NEGATIVE_INFINITY;
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

  /** Where the foot was when the user last scrolled: a scroll can be heard
      only after more has come, and the foot the user scrolled to is then
      short of the foot there is now. */
  let footThen = Number.POSITIVE_INFINITY;

  function userScrolls() {
    scrolledBy = performance.now();
    // From here on a scroll is the user's, wherever it lands.
    ownTop = Number.NEGATIVE_INFINITY;
    if (scroller !== null) footThen = scroller.scrollHeight - scroller.clientHeight;
  }

  /** Where the thread was last heard to be, to tell a scroll down from
      one up. */
  let lastTop = 0;

  /** Takes in where the user has scrolled before the thread moves on its
      own: a browser can tell of a scroll only after more has come. */
  function heard() {
    if (scroller !== null && scroller.scrollTop !== lastTop) onscroll();
  }

  function onscroll() {
    if (scroller === null) return;
    const top = scroller.scrollTop;
    const down = top >= lastTop - 1;
    lastTop = top;
    // Only the user decides whether the thread follows. The thread's own
    // scroll to its foot can be heard after more has come, and the browser
    // moves the view itself to keep its place while text is drawn again;
    // neither is the user leaving the foot.
    if (performance.now() - scrolledBy > 1000) return;
    if (Math.abs(top - ownTop) < 2) return;
    if (scroller.scrollHeight - top - scroller.clientHeight < 32) {
      pinned = true;
      behind = false;
      return;
    }
    // Scrolling down to the foot as it stood when the user scrolled is
    // going back to the foot, and scrolling down never leaves it: either
    // way the thread follows, and goes on to the foot there is now.
    if (down && (pinned || footThen - top < 32)) {
      pinned = true;
      behind = false;
      toEnd(scroller);
      return;
    }
    pinned = false;
  }

  /** What the arrows walk in the thread: its folds, steps and links, in
      the order they stand, while they are drawn. */
  function items(): HTMLElement[] {
    if (col === null) return [];
    return [...col.querySelectorAll<HTMLElement>("[data-thread-item], a[href]")].filter(
      (item) => item.getClientRects().length > 0 && !(item as HTMLButtonElement).disabled,
    );
  }

  /** The thread is one stop for Tab, as a list is. Up and Down move
      through what it holds, from where the keyboard is or, from the thread
      itself, from what is in view; Home and End go to the first and the
      last, and Escape goes back to the composer. The other keys that
      scroll scroll it. */
  function onThreadKey(e: KeyboardEvent) {
    touched = performance.now();
    if (scroller === null) return;
    // Escape gives the keyboard back to the composer, as it does from the
    // palette, when there is one to type in.
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const field = scroller.closest("[data-session]")?.querySelector<HTMLElement>("[data-testid='composer-input']");
      if (field) {
        e.preventDefault();
        e.stopPropagation();
        field.focus();
      }
      return;
    }
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const walk = ["ArrowDown", "ArrowUp"].includes(e.key) || (at !== -1 && ["Home", "End"].includes(e.key));
    if (!walk || all.length === 0 || e.metaKey || e.ctrlKey || e.altKey) {
      if (SCROLL_KEYS.has(e.key)) userScrolls();
      return;
    }
    e.preventDefault();
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = all.length - 1;
    else if (at !== -1) next = Math.max(0, Math.min(all.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
    else {
      const view = scroller.getBoundingClientRect();
      const seen = all.filter((item) => {
        const box = item.getBoundingClientRect();
        return box.bottom > view.top && box.top < view.bottom;
      });
      const pick = e.key === "ArrowDown" ? seen[0] : seen[seen.length - 1];
      next = pick === undefined ? (e.key === "ArrowDown" ? 0 : all.length - 1) : all.indexOf(pick);
    }
    userScrolls();
    all[next].focus({ preventScroll: true });
    all[next].scrollIntoView({ block: "nearest" });
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

  /** The error a session ended with is said where it offers to resume,
      and not again at the foot of the thread. */
  let endedWith = $derived.by(() => {
    if (conversation.ended === null) return null;
    const last = conversation.entries[conversation.entries.length - 1];
    return last?.kind === "note" && last.tone === "error" ? last.key : null;
  });

  function visible(entry: Entry): boolean {
    if (entry.key === endedWith) return false;
    if (entry.kind !== "agent") return true;
    if (entry.parts.length > 0 || entry.key === liveKey) return true;
    const turn = conversation.turns[entry.turn];
    return lastOfTurn.has(entry.key) && (turn?.outcome === "interrupted" || turn?.outcome === "failed");
  }

  /** Where this run began, when its line stands at the top: nothing
      before it is drawn yet, or nothing was found. */
  let beganAtTop = $derived(conversation.began !== null && conversation.began.after === null);

  /** Every time the thread shows, as it writes it, by what it is shown
      on: a message by its id, a run by its key, and the line where this
      run began, which always names its day. */
  let written = $derived.by(() => {
    const keys: string[] = [];
    const times: { at: number; day?: boolean }[] = [];
    const add = (key: string, at: number | null, day = false) => {
      if (at === null) return;
      keys.push(key);
      times.push({ at, day });
    };
    const began = conversation.began;
    if (began !== null && began.after === null) add("began", began.at, true);
    for (const entry of conversation.entries) {
      if (entry.kind === "user") {
        const said = conversation.messages[entry.message];
        if (said !== undefined) add(`m:${said.id}`, said.at ?? timeOf(said.id));
      } else if (entry.kind === "agent" && visible(entry)) add(`e:${entry.key}`, entry.at);
      if (began !== null && began.after === entry.key) add("began", began.at, true);
    }
    for (const said of conversation.waiting) add(`m:${said.id}`, said.at ?? timeOf(said.id));
    const shown = stamps(times);
    return new Map(keys.map((key, at) => [key, shown[at]]));
  });
</script>

<div class="frame">
<!-- One stop for Tab, walked with the arrows; the pointer handlers only
     note that the user acted in the thread. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="thread"
  class:foot={conversation.earlier === "loading" || conversation.earlier === "read"}
  bind:this={scroller}
  {onscroll}
  onpointerdown={(e) => {
    touched = performance.now();
    // A press on the scrollbar itself scrolls.
    if (e.target === scroller) userScrolls();
  }}
  onkeydown={onThreadKey}
  onwheel={userScrolls}
  ontouchmove={userScrolls}
  role="log"
  aria-label="The conversation"
  data-testid="thread"
  tabindex="0"
>
  <div class="col" bind:this={col}>
    {#if conversation.earlierCut}
      <p class="intro" data-testid="earlier-cut">The start of this conversation is too long to show here.</p>
    {/if}
    {#if (conversation.late && conversation.earlier !== "loading") || (intro !== null && conversation.entries.length === 0 && conversation.waiting.length === 0 && conversation.began === null && conversation.earlier !== "loading")}
      <p class="intro" data-testid="thread-intro">
        {conversation.late ? "Earlier messages of this session are in its transcript and are not shown here." : intro}
      </p>
    {/if}
    {#if conversation.earlier === "loading"}
      <p class="now reading" data-testid="earlier-reading"><span class="caret"></span>Reading the earlier messages</p>
    {:else if conversation.earlier === "read" && beganAtTop}
      <p class="note" data-testid="earlier-none">
        <Icon name="info" size={13} />No earlier messages were found for this session.
      </p>
    {/if}
    {#if beganAtTop}
      {@render runBegan()}
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
        <article class="msg agent" data-testid="agent-run" data-turn={entry.turn} data-copy-host="message">
          <header class="who">
            <i class="mark"></i><b><Plain text={speaker(conversation, turn?.model ?? null, agent)} /></b>
            {#if entry.at !== null}<time class="num">{written.get(`e:${entry.key}`) ?? clock(entry.at)}</time>{/if}
            {#if entry.parts.some((part) => part.kind === "text" && part.text.trim() !== "")}
              <Copy label="Copy as Markdown" text={() => replyMarkdown(entry.parts)} host="message" place="end" testid="copy-reply" />
            {/if}
          </header>
          <Parts parts={entry.parts} {root} />
          <Started ids={startedIds(entry.parts)} />
          {#if live && doing !== null}
            <p class="now" data-testid="now"><span class="caret"></span><Plain text={doing} /></p>
          {/if}
          {#if lastOfTurn.has(entry.key) && turn?.outcome === "interrupted"}
            <p class="outcome" data-testid="turn-outcome">Interrupted</p>
          {:else if lastOfTurn.has(entry.key) && turn?.outcome === "failed"}
            <p class="outcome bad" data-testid="turn-outcome">
              The turn failed{#if turn.error}: <Plain text={turn.error} />{:else}.{/if}
            </p>
          {/if}
        </article>
      {:else if entry.kind === "note" && entry.key !== endedWith}
        <p class="note {entry.tone}" data-testid="note">
          <Icon name={entry.tone === "info" ? "info" : "warn"} size={13} /><Plain text={entry.text} />
        </p>
      {:else if entry.kind === "compaction"}
        <div class="divider" data-testid="compaction">
          <span>
            {#if !entry.done}
              Compacting the conversation…
            {:else if entry.failed}
              Not compacted{#if entry.error !== null}: <Plain text={entry.error} />{/if}
            {:else}
              Conversation compacted{entry.reason === "full" ? ", the context was full" : ""}{#if entry.tokensBefore !== null && entry.tokensAfter !== null}<span class="num"> · {tokens(entry.tokensBefore)} → {tokens(entry.tokensAfter)} tokens</span>{/if}
            {/if}
          </span>
        </div>
      {/if}
      {#if conversation.began !== null && entry.key === conversation.began.after}
        {@render runBegan()}
      {/if}
    {/each}

    {#each conversation.waiting as said (said.id)}
      {@render userMessage(said)}
    {/each}
  </div>
</div>

{#if behind}
  <button class="latest" tabindex="0" onclick={toFoot} data-testid="jump-latest">
    <Icon name="down" size={12} />Latest
  </button>
{/if}
</div>

{#snippet runBegan()}
  {#if conversation.began !== null}
    <div class="divider" data-testid="run-began">
      <span>Resumed here, <time class="num">{written.get("began") ?? clock(conversation.began.at)}</time></span>
    </div>
  {/if}
{/snippet}

<!-- A message to the agent: the user's, another session's under its name,
     or the workbench's own, sent to a session that was idle, which says
     what the sessions it started did, each by the name its row has. -->
{#snippet userMessage(said: Message)}
  {@const from = sender?.(said) ?? null}
  {@const at = said.at ?? timeOf(said.id)}
  {@const words = from?.workbench
    ? { text: wakeShown(said.text, sessionName) ?? said.text, instructions: null, reports: null }
    : spoken(said.text, from === null)}
  {@const putBack = from?.workbench ? undefined : onPutBack}
  <article
    class="msg you"
    class:from={from !== null}
    class:waiting={!said.placed}
    class:dropped={said.state === "dropped" || said.state === "failed"}
    data-testid="user-message"
    data-state={said.state}
    data-from={from?.workbench ? "workbench" : from?.id}
    data-copy-host="message"
  >
    <header class="who">
      {#if words.text !== ""}
        <Copy label="Copy" name="Copy the message" text={() => unsent(words.text, mentionsOf(said.id)).draft} host="message" testid="copy-message" />
      {/if}
      {#if from === null}
        <b>You</b>
      {:else}
        <span>From</span><span class="sender" data-testid="message-sender"><Plain text={from.name} /></span>
        {#if from.key !== null}<button class="link go" tabindex="-1" data-thread-item onclick={() => goToSender(from)} data-testid="message-sender-go"
            >Go to it</button
          >{/if}
      {/if}
      {#if at !== null}<time class="num">{written.get(`m:${said.id}`) ?? clock(at)}</time>{/if}
    </header>
    <div class="bubble">
      {#if said.images.length > 0}
        <div class="images">
          {#each said.images as image, at (at)}
            <img src="data:{image.mediaType};base64,{image.data}" alt="Attached image {at + 1}" />
          {/each}
        </div>
      {/if}
      {#if words.text !== ""}<p
          >{#each sentParts(words.text, mentionsOf(said.id)) as part, at (at)}{#if part.path === undefined}<Plain text={part.text} />{:else}{@const open =
                opener?.(part.path) ?? null}{#if open === null}<span class="mention" data-testid="message-mention"
                  ><Plain text={part.text} /></span
                >{:else}<button
                  class="mention link-file"
                  tabindex="-1"
                  data-thread-item
                  title="Open {part.path}"
                  onclick={open}
                  data-testid="message-mention"><Plain text={part.text} /></button
                >{/if}{/if}{/each}</p
        >{/if}
    </div>
    {#if words.reports !== null}
      {@const shown = `${said.id}:reports`}
      <button
        class="link instructions"
        tabindex="-1"
        data-thread-item
        onclick={() => (unfolded[shown] = !unfolded[shown])}
        aria-expanded={unfolded[shown] === true}
        data-testid="workbench-reports">Reports from the workbench</button
      >
      {#if unfolded[shown]}<p class="state reports" data-testid="workbench-reports-text"
          >{reportsShown(words.reports, sessionName)}</p
        >{/if}
    {/if}
    {#if words.instructions !== null}
      <button
        class="link instructions"
        tabindex="-1"
        data-thread-item
        onclick={() => (unfolded[said.id] = !unfolded[said.id])}
        aria-expanded={unfolded[said.id] === true}
        data-testid="workbench-instructions">Instructions from the workbench</button
      >
      {#if unfolded[said.id]}<p class="state" data-testid="workbench-instructions-text">{words.instructions}</p>{/if}
    {/if}
    {#if said.state === "queued"}
      <p class="state" data-testid="message-waiting">Waiting for the agent to finish what it is doing</p>
    {:else if said.state === "sending"}
      <p class="state">Sending</p>
    {:else if said.state === "dropped"}
      <p class="state bad">
        Not answered{#if said.error}: <Plain text={said.error} />{/if}
        {#if putBack}
          <button class="link" tabindex="-1" data-thread-item onclick={() => putBack(said)} data-testid="put-back">Put back in the composer</button>
        {/if}
      </p>
    {:else if said.state === "failed"}
      <p class="state bad">
        Not sent{#if said.error}: <Plain text={said.error} />{/if}
        {#if putBack}
          <button class="link" tabindex="-1" data-thread-item onclick={() => putBack(said)} data-testid="put-back">Put back in the composer</button>
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
  }

  @container conversation (max-width: 520px) {
    .frame .thread {
      padding: 16px 14px 10px;
    }

    .you .bubble {
      max-width: 92%;
    }
  }

  /* A thread that has earlier messages coming or read sits at the pane's
     foot while it is shorter than the pane, so what is read and laid above
     moves nothing under it. */
  .thread.foot {
    display: flex;
    flex-direction: column;
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

  .thread.foot .col {
    width: 100%;
    margin-top: auto;
  }

  .intro {
    margin: 0;
    font-size: var(--conv-small);
    color: var(--ink-2);
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
    font-size: var(--conv-meta);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    color: var(--ink-2);
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

  /* A file the message mentions, in the accent; one the viewer shows
     opens there. */
  .mention {
    color: var(--accent);
  }

  .link-file {
    display: inline;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: inherit;
    white-space: inherit;
    overflow-wrap: inherit;
    cursor: pointer;
  }

  .link-file:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
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

  /* Another session's words: a plain bubble, so they never read as the
     user's own. */
  .you.from .bubble {
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--rule);
  }

  .who .sender {
    font-weight: 600;
    color: var(--ink);
    text-transform: none;
    letter-spacing: normal;
  }

  .who .go {
    margin-left: 0;
  }

  .link.instructions {
    margin: -2px 0 0;
    font-size: var(--conv-fine);
    color: var(--ink-2);
  }

  .link.instructions:hover {
    color: var(--ink);
  }

  .state.reports {
    white-space: pre-line;
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
    font-size: var(--conv-fine);
    color: var(--ink-2);
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
    font-size: var(--conv-small);
    color: var(--ink-2);
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .now.reading {
    justify-content: center;
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
    font-size: var(--conv-meta);
    color: var(--ink-2);
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
    font-size: var(--conv-meta);
    color: var(--ink-2);
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
    font-size: var(--conv-meta);
    color: var(--ink-2);
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
    border-radius: calc(var(--radius) * 4);
    background: var(--surface);
    box-shadow: 0 4px 14px color-mix(in srgb, black 14%, transparent);
    font: inherit;
    font-size: var(--conv-meta);
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
