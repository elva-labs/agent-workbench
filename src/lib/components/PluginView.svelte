<script lang="ts">
  import { core } from "$lib/core";
  import { type PluginPage, pluginViews, send } from "$lib/pluginView.svelte";
  import { activeSession } from "$lib/sessions.svelte";
  import { showRequested } from "$lib/show.svelte";
  import { printable } from "$lib/terminals.svelte";

  /**
   * A plugin's page, in a frame of its own: scripts may run, but with no
   * origin, no storage, no navigation of the window and no forms. The frame
   * takes the page's height, which the page reports through the bridge put
   * in front of it.
   *
   * The bridge is the whole of what crosses. From the page: a place to open
   * in the viewer, a line for the agent, a message for the plugin. To the
   * page: the data its plugin sends while the page is open. A message is
   * this frame's only when the window it came from is this frame's.
   */

  interface Props {
    page: PluginPage;
  }

  let { page }: Props = $props();

  // `window.workbench` for the page, over `postMessage`, and the page's own
  // height: the bottom of its last block, which is what the frame should
  // show without a scrollbar.
  const BRIDGE =
    '<script>(function(){var handler=null;window.workbench={open:function(path,from,to,note){parent.postMessage({workbench:"open",path:path,from:from,to:to,note:note===undefined?null:note},"*")},agent:function(text){parent.postMessage({workbench:"agent",text:text},"*")},send:function(payload){parent.postMessage({workbench:"send",payload:payload},"*")},onData:function(fn){handler=fn}};addEventListener("message",function(e){var m=e.data;if(m&&m.workbench==="data"&&handler)handler(m.data)});function h(){var c=document.body?document.body.children:[],m=0;for(var i=0;i<c.length;i++){var b=c[i].getBoundingClientRect().bottom;if(b>m)m=b}return m>0?m+16:document.documentElement.scrollHeight}function r(){parent.postMessage({workbenchHeight:h()},"*")}addEventListener("load",r);if(window.ResizeObserver&&document.documentElement)new ResizeObserver(r).observe(document.documentElement);setTimeout(r,0)})()<\/script>';

  let frame: HTMLIFrameElement;
  let height = $state(360);
  /** The page the frame has loaded, which is when it can be messaged. */
  let loaded = $state<string | null>(null);
  /** The last message handed over, so one arrives once. */
  let delivered = 0;

  /** A line number as the page gave it, or the fallback. */
  function lineAt(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  }

  /** A place the page asked for, taken as relative to the project, opened
      the way the agent's own show request is. */
  function openPlace(data: Record<string, unknown>) {
    const path = typeof data.path === "string" ? data.path : "";
    if (path === "") return;
    const from = lineAt(data.from, 1);
    void showRequested({
      path: `${page.project.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`,
      from,
      to: lineAt(data.to, from),
      note: typeof data.note === "string" ? data.note : null,
      cwd: page.project,
      session: null,
    });
  }

  /** A line for the agent, typed at its prompt with no newline, so the user
      reads it and presses Enter. */
  function toAgent(data: Record<string, unknown>) {
    const text = typeof data.text === "string" ? printable(data.text) : "";
    if (text === "") return;
    const session = activeSession();
    if (session === null || session.ptyId === null || session.status !== "running") return;
    core()
      .write(session.ptyId, text)
      .catch(() => {});
  }

  $effect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame?.contentWindow) return;
      const data = e.data as Record<string, unknown> | null;
      if (data === null || typeof data !== "object") return;
      const reported = data.workbenchHeight;
      if (typeof reported === "number" && Number.isFinite(reported)) {
        height = Math.max(120, Math.min(2400, Math.ceil(reported) + 2));
        return;
      }
      if (data.workbench === "open") openPlace(data);
      else if (data.workbench === "agent") toAgent(data);
      else if (data.workbench === "send") void send(page.key, page.project, data.payload);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  // What the plugin sent for the page, handed over once the page is there
  // to take it.
  $effect(() => {
    const message = pluginViews.data;
    if (message === null || loaded !== page.html) return;
    if (message.key !== page.key || message.project !== page.project) return;
    if (message.seq === delivered) return;
    delivered = message.seq;
    frame?.contentWindow?.postMessage(
      { workbench: "data", data: $state.snapshot(message.data) },
      "*",
    );
  });
</script>

<iframe
  bind:this={frame}
  srcdoc={BRIDGE + page.html}
  sandbox="allow-scripts"
  title={page.plugin}
  onload={() => (loaded = page.html)}
  style:height="{height}px"
  data-testid="plugin-page"
></iframe>

<style>
  iframe {
    width: 100%;
    border: 0;
    border-radius: var(--radius);
    background: white;
  }
</style>
