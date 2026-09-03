import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT,
  MIN,
  NEEDS_AGENT_WHILE_REVIEWING,
  NEEDS_CHANGES,
  MIN_REVIEW,
  NEEDS_SESSIONS,
  SPLITTER,
  agentVisible,
  applyLayout,
  changesVisible,
  enterReview,
  exitReview,
  focusPane,
  layout,
  loadLayout,
  saveLayout,
  sessionsVisible,
  togglePane,
} from "$lib/layout.svelte";

function reset() {
  layout.sessions = DEFAULT.sessions;
  layout.changes = DEFAULT.changes;
  layout.review = DEFAULT.review;
  layout.tree = DEFAULT.tree;
  layout.sessionsChosen = true;
  layout.changesChosen = true;
  layout.sessionsForced = false;
  layout.changesForced = false;
  layout.agentHidden = false;
  layout.reviewTouched = false;
  layout.mode = "working";
  layout.focus = "agent";
  layout.width = 1200;
}

beforeEach(reset);

describe("working layout", () => {
  it("leaves a comfortable window untouched", () => {
    applyLayout(1600);
    expect(layout.sessions).toBe(DEFAULT.sessions);
    expect(layout.changes).toBe(DEFAULT.changes);
  });

  it("takes width from the changes pane first", () => {
    layout.sessions = 400;
    layout.changes = 500;
    applyLayout(1100);
    expect(layout.sessions).toBe(400);
    expect(layout.changes).toBeLessThan(500);
    expect(layout.changes).toBeGreaterThanOrEqual(MIN.changes);
  });

  it("only then squeezes the sessions pane", () => {
    layout.sessions = 400;
    layout.changes = 500;
    applyLayout(900);
    expect(layout.changes).toBe(MIN.changes);
    expect(layout.sessions).toBeLessThan(400);
    expect(layout.sessions).toBeGreaterThanOrEqual(MIN.sessions);
  });

  it("raises a pane that is somehow already under its minimum", () => {
    layout.sessions = 40;
    applyLayout(1600);
    expect(layout.sessions).toBe(MIN.sessions);
  });
});

describe("responsive collapse", () => {
  it("keeps all three panes above the sessions threshold", () => {
    applyLayout(NEEDS_SESSIONS);
    expect(sessionsVisible()).toBe(true);
    expect(changesVisible()).toBe(true);
    expect(agentVisible()).toBe(true);
  });

  it("folds the sessions pane away just below it", () => {
    applyLayout(NEEDS_SESSIONS - 1);
    expect(sessionsVisible()).toBe(false);
    expect(changesVisible()).toBe(true);
  });

  it("folds the changes pane away too when even that will not fit", () => {
    applyLayout(NEEDS_CHANGES - 1);
    expect(sessionsVisible()).toBe(false);
    expect(changesVisible()).toBe(false);
    expect(agentVisible()).toBe(true);
  });

  it("brings both back when the window grows again", () => {
    applyLayout(500);
    applyLayout(1600);
    expect(sessionsVisible()).toBe(true);
    expect(changesVisible()).toBe(true);
  });

  // The whole point of separating forced from chosen.
  it("does not overwrite your choice when it forces a pane away", () => {
    expect(layout.sessionsChosen).toBe(true);
    applyLayout(500);
    expect(sessionsVisible()).toBe(false);
    expect(layout.sessionsChosen).toBe(true);
    applyLayout(1600);
    expect(sessionsVisible()).toBe(true);
  });

  it("keeps a pane you closed closed when the window grows", () => {
    togglePane("sessions");
    applyLayout(1600);
    expect(layout.sessionsChosen).toBe(false);
    expect(sessionsVisible()).toBe(false);
  });

  it("never persists a forced collapse", () => {
    applyLayout(500);
    saveLayout();
    const stored = JSON.parse(localStorage.getItem("workbench.layout")!);
    expect(stored.sessionsChosen).toBe(true);
    expect(stored).not.toHaveProperty("sessionsForced");
  });
});

