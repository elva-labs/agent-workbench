/**
 * A local log of what each session spends, kept by the core in the
 * workbench's directory, a file per session token, and shown to nobody:
 * each turn's tokens and the context's size, and the account's five-hour
 * figure at each turn, resume, wake and start, so the figure before and
 * after each can be read off. It is there to tune the thresholds the app
 * saves tokens by. Nothing waits on a write, and one that fails is let go.
 */
import { dirFor } from "$lib/accounts.svelte";
import { core } from "$lib/core";
import { limitsOf } from "$lib/limits.svelte";
import { hostOf } from "$lib/remote.svelte";
import type { Session } from "$lib/sessions.svelte";

export type UsageKind = "turn" | "resume" | "wake" | "start";

/** The account's five-hour figure as last reported, with when it last
    moved, in seconds since the epoch. */
function fiveHour(session: Session): { percent: number; takenAt: number } | null {
  const report = limitsOf(hostOf(session.project), session.agent, session.account);
  const window = report?.windows.find((one) => one.kind === "session") ?? null;
  return report === null || window === null ? null : { percent: window.percent, takenAt: report.takenAt };
}

/** Logs what happened in a session, with what the window knows of it. A
    turn of a Claude Code session in a terminal names its conversation, so
    the core reads the turn's tokens from its transcript. */
export function logUsage(session: Session, kind: UsageKind, extra: Record<string, unknown> = {}) {
  const entry = {
    kind,
    id: session.id,
    agent: session.agent,
    surface: session.kind,
    model: session.runsOn ?? session.model,
    fiveHour: fiveHour(session),
    ...extra,
  };
  const configDir = dirFor(session.account, session.agent);
  const read =
    kind === "turn" && session.kind === "terminal" && session.agent === "claude-code" && session.id !== null
      ? {
          session: session.id,
          ...(session.startIn === null ? {} : { cwd: session.startIn }),
          ...(configDir === undefined ? {} : { configDir }),
        }
      : undefined;
  try {
    void core()
      .usageLog(session.project, session.token, entry, read)
      .catch(() => {});
  } catch {
    // A core without the log keeps none.
  }
}
