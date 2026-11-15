<script lang="ts">
  import Icon from "$lib/components/conversation/Icon.svelte";
  import { letters } from "$lib/giveWay";
  import { focusPane } from "$lib/layout.svelte";
  import type { RunSummary } from "$lib/runSummary";
  import { goTo } from "$lib/workspace.svelte";

  /**
   * Where the run of the workflow a session follows stands, right after the
   * pane's title: a pip for each step, done, live or to come, and the live
   * step in words. It turns to the accent while a round past the limit
   * waits on the user.
   *
   * A popover under it says what stands in each step, each session a way
   * to it, with the rules the orchestrator was given folded at its foot.
   * It shows while the pointer rests on the chip, and is held open by a
   * click or by Enter or Space. Escape, or a press anywhere else, puts it
   * away, and Escape gives the keyboard back to the chip.
   *
   * Where the header is short of room the words give way, cut short and
   * then gone, taking no room once gone, and the pips stay: the header
   * keeps them until its title has gone. The header says when the words
   * have no room, by `data-short` on the chip.
   */
  let { run, rules }: { run: RunSummary; rules: string[] } = $props();

  const id = $props.id();
  let button = $state<HTMLButtonElement | null>(null);
  let holder = $state<HTMLSpanElement | null>(null);
  let popover = $state<HTMLDivElement | null>(null);
  /** Shown while the pointer is over the chip or the popover. */
  let hovered = $state(false);
  /** Held open by a click or a key. */
  let held = $state(false);
  let open = $derived(hovered || held);
  /** Whether the rules are folded out. */
  let showRules = $state(false);
  let at = $state({ left: 0, top: 0, width: 0, height: 0 });
  let enter: ReturnType<typeof setTimeout> | null = null;
  let leave: ReturnType<typeof setTimeout> | null = null;

  const SHOW_AFTER = 350;
  const HIDE_AFTER = 150;
  const WIDTH = 380;
  const EDGE = 12;

  /** Puts the popover under the chip, inside the pane it sits in. */
  function place() {
    if (button === null) return;
    const chip = button.getBoundingClientRect();
    const pane = button.closest(".pane")?.getBoundingClientRect() ?? document.body.getBoundingClientRect();
    const width = Math.min(WIDTH, pane.width - 2 * EDGE);
    const left = Math.max(pane.left + EDGE, Math.min(chip.left, pane.right - EDGE - width));
    const top = chip.bottom + 6;
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
      close();
      return;
    }
    if (!open) place();
    held = true;
  }

  function close() {
    cancelTimers();
    held = false;
    hovered = false;
    showRules = false;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      event.preventDefault();
      close();
      button?.focus();
    }
  }

  /** The keyboard leaving the chip and its popover puts the popover away. */
  function onfocusout(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (next !== null && holder?.contains(next)) return;
    held = false;
  }

  function openSession(key: string) {
    close();
    if (goTo(key)) focusPane("agent");
  }

  // A press outside the chip and its popover puts it away, as does the
  // window changing size under it.
  $effect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && holder?.contains(target)) return;
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
<span
  bind:this={holder}
  class="holder"
  {onkeydown}
  {onfocusout}
  onpointerenter={pointerIn}
  onpointerleave={pointerOut}
