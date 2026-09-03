<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";

  // Phase 1 replaces this whole body with an xterm.js instance bound to a PTY
  // Channel. The markup here exists to prove the pane's geometry and colours,
  // and deliberately uses the same ANSI tokens the terminal theme will read.
</script>

<Pane id="agent" title="Agent · Claude Code" meta="not running">
  <div class="term no-select">
    <div class="line"><span class="prompt">&gt;</span> rename the token cache module</div>
    <div class="line"><span class="bullet">⏺</span> Read <span class="path">src/cache/mod.rs</span></div>
    <div class="line"><span class="bullet">⏺</span> Edit <span class="path">src/cache/mod.rs</span></div>
    <div class="line dim"><span class="bullet">│</span> renaming 3 references…</div>
    <div class="line"><span class="cursor">▌</span></div>
    <p class="stub">Phase 0 placeholder. The PTY lands in phase 1.</p>
  </div>
</Pane>

<style>
  .term {
    flex: 1;
    overflow: auto;
    padding: 12px var(--pane-pad);
    font-family: var(--mono);
    font-size: 12px;
    line-height: var(--line-term);
    color: var(--ansi-white);
    background: var(--surface);
  }

  .line {
    white-space: pre-wrap;
  }

  .line.dim {
    color: var(--ink-3);
  }

  .prompt,
  .path,
  .cursor {
    color: var(--ansi-cyan);
  }

  .bullet {
    color: var(--ink-3);
  }

  .stub {
    margin: 18px 0 0;
    font-family: var(--sans);
    font-size: 12px;
    color: var(--ink-3);
  }
</style>
