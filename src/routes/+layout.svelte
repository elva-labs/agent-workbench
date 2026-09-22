<script lang="ts">
  import "@fontsource/ibm-plex-sans/400.css";
  import "@fontsource/ibm-plex-sans/500.css";
  import "@fontsource/ibm-plex-sans/600.css";
  import "@fontsource/ibm-plex-mono/400.css";
  import "@fontsource/ibm-plex-mono/400-italic.css";
  import "@fontsource/ibm-plex-mono/500.css";
  import "@fontsource/ibm-plex-mono/700.css";
  import "@fontsource/ibm-plex-mono/700-italic.css";
  import "@fontsource/inter/400.css";
  import "@fontsource/inter/500.css";
  import "@fontsource/inter/600.css";
  import "@fontsource/jetbrains-mono/400.css";
  import "@fontsource/jetbrains-mono/400-italic.css";
  import "@fontsource/jetbrains-mono/500.css";
  import "@fontsource/jetbrains-mono/700.css";
  import "@fontsource/jetbrains-mono/700-italic.css";
  import "@fontsource/archivo/600.css";
  import "@fontsource/archivo/700.css";
  import "$lib/styles/tokens.css";
  import "$lib/styles/palettes.css";
  import "$lib/styles/fonts.css";
  import "$lib/styles/looks.css";

  import { onMount } from "svelte";
  import { loadTheme } from "$lib/theme.svelte";
  import { loadKeys } from "$lib/keys.svelte";
  import { loadLayout } from "$lib/layout.svelte";
  import { loadStarted } from "$lib/conductor.svelte";
  import { loadRemembered } from "$lib/sessions.svelte";
  import { followOpenRequests, restore } from "$lib/workspace.svelte";

  let { children } = $props();

  onMount(() => {
    loadTheme();
    loadKeys();
    loadLayout();
    loadRemembered();
    loadStarted();
    return followOpenRequests(restore());
  });
</script>

{@render children()}
