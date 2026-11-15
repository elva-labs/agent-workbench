<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import {
    FIRST,
    HARMONIES,
    MOST_DOTS,
    READY_MADE,
    TERMINAL_STRENGTH,
    addDot,
    hexToRgb,
    labToRgb,
    moveDot,
    padColour,
    padPixels,
    paintOf,
    readyMadeOf,
    removeDot,
    rgbToHex,
    rgbToLab,
    withHarmony,
    type Appearance,
    type Background,
    type Dot,
  } from "$lib/background";
  import { coloursOf } from "$lib/paletteColours";
  import {
    MORE_CONTRAST,
    PALETTES,
    endPreview,
    previewBackground,
    resolvedTheme,
    setBackground,
    shownBackground,
    theme,
  } from "$lib/theme.svelte";

  /**
   * The background the palette in use keeps, picked on a colour pad.
   *
   * A dot's angle on the pad is its hue and its distance from the centre how
   * much colour; the appearance sets how light it paints. The first dot
   * carries the others while a harmony holds. Dragging a dot, or moving one
   * with the arrow keys, repaints the window as it goes, and what is let go
   * of is kept. The two small windows show it in light and in dark, since
   * one choice serves both.
   */

  /** How far an arrow key moves a dot: degrees of hue and a share of the
      rim, and further with Shift. */
  const STEP = { hue: 5, chroma: 0.05, hueFar: 30, chromaFar: 0.2 };
  /** How long after the last key a move by keyboard is kept. */
  const KEEP_AFTER = 400;

  let shown = $derived(shownBackground());
  let appearance = $derived.by(() => {
    void theme.choice;
    void theme.painted;
    return resolvedTheme();
  });
  let paletteLabel = $derived(
    PALETTES.find((palette) => palette.name === theme.palette)?.label ??
      theme.themes[theme.palette]?.label ??
      theme.palette,
  );
  let ready = $derived(readyMadeOf(shown));
  let terminal = $derived(theme.look === "terminal");
  /** The harmony chosen, and the ready-made. Each row walks its own items
      and chooses as it goes, so it gives them their tab indexes itself:
      one stop for Tab, on the one chosen or else the first. */
  let harmonyAt = $derived(HARMONIES.findIndex((known) => known.name === shown?.harmony));
  let readyAt = $derived(
    shown === null ? 0 : READY_MADE.findIndex((known) => known.name === ready) + 1,
  );

  let pad: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  /** The dot being dragged, or -1. */
  let dragging = $state(-1);
  /** The dot last moved or focused: the one Remove takes away. */
  let chosen = $state(0);
  let chosenAt = $derived(Math.max(0, Math.min(chosen, (shown?.dots.length ?? 1) - 1)));
  /** A word under the pad when a dot is held at the rim. */
  let rim = $state(false);
  let keepTimer: ReturnType<typeof setTimeout> | null = null;

  const moreContrast = typeof window.matchMedia === "function" ? window.matchMedia(MORE_CONTRAST) : null;
  let setAside = $state(moreContrast?.matches ?? false);
  const followContrast = () => (setAside = moreContrast?.matches ?? false);
  moreContrast?.addEventListener?.("change", followContrast);

  onDestroy(() => {
    moreContrast?.removeEventListener?.("change", followContrast);
    if (keepTimer !== null) {
      clearTimeout(keepTimer);
      keep(shownBackground());
    }
    endPreview();
  });

  /** The pad drawn once for each appearance and size. */
  const drawn = new Map<string, ImageData>();

  $effect(() => {
    if (canvas === undefined) return;
    const size = canvas.width;
    const key = `${appearance}:${size}`;
    const context = canvas.getContext("2d");
    if (context === null) return;
    let image = drawn.get(key);
    if (image === undefined) {
      image = context.createImageData(size, size);
      image.data.set(padPixels(size, appearance));
      drawn.set(key, image);
    }
    context.putImageData(image, 0, 0);
  });

  const percent = (value: number) => `${Math.round(value * 100)}%`;

  /** A first dot: the palette's own hue, well into the pad. */
  function first(dot: Dot = accentDot()): Background {
    return {
      dots: [dot],
      harmony: "single",
      strength: shown?.strength ?? FIRST.strength,
      grain: shown?.grain ?? FIRST.grain,
    };
  }

  function accentDot(): Dot {
    const [, a, b] = rgbToLab(hexToRgb(coloursOf(theme.palette, appearance, theme.themes).accent));
    return { hue: (Math.round((Math.atan2(b, a) * 180) / Math.PI) + 360) % 360, chroma: 0.8 };
  }

  /** Repaints the window with a background without keeping it. */
  function show(background: Background | null) {
    previewBackground(background);
  }

  /** Keeps a background with the palette, or none. */
  function keep(background: Background | null) {
    if (keepTimer !== null) clearTimeout(keepTimer);
    keepTimer = null;
    setBackground(background);
  }

  /** Shows a background at once and keeps it once the keys rest. */
  function keepSoon(background: Background) {
    show(background);
    if (keepTimer !== null) clearTimeout(keepTimer);
    keepTimer = setTimeout(() => keep(shownBackground()), KEEP_AFTER);
  }

  /** Where on the pad a pointer is, as a dot, held inside the rim. */
  function dotAt(event: PointerEvent): Dot {
    const box = pad.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    const distance = Math.hypot(x, y) * 2;
    rim = distance > 1.02;
    return { hue: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, chroma: Math.min(1, distance) };
  }

  async function focusDot(index: number) {
    await tick();
    const dot = pad.querySelector<HTMLElement>(`[data-testid="background-dot"][data-index="${index}"]`);
    (dot ?? pad).focus({ preventScroll: true });
  }

  function down(event: PointerEvent) {
    if (event.button !== 0) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-testid='background-dot']");
    const at = dotAt(event);
    if (target !== null) {
      dragging = Number(target.dataset.index);
    } else if (shown === null) {
      dragging = 0;
      show(first(at));
    } else {
      dragging = 0;
      show(moveDot(shown, 0, at));
    }
    chosen = dragging;
    pad.setPointerCapture(event.pointerId);
    event.preventDefault();
    void focusDot(dragging);
  }

  function move(event: PointerEvent) {
    if (dragging < 0 || shown === null) return;
    show(moveDot(shown, dragging, dotAt(event)));
  }

  function up() {
    if (dragging < 0) return;
    dragging = -1;
    rim = false;
    keep(shownBackground());
  }

  function dotKeys(event: KeyboardEvent, index: number) {
    if (shown === null) return;
    const dot = shown.dots[index];
    const far = event.shiftKey;
    let next: Background | null = null;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const step = (far ? STEP.hueFar : STEP.hue) * (event.key === "ArrowLeft" ? -1 : 1);
        next = moveDot(shown, index, { ...dot, hue: dot.hue + step });
        rim = false;
        break;
      }
      case "ArrowUp":
      case "ArrowDown": {
        const step = (far ? STEP.chromaFar : STEP.chroma) * (event.key === "ArrowDown" ? -1 : 1);
        rim = event.key === "ArrowUp" && dot.chroma >= 1;
        next = moveDot(shown, index, { ...dot, chroma: Math.round((dot.chroma + step) * 100) / 100 });
        break;
      }
      case "Delete":
      case "Backspace":
        event.preventDefault();
        remove(index);
        return;
      case "+":
      case "=":
        event.preventDefault();
        add();
        return;
      default:
        return;
    }
    event.preventDefault();
    chosen = index;
    keepSoon(next);
  }

  function padKeys(event: KeyboardEvent) {
    if (event.target !== pad || shown !== null) return;
    if (event.key === "Enter" || event.key === " " || event.key === "+" || event.key === "=") {
      event.preventDefault();
      add();
    }
  }

  function add() {
    if (shown === null) {
      keep(first());
      chosen = 0;
    } else {
      const added = addDot(shown);
      keep(added);
      chosen = added.dots.length - 1;
    }
    void focusDot(chosen);
  }

  function remove(index = chosenAt) {
    if (shown === null) return;
    const left = removeDot(shown, index);
    keep(left);
    chosen = Math.max(0, Math.min(index, (left?.dots.length ?? 1) - 1));
    void focusDot(left === null ? -1 : chosen);
  }

  function harmony(name: (typeof HARMONIES)[number]["name"]) {
    keep(withHarmony(shown ?? first(), name));
  }

  function readyMade(name: string | null) {
    const found = READY_MADE.find((known) => known.name === name);
    if (found === undefined) {
      keep(null);
      return;
    }
    keep({
      dots: found.dots.map((dot) => ({ ...dot })),
      harmony: found.harmony,
      strength: shown?.strength ?? FIRST.strength,
      grain: shown?.grain ?? FIRST.grain,
    });
  }

  function slide(field: "strength" | "grain", event: Event, kept: boolean) {
    if (shown === null) return;
    const value = Number((event.target as HTMLInputElement).value) / 100;
    const next = { ...shown, [field]: value };
    if (kept) keep(next);
    else show(next);
  }

  /** The arrows walk a row of choices and choose as they go, as a row of
      radio buttons does; Home and End reach its ends. */
  function walk(event: KeyboardEvent, at: number, count: number, choose: (index: number) => void) {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    let next: number;
    if (step !== undefined) next = (Math.max(at, 0) + step + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else return;
    event.preventDefault();
    choose(next);
    const row = (event.currentTarget as HTMLElement).closest("[role='radiogroup']");
    void tick().then(() => row?.querySelectorAll<HTMLElement>("[role='radio']")[next]?.focus());
  }

  /** A row of colours as a swatch shows them. */
  function swatch(dots: Dot[]): string {
    const colours = dots.map((dot) => padColour(dot, appearance));
    return colours.length === 1 ? colours[0] : `linear-gradient(135deg, ${colours.join(", ")})`;
  }

  /** A small window in one appearance, as the background paints it. */
  function mini(background: Background | null, look: "modern" | "terminal", at: Appearance) {
    const colours = coloursOf(theme.palette, at, theme.themes);
    if (background === null) {
      return { colours, grounds: null, gradient: null, text: colours };
    }
    const painted = paintOf(background, look, colours);
    const tones = painted.colours.map((lab) => rgbToHex(labToRgb(lab)));
    const gradient = tones.length === 1 ? tones[0] : `linear-gradient(160deg, ${tones.join(", ")})`;
    return { colours, grounds: painted.grounds, gradient, text: { ...colours, ...painted.text } };
  }

  function layer(ground: string | undefined, gradient: string | null, plain: string): string {
    if (gradient === null || ground === undefined) return plain;
    return `linear-gradient(${ground}, ${ground}), ${gradient}`;
  }
</script>

<div class="picker" class:off={shown === null} data-testid="background-picker">
  <div class="left">
    <!-- The pad is a widget: it takes the pointer anywhere on it, and with
         no colour on it, the keyboard, to place the first. The dots in it
         are its sliders. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="pad"
      bind:this={pad}
      role="group"
      aria-label="Background colours"
      tabindex={shown === null ? 0 : -1}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      onkeydown={padKeys}
      data-testid="background-pad"
    >
      <canvas bind:this={canvas} width="320" height="320" aria-hidden="true"></canvas>
      {#if shown === null}
        <span class="hint">Click to place a colour</span>
      {:else}
        {#each shown.dots as dot, index (index)}
          <div
            class="dot"
            class:first={index === 0}
            class:held={dragging === index}
            class:chosen={shown.dots.length > 1 && chosenAt === index}
            role="slider"
            tabindex="0"
            aria-label="Colour {index + 1} of {shown.dots.length}"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(dot.chroma * 100)}
            aria-valuetext="hue {Math.round(dot.hue)} degrees, {percent(dot.chroma)} colour"
            style:left="{50 + Math.cos((dot.hue * Math.PI) / 180) * dot.chroma * 50}%"
            style:top="{50 + Math.sin((dot.hue * Math.PI) / 180) * dot.chroma * 50}%"
            style:background={padColour(dot, appearance)}
            onkeydown={(event) => dotKeys(event, index)}
            onfocus={() => (chosen = index)}
            onblur={() => {
              if (keepTimer !== null) keep(shownBackground());
            }}
            data-testid="background-dot"
            data-index={index}
          ></div>
        {/each}
      {/if}
    </div>
    <div class="dots-tools">
      <button
        type="button"
        class="tool"
        onclick={add}
        disabled={shown !== null && shown.dots.length >= MOST_DOTS}
        aria-label="Add a colour"
        title="Add a colour"
        data-testid="background-add">+</button
      >
      <!-- The minus shows the colour it takes away. -->
      <button
        type="button"
        class="tool"
        class:with-chip={shown !== null}
        onclick={() => remove()}
        disabled={shown === null}
        aria-label="Remove colour {chosenAt + 1}"
        title="Remove this colour"
        data-testid="background-remove"
        >−{#if shown !== null}<span class="chip-mini" style:background={padColour(shown.dots[chosenAt], appearance)}
          ></span>{/if}</button
      >
      <span class="word" data-testid="background-word">
        {#if rim}
          Held at the rim: more colour would make text hard to read.
        {:else if shown !== null && shown.harmony === "free" && shown.dots.length > 1}
          Free: each colour moves on its own.
        {:else if shown !== null && shown.dots.length > 1}
          Minus takes away the marked colour.
        {/if}
      </span>
    </div>
    <div class="minis" aria-hidden="true">
      {#each ["light", "dark"] as const as at (at)}
        {@const m = mini(shown, terminal ? "terminal" : "modern", at)}
        <div class="mini-wrap">
          {#if terminal}
            <div class="mini" style:background={layer(m.grounds?.frame, m.gradient, m.colours.bg)}>
              <i class="box side" style:background={m.colours.surface} style:border-color={m.colours.rule}></i>
              <i class="box main" style:background={m.colours.surface} style:border-color={m.colours.accent}></i>
              <b style:left="27px" style:top="10px" style:width="28px" style:background={m.colours["ink-3"]}></b>
              <b style:left="27px" style:top="16px" style:width="40px" style:background={m.colours["ink-2"]}></b>
              <i class="status" style:background={layer(m.grounds?.status, m.gradient, m.colours["surface-2"])}></i>
              <b style:left="4px" style:bottom="2px" style:width="16px" style:background={m.text.accent}></b>
            </div>
          {:else}
            <div class="mini" style:background={m.colours.surface}>
              <i class="side" style:background={layer(m.grounds?.side, m.gradient, m.colours.bg)}></i>
              <i class="head" style:background={layer(m.grounds?.surf, m.gradient, m.colours.surface)}></i>
              <i class="status" style:background={layer(m.grounds?.status, m.gradient, m.colours.surface)}></i>
              <b style:left="4px" style:top="13px" style:width="14px" style:background={m.text.ink}></b>
              <b style:left="4px" style:top="19px" style:width="11px" style:background={m.text["ink-3"]}></b>
              <b style:left="28px" style:top="4px" style:width="20px" style:background={m.text.accent}></b>
              <b style:left="28px" style:top="16px" style:width="46px" style:background={m.colours["ink-2"]}></b>
              <b style:left="28px" style:top="22px" style:width="54px" style:background={m.colours.ink}></b>
            </div>
          {/if}
          <span class="mini-label">{at === "light" ? "Light" : "Dark"}</span>
        </div>
      {/each}
    </div>
  </div>

  <div class="right">
    <div class="row">
      <span class="what">Harmony</span>
      <div class="seg" role="radiogroup" aria-label="Harmony">
        {#each HARMONIES as known, index (known.name)}
          <button
            type="button"
            role="radio"
            aria-checked={shown?.harmony === known.name}
            class:on={shown?.harmony === known.name}
            tabindex={index === Math.max(harmonyAt, 0) ? 0 : -1}
            onclick={() => harmony(known.name)}
            onkeydown={(event) => walk(event, harmonyAt, HARMONIES.length, (next) => harmony(HARMONIES[next].name))}
            data-testid="harmony-{known.name}">{known.label}</button
          >
        {/each}
      </div>
    </div>
    <div class="row top">
      <span class="what">Ready-made</span>
      <div class="swatches" role="radiogroup" aria-label="Ready-made backgrounds">
        <button
          type="button"
          class="swatch"
          role="radio"
          aria-checked={shown === null}
          class:on={shown === null}
          tabindex={readyAt <= 0 ? 0 : -1}
          onclick={() => readyMade(null)}
          onkeydown={(event) =>
            walk(event, readyAt, READY_MADE.length + 1, (next) => readyMade(next === 0 ? null : READY_MADE[next - 1].name))}
          data-testid="ready-none"
        >
          <span class="chip none"></span>None
        </button>
        {#each READY_MADE as known, index (known.name)}
          <button
            type="button"
            class="swatch"
            role="radio"
            aria-checked={ready === known.name}
            class:on={ready === known.name}
            tabindex={readyAt === index + 1 ? 0 : -1}
            onclick={() => readyMade(known.name)}
            onkeydown={(event) =>
              walk(event, readyAt, READY_MADE.length + 1, (next) => readyMade(next === 0 ? null : READY_MADE[next - 1].name))}
            data-testid="ready-{known.name}"
          >
            <span class="chip" style:background={swatch(known.dots)}></span>{known.label}
          </button>
        {/each}
      </div>
    </div>
    <div class="row">
      <label class="what" for="background-strength">Strength</label>
      <input
        id="background-strength"
        type="range"
        min="10"
        max="100"
        step="5"
        value={Math.round((shown?.strength ?? FIRST.strength) * 100)}
        style:--fill="{((shown?.strength ?? FIRST.strength) * 100 - 10) / 0.9}%"
        disabled={shown === null}
        oninput={(event) => slide("strength", event, false)}
        onchange={(event) => slide("strength", event, true)}
        data-testid="background-strength"
      />
      <span class="value"
        >{percent(shown?.strength ?? FIRST.strength)}{#if terminal && shown !== null && shown.strength > TERMINAL_STRENGTH}<em
            >, held at {percent(TERMINAL_STRENGTH)} here</em
          >{/if}</span
      >
    </div>
    <div class="row">
      <label class="what" for="background-grain">Grain</label>
      <input
        id="background-grain"
        type="range"
        min="0"
        max="100"
        step="5"
        value={Math.round((shown?.grain ?? FIRST.grain) * 100)}
        style:--fill="{(shown?.grain ?? FIRST.grain) * 100}%"
        disabled={shown === null || terminal}
        oninput={(event) => slide("grain", event, false)}
        onchange={(event) => slide("grain", event, true)}
        data-testid="background-grain"
      />
      <span class="value">
        {#if terminal}<em>None in this look</em>{:else}{percent(shown?.grain ?? FIRST.grain)}{/if}
      </span>
    </div>
    <p class="note" data-testid="background-note">
      Kept with {paletteLabel}, for light and dark alike. Text on it always stays easy to read.
      {#if setAside}
        Off while the system asks for more contrast.
      {/if}
    </p>
  </div>
</div>

<style>
  .picker {
    max-width: 664px;
    display: grid;
    grid-template-columns: 160px minmax(0, 1fr);
    gap: 20px;
    align-items: start;
  }

  .left {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* The pad: hue around it, colour out to the rim. It takes the pointer
     anywhere on it, and a click away from the dots moves the first one. */
  .pad {
    position: relative;
    width: 160px;
    height: 160px;
    border-radius: 50%;
    touch-action: none;
    cursor: crosshair;
    outline: none;
  }

  .pad canvas {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    box-shadow: 0 0 0 1px var(--rule-strong);
  }

  .pad:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .picker.off .pad canvas {
    opacity: 0.55;
  }

  .hint {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 0 28px;
    text-align: center;
    font-size: 12px;
    color: var(--ink);
    text-shadow: 0 0 6px var(--surface), 0 0 2px var(--surface);
    pointer-events: none;
  }

  /* A dot: white ringed in a hairline of shadow, so it shows on any hue.
     The first, which carries the others, is a size larger. */
  .dot {
    position: absolute;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow:
      0 0 0 2px #ffffff,
      0 0 0 3px color-mix(in srgb, black 35%, transparent),
      0 2px 6px color-mix(in srgb, black 30%, transparent);
    cursor: grab;
  }

  .dot.first {
    width: 20px;
    height: 20px;
  }

  .dot.held {
    cursor: grabbing;
  }

  /* The colour the minus takes away, when there is a choice, is marked
     with a white centre; a ring is focus's alone. */
  .dot.chosen::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    background: #ffffff;
    box-shadow: 0 0 0 1px color-mix(in srgb, black 35%, transparent);
  }

  .dot:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
  }

  .dots-tools {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    min-height: 34px;
  }

  .tool {
    flex: none;
    width: 24px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-2);
    font-family: var(--chrome);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .tool.with-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    width: auto;
    padding: 0 6px;
  }

  .chip-mini {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-tag);
    box-shadow: 0 0 0 1px color-mix(in srgb, black 25%, transparent);
  }

  .tool:hover:not(:disabled) {
    color: var(--ink);
    background: var(--surface-2);
  }

  .tool:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .word {
    padding: 2px 0 0 4px;
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--ink-3);
  }

  .minis {
    display: flex;
    gap: 8px;
  }

  .mini-wrap {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .mini {
    position: relative;
    width: 76px;
    height: 48px;
    overflow: hidden;
    border-radius: var(--radius-sm);
    box-shadow: 0 0 0 1px var(--rule-strong);
  }

  .mini i,
  .mini b {
    position: absolute;
    display: block;
  }

  .mini .side {
    left: 0;
    top: 0;
    bottom: 6px;
    width: 22px;
  }

  .mini .head {
    left: 22px;
    right: 0;
    top: 0;
    height: 10px;
  }

  .mini .status {
    left: 0;
    right: 0;
    bottom: 0;
    height: 6px;
  }

  .mini .box {
    top: 3px;
    bottom: 9px;
    border: 1px solid;
  }

  .mini .box.side {
    left: 3px;
    width: 17px;
  }

  .mini .box.main {
    left: 22px;
    right: 3px;
  }

  .mini b {
    height: 2px;
    border-radius: 1px;
  }

  .mini-label {
    font-size: 11px;
    color: var(--ink-3);
  }

  .right {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 2px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .row.top {
    align-items: flex-start;
  }

  .row.top .what {
    padding-top: 5px;
  }

  .what {
    flex: 0 0 76px;
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: var(--label-track);
    text-transform: var(--label-case);
    color: var(--ink-3);
    white-space: nowrap;
  }

  .seg {
    display: inline-flex;
    flex-wrap: wrap;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .seg button {
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 10px;
    border: 0;
    border-right: 1px solid var(--rule);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .seg button:last-of-type {
    border-right: 0;
  }

  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .swatch {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    padding: 4px 10px 4px 8px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .swatch.on {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }

  .chip {
    width: 14px;
    height: 10px;
    border-radius: var(--radius-tag);
    flex: none;
  }

  /* None: an empty chip struck through. */
  .chip.none {
    box-shadow: inset 0 0 0 1px var(--rule-strong);
    background: linear-gradient(
      135deg,
      transparent 44%,
      var(--rule-strong) 44%,
      var(--rule-strong) 56%,
      transparent 56%
    );
  }

  input[type="range"] {
    flex: 1;
    max-width: 240px;
    height: 18px;
    margin: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }

  input[type="range"]::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(
      to right,
      var(--accent) 0 var(--fill),
      var(--rule-strong) var(--fill) 100%
    );
  }

  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -5px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow:
      0 0 0 1px var(--rule-strong),
      0 1px 3px color-mix(in srgb, black 25%, transparent);
  }

  input[type="range"]::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: var(--rule-strong);
  }

  input[type="range"]::-moz-range-progress {
    height: 4px;
    border-radius: 2px;
    background: var(--accent);
  }

  input[type="range"]::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border: 0;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--rule-strong);
  }

  input[type="range"]:focus-visible {
    outline: none;
  }

  input[type="range"]:focus-visible::-webkit-slider-thumb {
    box-shadow: 0 0 0 2px var(--accent);
  }

  input[type="range"]:disabled {
    opacity: 0.45;
  /* A contrast theme leaves out the colours a slider is drawn with here,
     so the system draws the sliders itself. */
  @media (forced-colors: active) {
    input[type="range"],
    input[type="range"]::-webkit-slider-runnable-track,
    input[type="range"]::-webkit-slider-thumb {
      appearance: auto;
      -webkit-appearance: auto;
    }
  }

    cursor: default;
  }

  .value {
    min-width: 40px;
    font-size: 12px;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .value em {
    font-style: normal;
    color: var(--ink-3);
  }

  .note {
    margin: 2px 0 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
  }

  /* The terminal look squares what the modern look rounds. */
  :global(:root:not([data-look])) .tool,
  :global(:root:not([data-look])) .mini {
    border-radius: 0;
  }

  :global(:root:not([data-look])) input[type="range"]::-webkit-slider-runnable-track {
    height: 2px;
    border-radius: 0;
  }

  :global(:root:not([data-look])) input[type="range"]::-webkit-slider-thumb {
    width: 8px;
    height: 14px;
    margin-top: -6px;
    border-radius: 0;
    box-shadow: 0 0 0 1px var(--accent);
  }

  /* The thumb already has an accent edge at rest, so focus rings it again,
     square and a step off. */
  :global(:root:not([data-look])) input[type="range"]:focus-visible::-webkit-slider-thumb {
    box-shadow:
      0 0 0 1px var(--accent),
      0 0 0 3px var(--surface),
      0 0 0 4px var(--accent);
  }
</style>
