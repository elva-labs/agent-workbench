import type { AgentId, IntegratedEventBody, IntegratedLimitWindow } from "$lib/core";

/**
 * The usage limits of each account, as the agents report them.
 *
 * Limits belong to an account, not to a session: every integrated session
 * on an account reports the same figures, and a terminal session on it
 * shows what they reported. So the figures are kept by machine, agent and
 * account, the machine being the host a session's project is on, null for
 * this one, and the account the session's, null for the agents' own login.
 * The same account name on two machines is two logins. The report taken
 * last wins, whichever session sent it. Reports come from the limits event
 * and from the snapshot a window asks for when it comes to a session late.
 * Nothing here asks for them.
 *
 * Below the store is what the status bar and its popover say of a report:
 * the order and names of its windows, how near its end each is, which is
 * the most used, when each resets and how old the figures are.
 */

export type LimitsReport = Extract<IntegratedEventBody, { type: "limits" }>;

const known = $state<Record<string, LimitsReport>>({});

function keyOf(host: string | null, agent: string, account: string | null): string {
  return JSON.stringify([host, agent, account]);
}

/** Takes a report of the limits of an account on a machine. One whose
    figures last moved before the held report's did is let go; of two that
    moved at the same second, the one with the later read stands. */
export function heardLimits(host: string | null, account: string | null, report: LimitsReport) {
  const key = keyOf(host, report.agent, account);
  const held = known[key];
  if (
    held !== undefined &&
    (held.takenAt > report.takenAt ||
      (held.takenAt === report.takenAt && (held.readAt ?? 0) > (report.readAt ?? 0)))
  )
    return;
  known[key] = {
    type: "limits",
    agent: report.agent,
    plan: report.plan,
    readAt: report.readAt,
    takenAt: report.takenAt,
    windows: report.windows.map((window) => ({ ...window })),
  };
}

/** The last report for an agent under an account on a machine, or null
    before one. */
export function limitsOf(host: string | null, agent: AgentId, account: string | null): LimitsReport | null {
  return known[keyOf(host, agent, account)] ?? null;
}

/** Test seam. */
export function resetLimits() {
  for (const key of Object.keys(known)) delete known[key];
}

// ---- what a report says ----

/** How near its end a window is: `warn` near it, `error` at it. */
export type Tone = "normal" | "warn" | "error";

/** One window as the bar and the popover show it. */
export interface Figure {
  kind: IntegratedLimitWindow["kind"];
  /** Short, for the bar: `5h`, `Week`, or the model a week counts alone. */
  label: string;
  /** In words, for the popover. */
  name: string;
  /** Percent used as shown, or null once the window has reset since the
      figures were taken, since what it holds now is not known. */
  percent: number | null;
  tone: Tone;
  /** Used up: the agent says so, or it is at 100%. */
  reached: boolean;
  /** When it starts over, in milliseconds, where the agent says. */
  resetsAt: number | null;
}

/** From this share used a window is near its end, where the agent gives
    no reading of its own. */
export const WARN_FROM = 80;
/** Figures older than this say how old they are. A session reads them
    once it is ready and after a turn at most every five minutes, so
    figures this old mean no session on the account has finished a turn
    for a while. */
export const STALE_AFTER = 15 * 60_000;

const ORDER: IntegratedLimitWindow["kind"][] = ["session", "weekly", "weeklyScoped"];

function labelOf(window: IntegratedLimitWindow): string {
  if (window.kind === "session") return "5h";
  if (window.kind === "weekly") return "Week";
  return window.model ?? "Model";
}

function nameOf(window: IntegratedLimitWindow): string {
  if (window.kind === "session") return "Session (5 hours)";
  if (window.kind === "weekly") return "Week";
  return window.model === null ? "Week, one model" : `Week, ${window.model} only`;
}

/** A share as it is shown: whole, and 100 only when it is all used, so a
    window just short of its end never reads as at it. */
export function shownPercent(percent: number): number {
  if (percent >= 100) return 100;
  return Math.max(0, Math.min(99, Math.round(percent)));
}

/** How near its end a window is: what the agent reads, where it gives a
    reading, and otherwise from its share used. At 100% it is at its end
    whatever the agent reads. */
