import { startedFor } from "$lib/conductor.svelte";
import { ACTIONS, chordFor, describe, type ActionKey } from "$lib/keys.svelte";
import { matches } from "$lib/files.svelte";
import { hostOf } from "$lib/remote.svelte";
import { LABEL, conductorLabel, conducting, orchestrator, summaryLine } from "$lib/orchestrator.svelte";
import { byStatus, label, sessions, waitingOnYou, type Session } from "$lib/sessions.svelte";
import { projectLabel } from "$lib/workspace.svelte";

/**
 * The command palette: one field over every session and every action the
 * keys can do, narrowed by what is typed. A session is listed in the order
 * the status view has them, under what tells it apart: its project, the
 * orchestrator that started it, the line it left. An action is listed with
 * its chord. Going to the next session that needs you leads, since it is
 * what the palette is opened for most.
 */

export type PaletteItem =
  | { kind: "attention"; id: "attention"; label: string; detail: string; waiting: number; chord: string }
  | { kind: "session"; id: string; label: string; detail: string; session: Session }
  | { kind: "action"; id: string; label: string; detail: string; action: ActionKey; chord: string };

const JUMP = ACTIONS.find(({ key }) => key === "session.attention")!;

export const ATTENTION_LABEL = JUMP.label;

export const palette = $state({ open: false, query: "" });

export function openPalette() {
  palette.query = "";
  palette.open = true;
}

export function closePalette() {
  palette.open = false;
}

/** Test seam. */
export function resetPalette() {
  palette.open = false;
  palette.query = "";
}

/** Where a session belongs, the machine and account it runs on, who started
    it, and what it left. */
function detailOf(session: Session): string {
  const where = session.project === orchestrator.dir ? LABEL : projectLabel(session.project);
  const by = startedFor(session.key);
  return [
    where,
    hostOf(session.project),
    session.account,
    by === null ? null : conductorLabel(by),
    summaryLine(session) ?? session.note,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** What the palette lists for a query, in the order it draws them. */
export function paletteItems(query: string): PaletteItem[] {
  const attention: PaletteItem = {
    kind: "attention",
    id: "attention",
    label: ATTENTION_LABEL,
    detail: JUMP.group,
    // The jump goes to sessions other than the one on screen, so those are
    // what it counts.
    waiting: waitingOnYou().filter((session) => session.key !== sessions.active).length,
    chord: describe(chordFor("session.attention")),
  };
  const rows = byStatus(conducting)
    .flatMap((group) => group.sessions)
    .map(
      (session): PaletteItem => ({
        kind: "session",
        id: `session:${session.key}`,
        label: label(session),
        detail: detailOf(session),
        session,
      }),
    );
  const actions = ACTIONS.filter(
    ({ key }) => key !== "palette" && key !== "session.attention",
  ).map(
    ({ key, label, group }): PaletteItem => ({
      kind: "action",
      id: `action:${key}`,
      label,
      detail: group,
      action: key,
      chord: describe(chordFor(key)),
    }),
  );
  return [attention, ...rows, ...actions].filter((item) =>
    matches(`${item.label} ${"detail" in item ? item.detail : ""}`, query),
  );
}
