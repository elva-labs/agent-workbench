<script lang="ts">
  import { tick, untrack } from "svelte";
  import "@xterm/xterm/css/xterm.css";

  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";
  import Pane from "$lib/components/Pane.svelte";
  import Splitter from "$lib/components/Splitter.svelte";
  import TerminalView from "$lib/components/TerminalView.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";
  import {
    DEFAULT,
    MIN,
    applyLayout,
    focusPane,
    hideTerminal,
    layout,
    returnFocus,
    saveLayout,
    terminalVisible,
  } from "$lib/layout.svelte";
  import {
    activeShell,
    byKey,
    closeAsked,
    closeAsking,
    create,
    besideOf,
    equalize,
    groupOf,
    groupsFor,
    groupsOf,
    keepAsked,
    label,
    launch,
    ownerOnScreen,
    resizeSplit,
    select,
    share,
    shortCommand,
    shownFor,
    shownGroup,
    split,
    statusMessage,
    terminals,
    withOwner,
    type Shell,
  } from "$lib/terminals.svelte";
  import { startup } from "$lib/reopen.svelte";
  import { byKey as sessionByKey, label as sessionLabel } from "$lib/sessions.svelte";
  import { projectLabel } from "$lib/workspace.svelte";
  import { sizeOf } from "$lib/zoom.svelte";

  let current = $derived(activeShell());
  let shown = $derived(shownGroup());
  let focused = $derived(layout.focus === "terminal");
  /** Whose shells are listed: the session on screen, else the project. */
  let owner = $derived(ownerOnScreen());
  let groups = $derived(groupsFor(owner));
  /** The project's own groups, listed apart beside a session's. */
  let besideGroups = $derived(groupsOf(besideOf(owner)));
  /** The project on screen, as its own shells' heading names it. */
  let projectName = $derived(owner === null ? "" : projectLabel(owner.project));

  /** The owner as the list names it. */
  let ownerName = $derived.by(() => {
    if (owner === null) return "";
    if (owner.session === null) return projectLabel(owner.project);
    const session = sessionByKey(owner.session);
    return session === null ? "" : sessionLabel(session);
  });

  /** What the shown group divides between its shells. */
  let shellsWidth = $state(0);

  /** Whether anyone is on screen to have shells: false until a project is. */
  let someone = $derived(owner !== null);

  // Asking for the panel is asking for a shell: it opens with one when it
  // has none to list. Only on showing it, or on a project coming on screen
  // under it, and as the window starts only once the sessions that were
  // open are back and the one on screen is chosen, or the shell would go to
  // the project a moment before its session came on screen. Never on
  // switching session or project, where the panel offers one instead, and
  // never as a reaction to a shell going, or one that exits at once would
  // be a loop.
  $effect(() => {
    const visible = terminalVisible();
    const anyone = someone;
    const settled = startup.settled;
    untrack(() => {
      const now = ownerOnScreen();
      if (visible && anyone && settled && now !== null && shownFor(now).length === 0) create(now);
    });
  });

  function another() {
    const now = ownerOnScreen();
    if (now !== null) create(now);
  }

  function beside() {
    if (current !== null) split(current.key);
  }

  let rows = $state<HTMLDivElement | null>(null);

  /** A row picks its shell and puts the keyboard in it, by a click as by
      Enter or Space. A row that had the keyboard lets it go, since the
      shell yields to a control of its own pane. */
  function choose(key: string) {
    select(key);
    const holder = document.activeElement;
    if (holder instanceof HTMLElement && rows?.contains(holder)) holder.blur();
    focusPane("terminal");
  }

  /** Delete closes the shell under the keyboard, as its × does, and the
      keyboard stays on the rows; with the last shell gone, it goes back to
      the pane the panel hands the focus to. A shell with something running
      in it asks first, and the keyboard comes back to the rows once that
      is answered. Only keys reach a row: a click on one puts the keyboard
      in its shell. */
  async function onRowKeydown(e: KeyboardEvent, key: string) {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    if (await closeAsking(key, true)) await backToRows();
  }

  /** The keyboard on the row of the shell in front, or the first, or with
      none left where the panel hands it. */
  async function backToRows() {
    await tick();
    const next =
      rows?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      rows?.querySelector<HTMLElement>('[role="option"]');
    if (next) next.focus();
    else returnFocus();
  }

  let asked = $derived(terminals.asking);
  let askedShell = $derived(asked === null ? null : byKey(asked.key));
  let askStrip = $state<HTMLDivElement | null>(null);

  // A close asked again while the question is up puts the keyboard back on
  // its Cancel, where the answer is.
  $effect(() => {
    if (terminals.askRequests === 0) return;
    untrack(() => askStrip?.querySelector<HTMLElement>("[data-testid='close-shell-cancel']")?.focus());
  });

  // The question goes, closing nothing, with the panel, as the editor's
  // goes when its pane folds.
  $effect(() => {
    if (!terminalVisible() && terminals.asking !== null) untrack(keepAsked);
  });

  let askDetail = $derived.by(() => {
    if (asked === null) return "";
    const [first, ...rest] = asked.running;
    return rest.length === 0
      ? `“${shortCommand(first)}” is still running in it. Closing the shell stops it.`
      : `“${shortCommand(first)}” and ${rest.length}\u00a0more are still running in it. Closing the shell stops them.`;
  });

  /** The question answered: the keyboard goes back to the rows when a key
      there asked, else to the shell in front, or where the panel hands it
      once the last has gone. */
  async function answered(close: boolean) {
    const fromRow = asked?.fromRow ?? false;
    if (close) closeAsked();
    else keepAsked();
    if (fromRow) await backToRows();
    else returnFocus();
  }

  /** Whether this shell has a neighbour on its left in the shown group. */
  function afterFirst(shell: Shell) {
    return shell.group === shown && groupOf(shell.key)[0] !== shell;
  }

  function resizeList(dx: number) {
    layout.terminalList = Math.max(MIN.terminalList, layout.terminalList - dx);
    applyLayout(layout.width, layout.height);
  }

  function resetList() {
    layout.terminalList = DEFAULT.terminalList;
    applyLayout(layout.width, layout.height);
    saveLayout();
  }

  /** A shell as its row and its question name it: the project's own
      beside a session with the project's name. */
  function rowName(shell: Shell): string {
    return besideOf(owner).includes(shell) ? withOwner(shell) : label(shell);
  }

  function dot(shell: Shell) {
    return shell.status === "running" ? "live" : shell.status === "starting" ? "" : "dead";
  }