describe("review mode", () => {
  it("folds the sessions pane away on entry", () => {
    applyLayout(1600);
    enterReview();
    expect(sessionsVisible()).toBe(false);
    expect(layout.sessionsChosen).toBe(true);
  });

  it("restores it on exit", () => {
    applyLayout(1600);
    enterReview();
    exitReview();
    expect(sessionsVisible()).toBe(true);
  });

  it("moves focus to the viewer and back to the agent", () => {
    applyLayout(1600);
    enterReview();
    expect(layout.focus).toBe("changes");
    exitReview();
    expect(layout.focus).toBe("agent");
  });

  it("keeps the agent visible while there is room for both", () => {
    layout.mode = "reviewing";
    applyLayout(NEEDS_AGENT_WHILE_REVIEWING);
    expect(agentVisible()).toBe(true);
    expect(layout.review).toBeGreaterThanOrEqual(MIN_REVIEW);
  });

  // Hiding costs nothing; squeezing costs a PTY resize and a redraw.
  it("hides the agent rather than squeezing it below its minimum", () => {
    layout.mode = "reviewing";
    applyLayout(NEEDS_AGENT_WHILE_REVIEWING - 1);
    expect(agentVisible()).toBe(false);
  });

  it("leaves the agent pane's own width alone while it is hidden", () => {
    applyLayout(1600);
    const changes = layout.changes;
    layout.mode = "reviewing";
    applyLayout(500);
    expect(layout.changes).toBe(changes);
  });

  it("never lets the viewer take the agent below its minimum", () => {
    layout.review = 2000;
    layout.mode = "reviewing";
    applyLayout(1200);
    expect(1200 - 6 - layout.review).toBeGreaterThanOrEqual(MIN.agent);
  });

  it("keeps the viewer readable even in a narrow window", () => {
    layout.mode = "reviewing";
    applyLayout(600);
    expect(layout.review).toBeGreaterThanOrEqual(MIN_REVIEW);
  });

  // The pane holds a tree beside the content now, so it opens at a width that
  // fits both rather than at whatever the sessions pane happened to free.
  it("opens wide enough for a tree and a diff side by side", () => {
    applyLayout(1600);
    enterReview();
    expect(layout.review).toBe(DEFAULT.review);
    expect(layout.review - SPLITTER - layout.tree).toBeGreaterThanOrEqual(MIN.viewer);
  });

  it("takes more than that when the changes pane was already wide", () => {
    applyLayout(1600);
    layout.changes = 900;
    enterReview();
    expect(layout.review).toBeGreaterThan(DEFAULT.review);
  });

  it("stops sizing itself once you have dragged the splitter", () => {
    applyLayout(1600);
    layout.review = 800;
    layout.reviewTouched = true;
    enterReview();
    expect(layout.review).toBe(800);
  });

  it("is squeezed to its own minimum when the window cannot give more", () => {
    layout.mode = "reviewing";
    layout.review = DEFAULT.review;
    applyLayout(MIN_REVIEW + SPLITTER + MIN.agent);
    expect(layout.review).toBe(MIN_REVIEW);
    expect(layout.tree).toBe(MIN.tree);
  });

  it("remembers the two widths separately", () => {
    applyLayout(1600);
    layout.changes = 300;
    enterReview();
    layout.review = 700;
    layout.reviewTouched = true;
    applyLayout(1600);
    exitReview();
    expect(layout.changes).toBe(300);
    expect(layout.review).toBe(700);
  });

  it("is not persisted: the app does not reopen mid-review", () => {
    applyLayout(1600);
    enterReview();
    expect(JSON.parse(localStorage.getItem("workbench.layout")!)).not.toHaveProperty("mode");
  });
});

describe("focusPane", () => {
  it("moves focus to a visible pane", () => {
    focusPane("sessions");
    expect(layout.focus).toBe("sessions");
  });

  it("refuses a pane you closed", () => {
    togglePane("changes");
    focusPane("changes");
    expect(layout.focus).toBe("agent");
  });

  it("refuses a pane the window folded away", () => {
    applyLayout(500);
    focusPane("sessions");
    expect(layout.focus).toBe("agent");
  });

  it("refuses the agent while it is hidden for review", () => {
    layout.mode = "reviewing";
    applyLayout(500);
    layout.focus = "changes";
    focusPane("agent");
    expect(layout.focus).toBe("changes");
  });
});

describe("persistence", () => {
  it("round-trips widths and intent", () => {
    layout.sessions = 300;
    layout.changes = 420;
    layout.review = 720;
    layout.changesChosen = false;
    saveLayout();

    reset();
    loadLayout();

    expect(layout.sessions).toBe(300);
    expect(layout.changes).toBe(420);
    expect(layout.review).toBe(720);
    expect(layout.changesChosen).toBe(false);
  });

  it("does not persist focus", () => {
    layout.focus = "changes";
    saveLayout();
    expect(JSON.parse(localStorage.getItem("workbench.layout")!)).not.toHaveProperty("focus");
  });

  it("keeps defaults when nothing is stored", () => {
    loadLayout();
    expect(layout.sessions).toBe(DEFAULT.sessions);
  });

  it("survives a corrupt entry", () => {
    localStorage.setItem("workbench.layout", "{not json");
    loadLayout();
    expect(layout.sessions).toBe(DEFAULT.sessions);
  });

  it("ignores fields of the wrong type", () => {
    localStorage.setItem(
      "workbench.layout",
      JSON.stringify({ sessions: "wide", changesChosen: "yes" }),
    );
    loadLayout();
    expect(layout.sessions).toBe(DEFAULT.sessions);
    expect(layout.changesChosen).toBe(true);
  });

  it("does not throw when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => saveLayout()).not.toThrow();
    expect(() => loadLayout()).not.toThrow();
  });
});

describe("the tree column", () => {
  it("opens at its default beside the content", () => {
    applyLayout(1600);
    enterReview();
    expect(layout.tree).toBe(DEFAULT.tree);
  });

  // Inside the pane the content is what has to stay readable.
  it("gives way before the content does", () => {
    applyLayout(1600);
    enterReview();
    layout.tree = 900;
    applyLayout(1600);
    expect(layout.review - SPLITTER - layout.tree).toBeGreaterThanOrEqual(MIN.viewer);
  });

  it("never drops below its own minimum", () => {
    layout.mode = "reviewing";
    layout.review = MIN_REVIEW;
    layout.tree = 10;
    applyLayout(1600);
    expect(layout.tree).toBe(MIN.tree);
  });

  it("is persisted with the other widths", () => {
    applyLayout(1600);
    enterReview();
    layout.tree = 260;
    saveLayout();
    expect(JSON.parse(localStorage.getItem("workbench.layout")!).tree).toBe(260);
  });
});
