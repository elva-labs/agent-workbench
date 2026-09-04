<script lang="ts">
  import "@fontsource/ibm-plex-sans/400.css";
  import "@fontsource/ibm-plex-sans/500.css";
  import "@fontsource/ibm-plex-sans/600.css";
  import "@fontsource/ibm-plex-mono/400.css";
  import "@fontsource/ibm-plex-mono/500.css";
  import "@fontsource/archivo/600.css";
  import "@fontsource/archivo/700.css";
  import "$lib/styles/tokens.css";

  import { onMount } from "svelte";
  import { loadTheme } from "$lib/theme.svelte";
  import { loadLayout } from "$lib/layout.svelte";
  import { loadMine } from "$lib/sessions.svelte";
  import { restore } from "$lib/workspace.svelte";

  let { children } = $props();

  onMount(() => {
    loadTheme();
    loadLayout();
    loadMine();
    restore();
  });
</script>

{@render children()}
