<script module lang="ts">
  /** The pad drawn once for each appearance and size, for as long as the
      window is open: every pixel of it is a colour worked out on the way. */
  const drawn = new Map<string, ImageData>();
</script>

<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import {
    FIRST,
    HARMONIES,
    LEAST_CONTRAST,
    LEAST_STRENGTH,
    MOST_CARDS,
    MOST_DOTS,
    READY_MADE,
    addDot,
    hexToRgb,
    deepOf,
    labToRgb,
    lowestText,
    moveDot,
    padColour,
    padPixels,
    readyMadeOf,
    removeDot,
    rgbToHex,
    rgbToLab,
    strengthAt,
    strengthPercent,
    withHarmony,
    type Appearance,
    type Background,
    type Dot,
    type Lab,
  } from "$lib/background";
  import { paintedOf } from "$lib/backgroundPaint";
  import { coloursOf } from "$lib/paletteColours";
  import {
    MORE_CONTRAST,
    PALETTES,
    endPreview,
    previewBackground,
    resolvedTheme,
    setBackground,
    setCards,
    shownBackground,
    shownCards,
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
   * one choice serves both. Cards says how far the panes let it through as
   * well, from none to the most they show. Where the colours leave text on
   * them, or a terminal colour on the panes, under 4.5:1, a line under the
   * controls says so; nothing is held back.
   */

  /** Where the Strength slider starts: the least strength kept, along
      the even scale. */
  const LEAST_PLACE = strengthPercent(LEAST_STRENGTH);

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
  /** A word under the pad when the pointer goes past the rim. */
  let rim = $state(false);
  let keepTimer: ReturnType<typeof setTimeout> | null = null;

  const moreContrast = typeof window.matchMedia === "function" ? window.matchMedia(MORE_CONTRAST) : null;
  let setAside = $state(moreContrast?.matches ?? false);
  const followContrast = () => (setAside = moreContrast?.matches ?? false);
  moreContrast?.addEventListener?.("change", followContrast);

  let cards = $derived.by(() => {
    void theme.preview;
    void theme.cards;
    return shownCards();
  });
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  /** A cards' share as the slider reads it: how far along its range. */
  const cardsPercent = (share: number) => percent(share / MOST_CARDS);

  /** What the background paints in each appearance, in the look on
      screen, for the small windows and the words under the controls. */
  let paints = $derived.by(() => {
    if (shown === null) return null;
    const look = terminal ? "terminal" : "modern";
    const share = setAside ? 0 : cards;
    const at = (which: Appearance) => paintedOf(shown!, look, coloursOf(theme.palette, which, theme.themes), share);
    return { light: at("light"), dark: at("dark") };
  });

  /** The appearances where something reads under 4.5:1, in words. */
  function whereIn(appearances: Appearance[]): string {
    return appearances.length === 2 ? "in light and dark" : `in ${appearances[0]}`;
  }
  const BOTH: Appearance[] = ["light", "dark"];
  /** Text on the chrome the colours leave under 4.5:1: the lowest it
      reads at, and where. */
  let lowText = $derived.by(() => {
    if (paints === null || setAside) return null;
    const low = BOTH.filter((at) => lowestText(paints![at]) < LEAST_CONTRAST - 0.005);
    if (low.length === 0) return null;
    const lowest = Math.min(...low.map((at) => lowestText(paints![at])));
    return `Text on it reads at ${lowest.toFixed(1)} to 1 ${whereIn(low)}, under the 4.5 to 1 that reads easily.`;
  });
  /** What reads poorly on the panes at the share asked, in words. */
  let lowCards = $derived.by(() => {
    if (paints === null || setAside || cards === 0) return null;
    const terminalLow = BOTH.filter((at) => paints![at].cards?.poor === "terminal");
    const groundLow = BOTH.filter((at) => paints![at].cards?.poor === "ground");
    const said = [
      ...(terminalLow.length > 0 ? [`A terminal colour on the panes reads under 4.5 to 1 ${whereIn(terminalLow)}.`] : []),
      ...(groundLow.length > 0 ? [`The panes barely stand off the window around them ${whereIn(groundLow)}.`] : []),
    ];
    return said.length === 0 ? null : said.join(" ");
  });

  onDestroy(() => {
    moreContrast?.removeEventListener?.("change", followContrast);
    drop();
    if (keepTimer !== null) {
      clearTimeout(keepTimer);
      keep(shownBackground());
    }
    endPreview();
  });

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
    drop();
    previewBackground(background);
  }

  /** What a drag or a slider has reached since the last frame, painted
      once at the next one however many moves arrive before it, so the
      window keeps up with the pointer and lands where it is. */
  let waiting: { background: Background | null; cards?: number } | null = null;
  let frame = 0;

  /** The background as the last move left it, painted or still waiting. */
  function latest(): Background | null {
    return waiting === null ? shown : waiting.background;
  }

  /** Paints a background, and a share of the cards, at the next frame. */
  function showSoon(background: Background | null, cards?: number) {
    waiting = { background, cards: cards ?? waiting?.cards };
    if (frame === 0) frame = requestAnimationFrame(flush);
  }

  /** Paints what is waiting, at the frame it waited for. */
  function flush() {
    frame = 0;
    const step = waiting;
    waiting = null;
    if (step !== null) previewBackground(step.background, step.cards);
  }

  /** Forgets what is waiting, for a step that paints in its place. */
  function drop() {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    waiting = null;
  }

  /** Keeps a background with the palette, or none. */
  function keep(background: Background | null) {
    drop();
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
    const from = latest();
    if (dragging < 0 || from === null) return;
    showSoon(moveDot(from, dragging, dotAt(event)));
  }

  function up() {
    if (dragging < 0) return;
    const reached = latest();
    dragging = -1;
    rim = false;
    keep(reached);
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
    const from = latest();
    if (from === null) return;
    const place = Number((event.target as HTMLInputElement).value) / 100;
    const next = { ...from, [field]: field === "strength" ? strengthAt(place) : place };
    if (kept) keep(next);
    else showSoon(next);
  }

  function slideCards(event: Event, kept: boolean) {
    const from = latest();
    if (from === null) return;
    const value = Number((event.target as HTMLInputElement).value) / 100;
    if (kept) {
      drop();
      setCards(value);
    } else showSoon(from, value);
  }

  /** Shift with an arrow moves a slider a tenth of its range, as Page Up
      and Page Down do; the arrows alone move it a step. */
  function farStep(event: KeyboardEvent) {
    if (!event.shiftKey) return;
    const way = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
    if (way === undefined) return;
    event.preventDefault();
    const input = event.currentTarget as HTMLInputElement;
    const [least, most] = [Number(input.min), Number(input.max)];
    const far = Math.max(1, Math.round((most - least) / 10));
    input.value = String(Math.min(most, Math.max(least, Number(input.value) + way * far)));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
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

  /** A row of colours as a small window's gradient. */
  function gradientOf(colours: Lab[]): string {
    const tones = colours.map((lab) => rgbToHex(labToRgb(lab)));
    return tones.length === 1 ? tones[0] : `linear-gradient(160deg, ${tones.join(", ")})`;
  }

  /** A small window in one appearance, as the background paints it. */
  function mini(at: Appearance) {
    const colours = coloursOf(theme.palette, at, theme.themes);
    const painted = paints?.[at] ?? null;
    if (painted === null) {
      return { colours, grounds: null, gradient: null, cardGradient: null, text: colours, card: null, cardText: colours };
    }
    const card = painted.cards !== null && painted.cards.amount > 0 ? painted.cards.card : null;
    return {
      colours,
      grounds: painted.grounds,
      gradient: gradientOf(painted.colours),
      cardGradient: gradientOf(painted.cardColours),
      text: { ...colours, ...painted.text },
      card,
      cardText: card === null ? colours : { ...colours, ...painted.cards!.text },
    };
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
          Held at the rim, the most colour there is.
        {:else if shown !== null && shown.harmony === "free" && shown.dots.length > 1}
          Free: each colour moves on its own.
        {:else if shown !== null && shown.dots.length > 1}
          Minus removes the marked colour.
        {/if}
      </span>
    </div>
    <div class="minis" aria-hidden="true">
      {#each ["light", "dark"] as const as at (at)}
        {@const m = mini(at)}
        <div class="mini-wrap">
          {#if terminal}
            <div class="mini" style:background={layer(m.grounds?.frame, m.gradient, m.colours.bg)}>
              <i class="box side" style:background={layer(m.card ?? undefined, m.cardGradient, m.colours.surface)} style:border-color={m.colours.rule}></i>
              <i class="box main" style:background={layer(m.card ?? undefined, m.cardGradient, m.colours.surface)} style:border-color={m.colours.accent}></i>
              <b style:left="27px" style:top="10px" style:width="28px" style:background={m.cardText["ink-3"]}></b>
              <b style:left="27px" style:top="16px" style:width="40px" style:background={m.cardText["ink-2"]}></b>
              <i class="status" style:background={layer(m.grounds?.status, m.gradient, m.colours["surface-2"])}></i>
              <b style:left="4px" style:bottom="2px" style:width="16px" style:background={m.text.accent}></b>
            </div>
          {:else}
            <!-- The ground across the window, the sessions column, the header
                 and the status bar on it, and a card standing on it. -->
            <div class="mini" style:background={layer(m.grounds?.side, m.gradient, rgbToHex(deepOf(m.colours)))}>
              <i class="card" style:background={layer(m.card ?? undefined, m.cardGradient, m.colours.surface)}></i>
              <b style:left="4px" style:top="13px" style:width="14px" style:background={m.text.ink}></b>
              <b style:left="4px" style:top="19px" style:width="11px" style:background={m.text["ink-3"]}></b>
              <b style:left="28px" style:top="4px" style:width="20px" style:background={m.text.accent}></b>
              <b style:left="30px" style:top="16px" style:width="40px" style:background={m.cardText["ink-2"]}></b>
              <b style:left="30px" style:top="22px" style:width="34px" style:background={m.cardText.ink}></b>
              <b style:left="4px" style:bottom="2px" style:width="16px" style:background={m.text.accent}></b>
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
        min={LEAST_PLACE}
        max="100"
        step="1"
        value={strengthPercent(shown?.strength ?? FIRST.strength)}
        style:--fill="{((strengthPercent(shown?.strength ?? FIRST.strength) - LEAST_PLACE) / (100 - LEAST_PLACE)) * 100}%"
        disabled={shown === null}
        oninput={(event) => slide("strength", event, false)}
        onchange={(event) => slide("strength", event, true)}
        onkeydown={farStep}
        data-testid="background-strength"
      />
      <span class="value" data-testid="background-strength-value">{strengthPercent(shown?.strength ?? FIRST.strength)}%</span>
    </div>
    <div class="row">
      <label class="what" for="background-grain">Grain</label>
      <input
        id="background-grain"
        type="range"
        min="0"
        max="100"
        step="1"
        value={Math.round((shown?.grain ?? FIRST.grain) * 100)}
        style:--fill="{(shown?.grain ?? FIRST.grain) * 100}%"
        disabled={shown === null || terminal}
        oninput={(event) => slide("grain", event, false)}
        onchange={(event) => slide("grain", event, true)}
        onkeydown={farStep}
        data-testid="background-grain"
      />
      <span class="value">
        {#if terminal}<em>None in this look</em>{:else}{percent(shown?.grain ?? FIRST.grain)}{/if}
      </span>
    </div>
    <div class="row">
      <label class="what" for="background-cards">Cards</label>
      <input
        id="background-cards"
        type="range"
        min="0"
        max={MOST_CARDS * 100}
        step="1"
        value={Math.round(cards * 100)}
        style:--fill="{(cards / MOST_CARDS) * 100}%"
        disabled={shown === null || setAside}
        oninput={(event) => slideCards(event, false)}
        onchange={(event) => slideCards(event, true)}
        onkeydown={farStep}
        aria-valuetext={cards === 0 ? "None" : cardsPercent(cards)}
        data-testid="background-cards"
      />
      <span class="value" data-testid="background-cards-value">
        {#if shown !== null && !setAside}{cards === 0 ? "None" : cardsPercent(cards)}{/if}
      </span>
    </div>
    <p class="note" data-testid="background-note">
      Kept with {paletteLabel}, for light and dark alike. Strength runs from a calm tint to the colours as the pad
      shows them. Cards is how much of the colour shows through the panes as well, each keeping its own lightness.
      Text on it is drawn as clear as the colours allow.
      {#if setAside}
        Off while the system asks for more contrast.
      {/if}
    </p>
    {#if lowText !== null || lowCards !== null}
      <p class="low" data-testid="background-low">
        {#if lowText !== null}{lowText}{/if}
        {#if lowCards !== null}{lowCards}{/if}
      </p>
    {/if}
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

  /* The plus and the minus, and under them a line about the pad when it
     has something to say. */
  .dots-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
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
    flex: 1 0 100%;
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

  .mini .card {
    left: 24px;
    right: 3px;
    top: 10px;
    bottom: 8px;
    border-radius: 3px;
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

  input[type="range"]:disabled {
    opacity: 0.45;
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

  /* What reads under 4.5:1 at the choice: said quietly, never in the way. */
  .low {
    margin: -4px 0 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--ink-3);
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
