<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";

  import { core } from "$lib/core";
  import { resolveAction } from "$lib/keymap";
  import { layout } from "$lib/layout.svelte";
  import { WriteQueue, buildTheme, tokenReader } from "$lib/terminal";
  import { theme } from "$lib/theme.svelte";

  /**
   * One xterm over one pty. What the pty runs is the caller's business: the
   * agent pane and the terminal panel both mount this and hand it a `start`
   * that spawns their kind of process against the grid the terminal measured.
   */
  interface Props {
    /** The row's key: stable, and what the end-to-end tests look up. */
    id: string;
    /** Null until the process is up, and again once it has gone. */
    ptyId: string | null;
    /** Hidden rather than unmounted: the PTY keeps its size, so a background
        session is never resized and never reflows. */
    active: boolean;
    /** Whether the pane holding this terminal is on screen at all. */
    shown?: boolean;
    /** Whether the keyboard should be here: the pane has focus and this is
        the terminal it means. */
    focused?: boolean;
    /** Spawns the process. True once it is up and the row owns it. */
    start: (cols: number, rows: number, onOutput: (bytes: Uint8Array) => void) => Promise<boolean>;
    /** The process set the terminal's title. */
    onTitle?: (title: string) => void;
  }

  let { id, ptyId, active, shown = true, focused = false, start, onTitle }: Props = $props();

  let host: HTMLDivElement;
  let terminal: Terminal | null = null;
  let fit: FitAddon | null = null;
  let queue: WriteQueue | null = null;
  let observer: ResizeObserver | null = null;

  /** Last size actually sent. Cols and rows are integers, so most pixel
      changes cross no character boundary and need no round trip. */
  let sent = { cols: 0, rows: 0 };

  onMount(() => {
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

    measure();
    queue = new WriteQueue((data) => terminal?.write(data));

    // xterm stops propagation for any key it handles, so Ctrl+D would reach
    // the agent as EOT and never reach the app at all. This asks the focus
    // model first: anything it claims is refused here and left to bubble to
    // the window handler, and everything else is the agent's, untouched.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      return (
        resolveAction(event, {
          focus: layout.focus,
          reviewing: layout.mode === "reviewing",
        }) === null
      );
    });

    terminal.onData((data) => {
      // A write that fails is a process that has gone; the exit event is what
      // reports that, not every keystroke after it.
      if (ptyId !== null) core().write(ptyId, data).catch(() => {});
    });

    terminal.onTitleChange((title) => onTitle?.(title));

    observer = new ResizeObserver(() => measure());
    observer.observe(host);

    // The end-to-end tests read the buffer to check that bytes arriving on the
    // channel actually land on screen; the WebGL renderer draws to a canvas
    // rather than to the DOM. Only ever exposed alongside a fake core.
    if (window.__WORKBENCH_CORE__) {
      const registry = window as unknown as { __WORKBENCH_TERMINALS__?: Record<string, Terminal> };
      registry.__WORKBENCH_TERMINALS__ ??= {};
      registry.__WORKBENCH_TERMINALS__[id] = terminal;
    }

    spawn();

    return () => {
      observer?.disconnect();
      queue?.dispose();
      terminal?.dispose();
      terminal = null;
      // Deliberately does not kill the pty. A row only unmounts because it was
      // closed, and `close()` already stopped it; killing here too would send
      // a second signal against an id that has since been reused. On shutdown
      // the pty master closes with the process and the child sees SIGHUP.
    };
  });

  function measure() {
    if (!fit || !terminal || !active) return;
    try {
      fit.fit();
    } catch {
      // Measured while hidden, where fit has nothing to work with. The next
      // observation will have real numbers.
      return;
    }

    const { cols, rows } = terminal;
    if (cols === sent.cols && rows === sent.rows) return;
    sent = { cols, rows };
    if (ptyId !== null) core().resize(ptyId, cols, rows).catch(() => {});
  }

  async function spawn() {
    if (!terminal) return;
    const up = await start(terminal.cols, terminal.rows, (bytes) => queue?.push(bytes));
    if (!up || !terminal) return;
    sent = { cols: terminal.cols, rows: terminal.rows };
    if (focused && active && shown) terminal.focus();
  }

  // Focus by key or by click on the list lands in the terminal itself, so
  // typing goes where the status bar says it does.
  $effect(() => {
    if (focused && active && shown && terminal) untrack(() => terminal!.focus());
  });

  // Live setter: the TUI recolours without a respawn.
  $effect(() => {
    theme.choice;
    if (!terminal) return;
    untrack(() => {
      terminal!.options.theme = buildTheme(tokenReader(document.documentElement));
    });
  });

  // Coming back into view after being hidden, or after the panes moved, needs
  // a fresh measurement rather than a stale fit.
  $effect(() => {
    active;
    shown;
    layout.width;
    layout.height;
    layout.tree;
    layout.terminal;
    if (active && shown) {
      untrack(() => queueMicrotask(() => measure()));
    }
  });
</script>

<div class="term" class:hidden={!active} bind:this={host} data-testid="terminal" data-session={id}></div>

<style>
  .term {
    position: absolute;
    inset: 0;
    /* xterm gives its canvas layers explicit z-indexes. Without a stacking
       context of its own they join the wrapper's, and paint over the status
       overlay: the button is visible and unclickable. */
    isolation: isolate;
  }

  /* The inset lives on xterm's own element, which is the one the fit addon
     subtracts padding from. The app sizes boxes border-box, so padding on
     the host would be counted as room for rows and the last row would be
     drawn past the bottom edge. */
  .term :global(.xterm) {
    padding: 8px var(--pane-pad);
  }

  .term.hidden {
    visibility: hidden;
    pointer-events: none;
  }

  /* xterm sizes its own rows; keep its scrollbar out of the app's chrome. */
  .term :global(.xterm-viewport) {
    scrollbar-width: thin;
    background: transparent !important;
  }
</style>
