<script lang="ts">
  /** The conversation's small line icons, drawn on a 16 by 16 grid in the
      current colour. */
  interface Props {
    name: string;
    size?: number;
  }

  let { name, size = 14 }: Props = $props();

  const PATHS: Record<string, string> = {
    chev: "m6 4 4 4-4 4",
    down: "m4 6 4 4 4-4",
    "chev-up": "m4 10 4-4 4 4",
    up: "M8 13V3M4 7l4-4 4 4",
    stop: "M5 5h6v6H5z",
    clip: "M13 7.5 8 12.4a3 3 0 0 1-4.2-4.2l5.4-5.4a2 2 0 0 1 2.8 2.8L6.7 10.9a1 1 0 0 1-1.4-1.4L10 4.8",
    terminal: "M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5",
    edit: "M10.5 3 13 5.5 6 12.5H3.5V10zM9 4.5 11.5 7",
    file: "M4 2h5l3 3v9H4zM9 2v3h3",
    search: "M7 2.8a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4M10.2 10.2l3 3",
    globe: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2M2 8h12M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14M8 2C6.2 3.8 5.4 5.8 5.4 8s.8 4.2 2.6 6",
    agent: "M8 2.5a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4M3.5 13.5c.4-2.4 2.2-4 4.5-4s4.1 1.6 4.5 4",
    plug: "M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3",
    tool: "M10.5 2.5a3 3 0 0 0-2.9 3.8L3 10.9 5.1 13l4.6-4.6a3 3 0 0 0 3.8-2.9l-1.7 1.7-1.6-.4-.4-1.6z",
    thought: "M5 11.5c-1.7 0-3-1.2-3-2.8 0-1.4 1-2.5 2.4-2.7C4.8 4 6.2 3 8 3c2 0 3.5 1.3 3.7 3 1.3.3 2.3 1.4 2.3 2.7 0 1.6-1.3 2.8-3 2.8zM6 14h.5",
    check: "m3.5 8.5 3 3 6-7",
    copy: "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7",
    x: "M4 4l8 8M12 4l-8 8",
    folder: "M2 4.5h4l1.5 1.5H14v6.5H2z",
    branch:
      "M5 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3M5 11a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3M11 4.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3M5 5v6M11 7.5c0 2.5-6 1.5-6 3.5",
    info: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2M8 7.5V11M8 5h.01",
    warn: "M8 2.5 14 13H2zM8 6.5v3M8 11.2h.01",
    lock: "M4 7.5h8v6H4zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2",
    plan: "M3 4h1M6 4h7M3 8h1M6 8h7M3 12h1M6 12h7",
    compact: "M3 5h10M5 8h6M7 11h2",
    open: "M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5",
    flow: "M2 2.5h4v3H2zM10 10.5h4v3h-4zM6 4h3a2 2 0 0 1 2 2v4.5",
    again: "M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3",
    "pull-request":
      "M4.5 1.9a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2M4.5 10.9a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2M11.5 10.9a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2M4.5 5.1v5.8M11.5 10.9V6.5a2 2 0 0 0-2-2H7.2M8.6 2.9 7 4.5l1.6 1.6",
    issue: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2M8 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2",
    comment: "M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z",
    dot: "M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5",
  };
</script>

<svg
  class="icon"
  viewBox="0 0 16 16"
  width={size}
  height={size}
  aria-hidden="true"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"><path d={PATHS[name] ?? PATHS.tool} /></svg
>

<style>
  .icon {
    flex: none;
    display: block;
  }
</style>
