<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import "@xterm/xterm/css/xterm.css";

  import Pane from "$lib/components/Pane.svelte";
  import { core } from "$lib/core";
  import { WriteQueue, buildTheme, tokenReader } from "$lib/terminal";
  import { theme } from "$lib/theme.svelte";
  import { layout } from "$lib/layout.svelte";
  import { resolveAction } from "$lib/keymap";
  import { project } from "$lib/project.svelte";
  import {
    abandon,
    agent,
    applyDetect,
    projectChanged,
    shouldAutoStart,
    canStart,
    ended,
    failed,
    running,
    starting,
    statusLabel,
    statusMessage,
  } from "$lib/agent.svelte";

  let host: HTMLDivElement;
  let terminal: Terminal | null = null;
  let fit: FitAddon | null = null;
  let queue: WriteQueue | null = null;
  let observer: ResizeObserver | null = null;
  let unlisten: (() => void) | null = null;

  /** Last size actually sent. Cols and rows are integers, so most pixel
      changes cross no character boundary and need no round trip at all. */
  let sent = { cols: 0, rows: 0 };

  onMount(() => {
    const backend = core();

    terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: false,
      fontFamily: getComputedStyle(document.body).getPropertyValue("--mono").trim(),
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: buildTheme(tokenReader(document.documentElement)),
    });

    fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);

    // The GPU renderer where there is one. Software rendering and headless X
    // servers have no context to give, and the DOM renderer is the fallback:
    // slower under a flood of output, identical to look at.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch {
      // DOM renderer it is.
    }

    fit.fit();

    queue = new WriteQueue((data) => terminal?.write(data));

    // Only where a fake core has already been installed, and for the same
    // reason: the end-to-end tests need to read what actually landed in the
    // buffer, and the WebGL renderer draws to a canvas rather than to the DOM.
    if (window.__WORKBENCH_CORE__) {
      (window as unknown as { __WORKBENCH_TERMINAL__?: Terminal }).__WORKBENCH_TERMINAL__ =
        terminal;
    }

    // xterm stops propagation for any key it handles, so Ctrl+D would reach the
    // agent as EOT and never reach the app at all. This asks the focus model
    // first: anything it claims is refused here and left to bubble to the
    // window handler, and everything else is the agent's, untouched.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const action = resolveAction(event, {
        focus: layout.focus,
        reviewing: layout.mode === "reviewing",
      });
      return action === null;
    });

    terminal.onData((data) => {
      if (agent.id) backend.write(agent.id, data);
    });

    observer = new ResizeObserver(() => pushSize());
    observer.observe(host);

    backend
      .detect("claude-code")
      .then((report) =>
        applyDetect(
          report,
          Boolean(window.__WORKBENCH_CORE__ || window.__TAURI_INTERNALS__),
          project.current !== null,
        ),
      )
      .catch((error) => failed(String(error)))
      .finally(() => {
        if (shouldAutoStart(project.current?.path ?? null)) start();
      });

    backend.onSessionEnded(ended).then((off) => (unlisten = off));

    return () => {
      observer?.disconnect();
      queue?.dispose();
      unlisten?.();
      if (agent.id) backend.kill(agent.id);
      terminal?.dispose();
      terminal = null;
    };
  });

  function pushSize() {
    if (!fit || !terminal) return;
    try {
      fit.fit();
    } catch {
      // The pane can be measured while hidden, where fit has nothing to work
      // with. The next observation will have real numbers.
      return;
    }

    const { cols, rows } = terminal;
    if (cols === sent.cols && rows === sent.rows) return;
    sent = { cols, rows };
    if (agent.id) core().resize(agent.id, cols, rows);
  }

  async function start() {
    const root = project.current?.path;
    if (!terminal || !root) return;
    starting();
    terminal.reset();

    try {
      const id = await core().spawn(
        {
          agent: "claude-code",
          project: root,
          cols: terminal.cols,
          rows: terminal.rows,
        },
        (bytes) => queue?.push(bytes),
      );
      running(id, root);
      sent = { cols: terminal.cols, rows: terminal.rows };
      terminal.focus();
    } catch (error) {
      failed(String(error));
    }
  }

  // Opening a project starts an agent in it, once. A workbench whose purpose
  // is running an agent should not open onto a button. What it must never do is
  // restart one that stopped: that is the respawn loop the exit policy forbids.
  $effect(() => {
    const root = project.current?.path ?? null;
    untrack(() => {
      const previousId = agent.id;
      const previousRoot = agent.startedFor;
      projectChanged(root);

      if (previousId !== null && previousRoot !== root) {
        core().kill(previousId);
        abandon(root);
      }
      if (shouldAutoStart(root)) start();
    });
  });

  // Live setter: the TUI recolours without a respawn.
  $effect(() => {
    theme.choice;
    if (!terminal) return;
    untrack(() => {
      terminal!.options.theme = buildTheme(tokenReader(document.documentElement));
    });
  });

  // The pane is hidden rather than unmounted while reviewing in a narrow
  // window, so re-measure when it comes back rather than trusting a stale fit.
  $effect(() => {
    layout.agentHidden;
    layout.width;
    if (!layout.agentHidden) untrack(() => queueMicrotask(pushSize));
  });
</script>

<Pane id="agent" title="Agent · Claude Code" meta={statusLabel()}>
  <div class="wrap">
    <div class="term" bind:this={host} data-testid="terminal"></div>

    {#if agent.status !== "running"}
      <div class="overlay" data-testid="agent-status">
        <p class="message">{statusMessage()}</p>
        {#if agent.path && agent.status === "idle"}
          <p class="path">{agent.path}</p>
        {/if}
        {#if canStart()}
          <button onclick={start} data-testid="start-agent">
            {agent.status === "idle" ? "Start" : "Restart"}
          </button>
        {/if}
      </div>
    {/if}
  </div>
</Pane>

<style>
  .wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--surface);
  }

  .term {
    position: absolute;
    inset: 0;
    padding: 8px var(--pane-pad);
    /* xterm gives its canvas layers explicit z-indexes. Without a stacking
       context of its own they join the wrapper's, and paint over the status
       overlay: the button is visible and unclickable. */
    isolation: isolate;
  }

  /* Sits over the terminal rather than replacing it: the buffer of a crashed
     session is still worth reading, and reset() only happens on restart. */
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

  .message {
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-2);
    max-width: 64ch;
  }

  .path {
    margin: 0;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-3);
  }

  button {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 12px;
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    cursor: pointer;
  }

  /* xterm sizes its own rows; keep its scrollbar out of the app's chrome. */
  .term :global(.xterm-viewport) {
    scrollbar-width: thin;
    background: transparent !important;
  }
</style>
