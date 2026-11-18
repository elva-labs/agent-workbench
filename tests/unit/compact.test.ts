import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "$lib/core";

const sets: Partial<Settings>[] = [];

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsSet: async (change: Partial<Settings>) => {
      sets.push(change);
      return change as Settings;
    },
  }),
}));

import { adoptCompact, compact, compactSettings, loadCompact, resetCompact, setCompact } from "$lib/compact.svelte";
import { resetPersist } from "$lib/persist";
import {
  COMPACT_EDGE,
  DEFAULT,
  FOLDED,
  MIN,
  SPLITTER,
  agentVisible,
  applyLayout,
  changesVisible,
  enterReview,
  focusPane,
  layout,
  peekSessions,
  peekable,
  sessionsShown,
  sessionsVisible,
  setEditing,
  togglePane,
} from "$lib/layout.svelte";
import { theme } from "$lib/theme.svelte";

function reset() {
  resetCompact();
  resetPersist();
  sets.length = 0;
  localStorage.removeItem("workbench.compact");
  theme.look = "modern";
  layout.sessions = DEFAULT.sessions;
  layout.changes = DEFAULT.changes;
  layout.sessionsChosen = true;
  layout.changesChosen = true;
  layout.sessionsForced = false;
  layout.changesForced = false;
  layout.agentHidden = false;
  layout.sessionsPeek = false;
  layout.mode = "working";
  layout.focus = "agent";
  layout.agentChosen = true;
  layout.editTreeForced = false;
}

beforeEach(reset);

describe("the setting", () => {
  it("is off until turned on, and anything but true reads as off", () => {
    expect(compact.on).toBe(false);
    adoptCompact(true);
    expect(compact.on).toBe(true);
    adoptCompact("yes");
    expect(compact.on).toBe(false);
    adoptCompact(undefined);
    expect(compact.on).toBe(false);
  });

  it("is sent to the core when the user turns it, and is part of the settings", () => {
    setCompact(true);
    expect(sets).toEqual([{ compact: true }]);
    expect(compactSettings()).toEqual({ compact: true });
  });

  it("keeps a copy of its own for the first frame", () => {
    adoptCompact(true);
    compact.on = false;
    loadCompact();
    expect(compact.on).toBe(true);
    adoptCompact(false);
    loadCompact();
    expect(compact.on).toBe(false);
  });
});

describe("the layout in compact mode", () => {
  it("takes the sessions pane out, and the others have the width", () => {
    compact.on = true;
    applyLayout(1200);
    expect(sessionsVisible()).toBe(false);
    expect(sessionsShown()).toBe(false);
    expect(layout.sessionsForced).toBe(false);
    expect(changesVisible()).toBe(true);
    expect(agentVisible()).toBe(true);
  });

  it("keeps the changes pane in a window too narrow for it beside the folded column", () => {
    const narrow = COMPACT_EDGE.modern + MIN.changes + SPLITTER + MIN.agent;
    expect(narrow).toBeLessThan(FOLDED + SPLITTER + MIN.changes + SPLITTER + MIN.agent);
    compact.on = true;
    applyLayout(narrow);
    expect(changesVisible()).toBe(true);
  });

  it("leaves the fold and the width as they were, and they stand once it is off", () => {
    layout.sessions = 340;
    togglePane("sessions");
    expect(layout.sessionsChosen).toBe(false);
    compact.on = true;
    applyLayout(1400);
    compact.on = false;
    applyLayout(1400);
    expect(layout.sessionsChosen).toBe(false);
    expect(layout.sessions).toBe(340);
    togglePane("sessions");
    expect(sessionsVisible()).toBe(true);
    expect(layout.sessions).toBe(340);
  });

  it("peeks the pane in every shape, and a resize keeps it", () => {
    compact.on = true;
    applyLayout(1400);
    expect(peekable()).toBe(true);
    peekSessions(true);
    expect(sessionsShown()).toBe(true);
    applyLayout(1300);
    expect(layout.sessionsPeek).toBe(true);
    enterReview();
    expect(layout.sessionsPeek).toBe(true);
  });

  it("peeks while editing in a window wide enough for everything", () => {
    compact.on = true;
    setEditing(true);
    applyLayout(2000);
    expect(peekable()).toBe(true);
    peekSessions(true);
    expect(layout.sessionsPeek).toBe(true);
  });

  it("gives the keyboard back to the pane it came from when the pane goes", () => {
    compact.on = true;
    applyLayout(1400);
    focusPane("changes");
    peekSessions(true);
    focusPane("sessions");
    expect(layout.focus).toBe("sessions");
    const asked = layout.focusRequest;
    peekSessions(false);
    expect(layout.focus).toBe("changes");
    expect(layout.focusRequest).toBe(asked + 1);
  });

  it("gives it to the agent when the pane it came from has gone meanwhile", () => {
    compact.on = true;
    applyLayout(1400);
    focusPane("changes");
    peekSessions(true);
    focusPane("sessions");
    layout.changesChosen = false;
    applyLayout(1400);
    peekSessions(false);
    expect(layout.focus).toBe("agent");
  });

  it("does not move the keyboard when the pane goes without it", () => {
    compact.on = true;
    applyLayout(1400);
    peekSessions(true);
    peekSessions(false);
    expect(layout.focus).toBe("agent");
  });
});