>
  <button
    bind:this={button}
    class="chip"
    class:open
    class:waits={run.waits}
    onclick={toggle}
    aria-expanded={open}
    aria-controls={open ? id : undefined}
    aria-label="{run.spoken} Show where the run stands"
    data-keep-room
    data-testid="run-chip"
  >
    <span class="pips" aria-hidden="true" data-testid="run-pips"
      >{#each run.steps as step, index (index)}<i class={step.pip}></i>{/each}</span
    >
    <span class="words" use:letters={run.text} data-keep data-testid="run-words">{run.text}</span>
    <Icon name="down" size={11} />
  </button>
  {#if open}
    <div
      bind:this={popover}
      {id}
      class="popover"
      role="region"
      aria-label="Where the run stands"
      style:left="{at.left}px"
      style:top="{at.top}px"
      style:width="{at.width}px"
      style:max-height="{at.height}px"
      data-testid="run-popover"
    >
      <p class="head">{run.workflow}</p>
      {#each run.steps as step, index (index)}
        <div class="step" class:todo={step.pip === "todo" && step.sessions.length === 0} data-testid="run-step">
          <span class="pip {step.pip}" aria-hidden="true"></span>
          <b>{step.name}</b>
          <span class="standing">
            {#each step.sessions as session, n (n)}
              <span class="piece" data-testid="run-piece"
                ><span class="words-of"
                  >{#if session.round !== null}<span class="round">{session.round}</span>{", "}{/if}<span
                    class:asking={session.doing === "asking"}>{session.doing}</span
                  ></span
                >
                ·
                {#if session.key !== null}<button
                    class="go"
                    onclick={() => openSession(session.key!)}
                    data-testid="run-open">{session.name}</button
                  >{:else}<span class="gone">{session.name}</span>{/if}</span
              >
            {:else}
              <span class="none">{step.skipped ? "skipped" : "nothing yet"}</span>
            {/each}
          </span>
        </div>
      {/each}
      <div class="rules">
        <button
          class="fold"
          aria-expanded={showRules}
          onclick={() => (showRules = !showRules)}
          data-testid="run-rules-toggle"
          ><span class="chev"><Icon name={showRules ? "down" : "chev"} size={11} /></span>The rules the orchestrator was
          given</button
        >
        {#if showRules}
          <ol data-testid="run-rules">
            {#each rules as rule, index (index)}<li>{rule}</li>{/each}
          </ol>
        {/if}
      </div>
    </div>
  {/if}
</span>

<style>
  /* Its own width, kept whole while the header's status gives way: the
     pips, the words and the room around them. */
  .holder {
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
  }

  .chip {
    min-width: 0;
    height: 22px;
    margin-left: 2px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 7px 0 9px;
    border: 0;
    border-radius: calc(var(--radius) * 4);
    background: none;
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    font-family: var(--chrome);
    font-size: var(--meta-size);
    letter-spacing: var(--label-track-fine);
    text-transform: var(--label-case);
    line-height: 1;
    color: var(--ink-2);
    white-space: nowrap;
    cursor: pointer;
  }

  .chip:hover,
  .chip.open {
    background: var(--surface-2);
    color: var(--ink);
  }

  .chip.waits {
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--accent);
  }

  .chip:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }

  .pips {
    flex: none;
    display: flex;
    gap: 3px;
  }

  .pips i,
  .pip {
    width: 12px;
    height: 4px;
    border-radius: min(2px, var(--radius-tag));
    background: var(--rule-strong);
  }

  .pips i.done,
  .pip.done {
    background: var(--ink-3);
  }

  .pips i.live,
  .pip.live {
    background: var(--accent);
  }

  .words {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Words cut to a letter or two say nothing: they go, and the pips stay. */
  .words:global(.cut) {
    visibility: hidden;
  }

  /* With less room than a few letters the words take none, and the gap
     before them goes too. Their text is still measured whole, so the
     header knows the room they want back. */
  .chip:global([data-short]) .words {
    max-width: 0;
    margin-left: -7px;
    visibility: hidden;
  }

  .popover {
    position: fixed;
    z-index: 20;
    box-sizing: border-box;
    overflow-y: auto;
    padding: 11px 12px 12px;
    background: var(--surface);
    border-radius: calc(var(--radius) + 2px);
    box-shadow:
      0 0 0 1px var(--divider, var(--rule)),
      0 12px 32px color-mix(in srgb, black 24%, transparent);
    font-family: var(--chrome);
    font-size: var(--row-size);
    line-height: 1.5;
    color: var(--ink-2);
    text-transform: none;
    letter-spacing: normal;
    white-space: normal;
    cursor: auto;
  }

  .head {
    margin: 0 0 8px;
    font-weight: 600;
    color: var(--ink);
  }

  .step {
    display: grid;
    grid-template-columns: 16px 64px minmax(0, 1fr);
    align-items: baseline;
    column-gap: 6px;
    padding: 3px 0;
  }

  .step .pip {
    width: 10px;
    align-self: center;
  }

  .step b {
    font-weight: 600;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .step.todo b {
    font-weight: 500;
    color: var(--ink-3);
  }

  .standing {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .piece {
    min-width: 0;
  }

  .round {
    color: var(--ink);
  }

  .asking {
    color: var(--accent);
  }

  .none {
    color: var(--ink-3);
  }

  .go {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--accent);
    text-align: start;
    cursor: pointer;
  }

  .go:hover {
    text-decoration: underline;
  }

  .go:focus-visible,
  .fold:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
    border-radius: var(--radius-sm);
  }

  .gone {
    color: var(--ink-2);
  }

  .rules {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--divider, var(--rule));
  }

  .fold {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--ink-2);
    cursor: pointer;
  }

  .fold:hover {
    color: var(--ink);
  }

  .chev {
    display: flex;
    color: var(--ink-3);
  }

  ol {
    margin: 8px 0 0;
    padding-left: 1.4em;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
  }
</style>
