<script lang="ts">
  /**
   * An HTML page the agent presented, in a frame of its own: scripts may
   * run, but with no origin, no storage, no navigation of the window and
   * no forms. The frame takes the page's height, which the page reports
   * through a line put in front of it.
   */

  interface Props {
    html: string;
    title: string;
  }

  let { html, title }: Props = $props();

  // The page's own height: the bottom of its last block, which is what
  // the frame should show without a scrollbar. The document's scroll
  // height would be the frame's own height for a short page.
  const REPORT =
    '<script>(function(){function h(){var c=document.body?document.body.children:[],m=0;for(var i=0;i<c.length;i++){var b=c[i].getBoundingClientRect().bottom;if(b>m)m=b}return m>0?m+16:document.documentElement.scrollHeight}function r(){parent.postMessage({workbenchHeight:h()},"*")}addEventListener("load",r);if(window.ResizeObserver&&document.documentElement)new ResizeObserver(r).observe(document.documentElement);setTimeout(r,0)})()<\/script>';

  let frame: HTMLIFrameElement;
  let height = $state(360);

  $effect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame?.contentWindow) return;
      const reported = (e.data as { workbenchHeight?: unknown } | null)?.workbenchHeight;
      if (typeof reported !== "number" || !Number.isFinite(reported)) return;
      height = Math.max(120, Math.min(2400, Math.ceil(reported) + 2));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });
</script>

<iframe
  bind:this={frame}
  srcdoc={REPORT + html}
  sandbox="allow-scripts"
  {title}
  style:height="{height}px"
  data-testid="media-page"
></iframe>

<style>
  iframe {
    width: 100%;
    border: 1px solid var(--rule);
    background: white;
  }
</style>
