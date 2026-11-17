<script lang="ts">
  import { core } from "$lib/core";
  import { putAway } from "$lib/popover";
  import { fileOf, openedKind, outerDocument, plainWhy, type Opened } from "$lib/pageFrame";

  /**
   * An HTML page the agent presented, in a frame of its own: scripts may
   * run, but with no origin, no storage, no network, no navigation and no
   * forms. It may load the images, stylesheets, fonts, audio and video in
   * its own folder and the folders under it, and nothing else. What it
   * names and cannot load is listed under it with why, and an image of
   * those says so where it stands. A link to a picture, a film or a sound
   * in its folder opens it over the window. The frame takes the page's
   * height, which the page reports.
   */

  interface Props {
    html: string;
    title: string;
    /** The page itself, where it is: its folder is what it may load from. */
    page: string;
  }

  let { html, title, page }: Props = $props();

  /** How many misses a page is answered for; past that they are counted. */
  const ANSWERED = 100;
  /** How many are listed under the page. */
  const LISTED = 12;

  interface Missed {
    url: string;
    name: string;
    why: string;
  }

  let frame = $state<HTMLIFrameElement>();
  let height = $state(360);
  /** The page's base address, once the app has given it; "" when it has
      none to give, and the page then loads nothing from its folder. */
  let base = $state<string | null>(null);
  let missed = $state<Missed[]>([]);
  let uncounted = $state(0);
  let opened = $state<{ url: string; name: string; kind: Opened; failed: string | null } | null>(
    null,
  );
  let look = $state<HTMLDialogElement>();
  let played = $state<HTMLMediaElement>();

  $effect(() => {
    const asked = page;
    let current = true;
    base = null;
    core()
      .pageFilesBase(asked)
      .then(
        (given) => {
          if (current) base = given;
        },
        () => {
          if (current) base = "";
        },
      );
    return () => {
      current = false;
    };
  });

  let own = $derived(base === null || base === "" ? null : base);
  let srcdoc = $derived(base === null ? null : outerDocument(html, own, title));

  // A page drawn again misses afresh.
  $effect(() => {
    void srcdoc;
    missed = [];
    uncounted = 0;
  });

  /** The page's own window, inside the frame that holds it. */
  function inner(): Window | null {
    return frame?.contentWindow?.frames[0] ?? null;
  }

  function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** Something the page named did not load: listed, and the page told why. */
  async function tell(url: string, how: string, said: string | null) {
    if (missed.some((one) => one.url === url)) return;
    if (missed.length >= ANSWERED) {
      uncounted += 1;
      return;
    }
    const drawn = srcdoc;
    const plain = plainWhy(url, how, own);
    const name = own !== null && url.startsWith(own) ? fileOf(url, own) : (said ?? url);
    let why: string;
    if (plain !== null || own === null) {
      why = plain ?? "is outside the page's folder";
    } else {
      why = await core()
        .checkPageFile(page, name)
        .then(
          () => "could not be loaded",
          (error: unknown) => reasonOf(error),
        );
    }
    if (drawn !== srcdoc || missed.some((one) => one.url === url)) return;
    missed = [...missed, { url, name, why }];
    inner()?.postMessage({ workbenchWhy: { url, name, why } }, "*");
  }

  /** A link to a file in the page's folder was clicked. Opened over the
      window when it is a picture, a film or a sound, and only while the
      user is in the page: a script cannot open one on its own. */
  function open(file: string) {
    if (own === null || file === "" || document.activeElement !== frame) return;
    const url = new URL(file, own).href;
    if (!url.startsWith(own)) return;
    const name = fileOf(url, own);
    const kind = openedKind(name);
    if (kind === null) {
      if (!missed.some((one) => one.url === url))
        missed = [
          ...missed,
          { url, name, why: "is not a picture, a film or a sound, which is all a link from a page opens" },
        ];
      return;
    }
    opened = { url, name, kind, failed: null };
  }

  /** The opened file did not load: why, from where the files are. */
  async function failed() {
    const now = opened;
    if (now === null) return;
    const why = await core()
      .checkPageFile(page, now.name)
      .then(
        () => "could not be loaded",
        (error: unknown) => reasonOf(error),
      );
    if (opened === now) opened = { ...now, failed: why };
  }

  $effect(() => {
    const onMessage = (e: MessageEvent) => {
      const from = inner();
      if (from === null || e.source !== from) return;
      const data = e.data as Record<string, unknown> | null;
      if (data === null || typeof data !== "object") return;
      const reported = data.workbenchHeight;
      if (typeof reported === "number" && Number.isFinite(reported)) {
        height = Math.max(120, Math.min(2400, Math.ceil(reported) + 2));
        return;
      }
      const miss = data.workbenchMissed as { url?: unknown; how?: unknown; said?: unknown } | undefined;
      if (miss !== undefined && typeof miss?.url === "string" && typeof miss.how === "string") {
        void tell(miss.url, miss.how, typeof miss.said === "string" ? miss.said : null);
        return;
      }
      if (typeof data.workbenchOpen === "string") open(data.workbenchOpen);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  let showing = $derived(opened !== null);

  $effect(() => {
    if (!showing || look === undefined) return;
    const dialog = look;
    if (!dialog.open) dialog.showModal?.();
    dialog.focus();
    return putAway({
      inside: () => [played],
      close: () => {
        opened = null;
        frame?.focus();
      },
      control: () => frame,
    });
  });
</script>

{#if srcdoc !== null}
  <iframe
    bind:this={frame}
    {srcdoc}
    sandbox="allow-scripts"
    {title}
    style:height="{height}px"
    data-testid="media-page"
  ></iframe>
{/if}

{#if missed.length > 0}
  <div class="missed" data-testid="media-page-missed">
    <h4>Not loaded</h4>
    <ul>
      {#each missed.slice(0, LISTED) as one (one.url)}
        <li><span class="name" title={one.url}>{one.name}</span> {one.why}</li>
      {/each}
    </ul>
    {#if missed.length + uncounted > LISTED}
      <p>and {missed.length + uncounted - LISTED} more</p>
    {/if}
  </div>
{/if}

{#if opened !== null}
  <dialog
    class="opened"
    bind:this={look}
    aria-label={opened.name}
    tabindex="-1"
    data-testid="media-page-opened"
  >
    {#if opened.failed !== null}
      <p class="failed">{opened.name} {opened.failed}</p>
    {:else if opened.kind === "image"}
      <img src={opened.url} alt={opened.name} onerror={failed} />
    {:else if opened.kind === "video"}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={played} src={opened.url} controls autoplay onerror={failed}></video>
    {:else}
      <audio bind:this={played} src={opened.url} controls autoplay onerror={failed}></audio>
    {/if}
    <p class="caption"><span>{opened.name}</span><kbd>Esc</kbd></p>
  </dialog>
{/if}

<style>
  iframe {
    width: 100%;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: white;
  }

  .missed {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-2);
  }

  .missed h4 {
    margin: 0 0 2px;
    font-family: var(--chrome);
    font-size: 10.5px;
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    font-weight: 500;
    color: var(--ink-3);
  }

  .missed ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .missed li {
    overflow-wrap: anywhere;
  }

  .missed .name {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink);
  }

  .missed p {
    margin: 0;
    color: var(--ink-3);
  }

  .opened {
    max-width: none;
    max-height: none;
    width: 100vw;
    height: 100vh;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    outline: none;
  }

  .opened::backdrop {
    background: rgb(0 0 0 / 78%);
  }

  .opened img,
  .opened video {
    max-width: 92vw;
    max-height: calc(100vh - 96px);
    object-fit: contain;
    border-radius: var(--radius);
    box-shadow: 0 12px 40px rgb(0 0 0 / 45%);
    background: white;
  }

  .opened audio {
    width: min(480px, 92vw);
  }

  .caption {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0;
    padding: 4px 6px 4px 12px;
    border-radius: var(--radius);
    background: rgb(0 0 0 / 60%);
    font-family: var(--chrome);
    font-size: 12px;
    color: rgb(255 255 255 / 90%);
  }

  .caption kbd {
    font-family: var(--chrome);
    font-size: 10.5px;
    padding: 1px 6px;
    border: 1px solid rgb(255 255 255 / 35%);
    border-radius: var(--radius);
    color: rgb(255 255 255 / 70%);
  }

  .failed {
    margin: 0;
    max-width: 60ch;
    font-size: 13px;
    color: rgb(255 255 255 / 86%);
  }
</style>
