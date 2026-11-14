<script lang="ts">
  import { unreadOf, type UnreadEntry } from "$lib/unread.svelte";

  let { field }: { field: string | string[] } = $props();

  let entries = $derived((Array.isArray(field) ? field : [field]).flatMap((one) => unreadOf(one)));

  /** What the user calls a setting the file holds. */
  const NAMES: Record<string, string> = {
    terminalFont: "terminal font",
    interfaceFont: "interface font",
    userStyles: "custom styles choice",
    pastSessions: "span past sessions stay listed",
    notifications: "notifications choice",
    chime: "chime choice",
  };

  /** What an entry is called to the user. */
  function called(entry: UnreadEntry): string {
    if (entry.name === "") return `The ${NAMES[entry.field] ?? entry.field} in the file`;
    return entry.section === "" ? `${entry.name}` : `${entry.name} (${entry.section})`;
  }
</script>

{#each entries as entry (`${entry.field}/${entry.section}/${entry.name}`)}
  <p class="unread" role="status" data-testid="unread-entry" data-field={entry.field}>
    <b>{called(entry)}</b> is not used: {entry.reason}. The file keeps it as written until it is
    mended or the setting is chosen again.
  </p>
{/each}

<style>
  .unread {
    margin: 0 0 12px;
    padding: 8px 10px;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--del) 45%, transparent);
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ink-2);
  }

  .unread b {
    font-weight: 600;
    color: var(--ink);
  }
</style>