export function toneOf(window: IntegratedLimitWindow): Tone {
  if (window.severity === "reached" || window.percent >= 100) return "error";
  if (window.severity === "warning") return "warn";
  if (window.severity === null && window.percent >= WARN_FROM) return "warn";
  return "normal";
}

/** The windows of a report in a steady order, the session window first.
    One that has reset since the figures were taken is drawn as reset. */
export function figuresOf(report: LimitsReport, now: number): Figure[] {
  return [...report.windows]
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
    .map((window) => {
      const resetsAt = window.resetsAt === null ? null : window.resetsAt * 1000;
      const over = resetsAt !== null && resetsAt <= now;
      const tone = over ? "normal" : toneOf(window);
      return {
        kind: window.kind,
        label: labelOf(window),
        name: nameOf(window),
        percent: over ? null : shownPercent(window.percent),
        tone,
        reached: tone === "error",
        resetsAt,
      };
    });
}

const RANK: Record<Tone, number> = { normal: 0, warn: 1, error: 2 };

/** The figure that stands for the rest where only one fits: the nearest
    its end, then the most used, then the first. */
export function topFigure(figures: Figure[]): Figure | null {
  let top: Figure | null = null;
  for (const figure of figures) {
    if (
      top === null ||
      RANK[figure.tone] > RANK[top.tone] ||
      (RANK[figure.tone] === RANK[top.tone] && (figure.percent ?? -1) > (top.percent ?? -1))
    )
      top = figure;
  }
  return top;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function midnight(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** When a window resets, as a person says it: `in 2 h 10 min` within a
    few hours, then the day and the time, `Thursday 09:00`, or `Thu 09:00`
    where room is short. */
export function resetWhen(resetsAt: number, now: number, short = false): string {
  const minutes = Math.max(1, Math.floor((resetsAt - now) / 60_000));
  if (minutes < 6 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `in ${rest} min`;
    return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
  }
  const days = Math.round((midnight(resetsAt) - midnight(now)) / 86_400_000);
  const time = clock(resetsAt);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const name = DAYS[new Date(resetsAt).getDay()];
  if (days < 7) return `${short ? name.slice(0, 3) : name} ${time}`;
  const date = new Date(resetsAt).toLocaleDateString([], { day: "numeric", month: "short" });
  return `${date} ${time}`;
}

/** What the popover says of when a window resets, or did. */
export function resetWords(figure: Figure, now: number): string {
  if (figure.resetsAt === null) return figure.reached ? "Reached" : "";
  if (figure.percent === null) return `Reset at ${clock(figure.resetsAt)}`;
  const when = `resets ${resetWhen(figure.resetsAt, now)}`;
  return figure.reached ? `Reached, ${when}` : when;
}

/** How old a report's figures are by `now`: as old as its oldest, which
    is the last read the agent answered, or the report itself where no
    read was answered. A push between reads moves only the windows it
    names, so a newer figure does not make the rest newer; `moved` says a
    push came a minute or more after the read. */
export function ageOf(
  report: Pick<LimitsReport, "readAt" | "takenAt">,
  now: number,
): { stale: boolean; moved: boolean; short: string; long: string } {
  const ms = Math.max(0, now - (report.readAt ?? report.takenAt) * 1000);
  const moved = report.readAt !== null && report.takenAt - report.readAt >= 60;
  const minutes = Math.floor(ms / 60_000);
  const stale = ms >= STALE_AFTER;
  const words = (short: string, long: string) => ({ stale, moved, short, long });
  if (minutes < 1) return words("now", "just now");
  if (minutes < 60) return words(`${minutes} min`, `${minutes} min ago`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return words(`${hours} h`, hours === 1 ? "an hour ago" : `${hours} hours ago`);
  const days = Math.floor(hours / 24);
  return words(`${days} d`, days === 1 ? "a day ago" : `${days} days ago`);
}

const PLANS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  plus: "Plus",
  max: "Max",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

/** A plan as a person reads it: the agents' own ids, `team` and `max`, as
    Team and Max, and any other as the agent wrote it. */
export function planName(plan: string | null): string | null {
  const id = plan?.trim() ?? "";
  if (id === "") return null;
  return PLANS[id.toLowerCase()] ?? id;
}