</script>

{#snippet groupRows(group: Shell[], name: (shell: Shell) => string)}
  <div class="group" class:on={group[0].group === shown} role="group" data-testid="terminal-group">
    {#each group as shell, i (shell.key)}
      <div class="row" class:beside={i > 0} class:on={shell.key === terminals.active}>
        <button
          class="name"
          role="option"
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => choose(shell.key)}
          onkeydown={(e) => onRowKeydown(e, shell.key)}
          aria-selected={shell.key === terminals.active}
          aria-current={shell.key === terminals.active ? "true" : undefined}
          aria-label={name(shell)}
          data-testid="terminal-row"
        >
          <span class="dot {dot(shell)}"></span>
          <span class="label">{label(shell)}</span>
        </button>
        <button
          class="icon"
          onclick={() => split(shell.key)}
          aria-label="Split {name(shell)}"
          title="Split"
          data-testid="split-row">⫿</button
        >
        <button
          class="icon"
          onclick={() => void closeAsking(shell.key)}
          aria-label="Close {name(shell)}"
          title="Close"
          data-testid="close-terminal">×</button
        >
      </div>
    {/each}
  </div>
{/snippet}

<!-- Bare: the header row goes to the shells, and the title sits over the
     list, where the tools are anyway. -->
<Pane id="terminal" title="Terminal" bare>
  <div class="wrap">
    <!-- The list comes before the shells, drawn on their right: a shell
         keeps Tab, so the panel's own controls are reached first. -->
    <nav class="list" style:width="{layout.terminalList}px" aria-label="Terminals">
      <div class="top" data-tauri-drag-region>
        <span class="title" class:on={focused} data-tauri-drag-region>Terminal</span>
        <button
          class="tool"
          onclick={another}
          disabled={owner === null}
          aria-label="New shell"
          title="New shell ({describe(chordFor("terminal.new"))})"
          data-testid="new-terminal">+</button
        >
        <button
          class="tool"
          onclick={beside}
          disabled={current === null}
          aria-label="Split the current shell"
          title="Split"
          data-testid="split-terminal">⫿</button
        >
        <button class="tool" onclick={hideTerminal} data-testid="hide-terminal">hide</button>
      </div>
      {#if owner !== null}
        <p class="owner" title="Shells of {ownerName}" data-testid="terminal-owner">Shells of {ownerName}</p>
      {/if}

      <!-- One row per shell, grouped: the rows under the first of a group are
           the shells beside it. The rows are one stop, walked with the
           arrows. A click, Enter or Space on a row goes to its shell, and
           Delete closes it, as its × does. Beside a session the project's
           own shells follow at the foot, under the project's name. -->
      <div class="rows" role="listbox" aria-label={ownerName === "" ? "Shells" : `Shells of ${ownerName}`} bind:this={rows}>
        {#if groups.length === 0 && besideGroups.length > 0}
          <p class="none" data-testid="terminal-none">None open.</p>
        {/if}
        {#each groups as group (group[0].group)}
          {@render groupRows(group, label)}
        {/each}
        {#if besideGroups.length > 0}
          <div class="foot" role="group" aria-labelledby="terminal-foot" data-testid="terminal-project-shells">
            <p class="owner" id="terminal-foot" title="Shells of {projectName}">Shells of {projectName}</p>
            {#each besideGroups as group (group[0].group)}
              {@render groupRows(group, withOwner)}
            {/each}
          </div>
        {/if}
      </div>
    </nav>

    <Splitter
      label="Resize the terminal list"
      inner
      onDelta={resizeList}
      onReset={resetList}
      onCommit={saveLayout}
    />

    <div class="shells" bind:clientWidth={shellsWidth}>
      <!-- Every shell stays mounted. The shown group's sit side by side in
           flow; the rest are parked underneath, hidden, at their old size. -->
      {#each terminals.all as shell (shell.key)}
        {#if afterFirst(shell)}
          <Splitter
            label="Resize {label(shell)}"
            inner
            onDelta={(dx) => resizeSplit(shell.key, dx, shellsWidth)}
            onReset={() => equalize(shell.key)}
          />
        {/if}
        <div
          class="slot"
          class:on={shell.group === shown}
          class:focused={shell.key === terminals.active && groupOf(shell.key).length > 1}
          class:beside={shell.group === shown && shell.key !== terminals.active && groupOf(shell.key).length > 1}
          class:first={groupOf(shell.key)[0] === shell}
          class:last={groupOf(shell.key).at(-1) === shell}
          style:flex="{share(shell)} 1 0px"
          role="presentation"
          onpointerdown={() => select(shell.key)}
          data-testid="terminal-slot"
        >
          <TerminalView
            id={shell.key}
            ptyId={shell.ptyId}
            active={shell.group === shown}
            shown={terminalVisible()}
            focused={layout.focus === "terminal" && shell.key === terminals.active}
            start={(cols, rows, onOutput) => launch(shell.key, cols, rows, onOutput)}
            fontSize={sizeOf(shell.key)}
            dim={shell.group === shown && shell.key !== terminals.active && groupOf(shell.key).length > 1}
          />
        </div>
      {/each}

      {#if owner === null}
        <div class="overlay" data-testid="terminal-status">
          <p class="message">Open a project to start a shell in.</p>
        </div>
      {:else if current === null}
        <div class="overlay" data-testid="terminal-status">
          <p class="message">{owner.session === null ? "No shell open for this project." : "No shell open for this session."}</p>
          <button onclick={another} data-testid="start-terminal">New shell</button>
        </div>
      {:else if current.status !== "running"}
        <div class="overlay" data-testid="terminal-status">
          <p class="message">{statusMessage(current)}</p>
          {#if current.status !== "starting"}
            <button onclick={another} data-testid="start-terminal">New shell</button>
          {/if}
        </div>
      {/if}

      <!-- Closing a shell with something running in it asks first, over
           the shells, where it is read before what runs under it. -->
      {#if asked !== null && askedShell !== null}
        <div class="ask" bind:this={askStrip} data-testid="close-shell-ask">
          <ConfirmStrip
            question="Close {rowName(askedShell)}?"
            detail={askDetail}
            action="Close shell"
            onConfirm={() => void answered(true)}
            onCancel={() => void answered(false)}
            testid="close-shell"
          />
        </div>
      {/if}
    </div>

  </div>
</Pane>

<style>
  /* The list's top row is a pane header's height, its title's line in the
     middle of it, as every header in the window is. */
  .top {
    --head-pad: calc((var(--head-height) - 1px - var(--title-size) * var(--line-ui)) / 2);
    display: flex;
    align-items: baseline;
    gap: 2px;
    height: var(--head-height);
    padding: var(--head-pad) var(--pane-pad);
    border-bottom: 1px solid var(--head-rule);
    flex: none;
  }

  .title {
    flex: 1;
    min-width: 0;
    font-family: var(--chrome);
    font-size: var(--title-size);
    font-weight: var(--title-weight);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    color: var(--title-color);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .title.on {
    color: var(--accent);
  }

  .tool {
    flex: none;
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--ink-3);
    cursor: pointer;
    padding: 0 5px;
  }

  .tool:hover:not(:disabled) {
    color: var(--accent);
  }

  .tool:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: row-reverse;
    background: var(--clear-surface);
  }

  .shells {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: stretch;
    padding: var(--term-air);
  }

  .slot {
    position: relative;
    min-width: 0;
  }

  /* Parked: out of flow, hidden, and still the size it had. */
  .slot:not(.on) {
    position: absolute;
    inset: 0;
    visibility: hidden;
    pointer-events: none;
  }

  /* Only among siblings does it matter which one has the keyboard: the
     others sit a step toward the ground, the terminal in them drawn on the
     same tone, out to the panel's edges through the room around the
     shells. */
  .slot.on.beside {
    isolation: isolate;
  }

  .slot.on.beside::before {
    content: "";
    position: absolute;
    z-index: -1;
    inset: calc(-1 * var(--term-air-y)) 0;
    background: var(--paint-well);
  }

  .slot.on.beside.first::before {
    left: calc(-1 * var(--term-air-x));
  }

  .slot.on.beside.last::before {
    right: calc(-1 * var(--term-air-x));
  }

  /* The list beside the shells sits a step toward the ground. */
  .list {
    flex: none;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding-bottom: 6px;
    background: var(--paint-well);
  }

  .owner {
    margin: 0;
    padding: 7px var(--row-pad-x) 3px;
    font-family: var(--chrome);
    font-size: 11.5px;
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: none;
  }

  .foot {
    margin-top: 6px;
  }

  .none {
    margin: 0;
    padding: var(--row-pad-y) var(--row-pad-x);
    font-family: var(--chrome);
    font-size: var(--row-size);
    color: var(--ink-3);
  }

  .group {
    padding: 2px 0;
  }

  .group.on {
    background: var(--surface-2);
  }

  .row {
    display: flex;
    align-items: center;
  }

  .row.beside {
    padding-left: 14px;
    position: relative;
  }

  .row.beside::before {
    content: "";
    position: absolute;
    left: 14px;
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--rule);
  }

  .name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    text-align: left;
    padding: var(--row-pad-y) var(--row-pad-x);
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--row-size);
    color: var(--ink-2);
    cursor: pointer;
  }

  .row.on .name {
    color: var(--accent);
  }

  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .dot.dead {
    background: var(--del);
    border-color: var(--del);
  }

  .icon {
    flex: none;
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 13px;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
    opacity: 0;
  }

  .icon:last-child {
    padding-right: 8px;
  }

  .row:hover .icon,
  .row.on .icon,
  .icon:focus-visible {
    opacity: 1;
  }

  .icon:hover {
    color: var(--accent);
  }

  .overlay {
    position: absolute;
    inset: auto 0 0 0;
    z-index: 1;
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px var(--pane-pad);
    border-top: 1px solid var(--rule);
    background: var(--surface-2);
  }

  /* Where the cards let a background through, the second surface is a
     fill let through, laid over the card's paint so this still covers
     what is under it. */
  :global(:root[data-cards]) .overlay {
    background: linear-gradient(var(--surface-2), var(--surface-2)), var(--paint-surface);
  }

  .message {
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-2);
    max-width: 64ch;
  }

  .ask {
    position: absolute;
    inset: 0 0 auto 0;
    z-index: 2;
    padding: 8px 10px;
    border-bottom: 1px solid var(--rule);
    background: var(--paint-surface);
  }

  .overlay button {
    margin-left: auto;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--accent);
    cursor: pointer;
  }
</style>
