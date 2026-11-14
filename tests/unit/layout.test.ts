import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT,
  FRAME_PADDING,
  FOLDED,
  MIN,
  NEEDS_AGENT_WHILE_REVIEWING,
  NEEDS_CHANGES,
  MIN_REVIEW,
  REVIEW_SHARE,
  NEEDS_SESSIONS,
  NEEDS_TERMINAL,
  SPLITTER,
  agentVisible,
  applyLayout,
  besideSessions,
  editTreeVisible,
  peekable,
  resetEditAgent,
  resetEditTree,
  resizeEditAgent,
  resizeEditTree,
  setEditing,
  toggleRightPane,
  browserFocused,
  changesVisible,
  enterReview,
  exitReview,
  focusPane,
  hideTerminal,
  layout,
  leftmost,
  loadLayout,
  peekSessions,
  returnFocus,
  rightmost,
  saveLayout,
  setProjectSort,
  sessionsShown,
  sessionsVisible,
  terminalVisible,
  togglePane,
  toggleTerminal,
} from "$lib/layout.svelte";

function reset() {
  layout.sessions = DEFAULT.sessions;
  layout.changes = DEFAULT.changes;
  layout.review = DEFAULT.review;
  layout.tree = DEFAULT.tree;
  layout.terminal = DEFAULT.terminal;
  layout.terminalList = DEFAULT.terminalList;
  layout.sessionsChosen = true;
  layout.changesChosen = true;
  layout.terminalChosen = false;
  layout.sessionsForced = false;
  layout.changesForced = false;
  layout.terminalForced = false;
  layout.agentHidden = false;
  layout.sessionsPeek = false;
  layout.reviewTouched = false;
  layout.mode = "working";
  layout.focus = "agent";
  layout.width = 1200;
  layout.height = 800;
  layout.projectSort = "used";
  layout.editTree = DEFAULT.editTree;
  layout.editAgent = DEFAULT.editAgent;
  layout.agentChosen = true;
  layout.editTreeForced = false;
}

beforeEach(reset);

describe("the sessions pane's width", () => {
  // Wide enough for a session's name beside its time at the default
  // window, as the mockup draws it; a width the user dragged to is theirs.
  it("opens at 300 pixels, and keeps a width already chosen", () => {
    expect(DEFAULT.sessions).toBe(300);
    applyLayout(1440 - FRAME_PADDING);
    expect(layout.sessions).toBe(300);

    localStorage.setItem("workbench.layout", JSON.stringify({ sessions: 232 }));
    loadLayout();
    applyLayout(1440 - FRAME_PADDING);
    expect(layout.sessions).toBe(232);
    localStorage.removeItem("workbench.layout");
  });
});

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

  it("moves the focus to the agent when the window narrows past the pane that has it", () => {
    applyLayout(1600);
    focusPane("sessions");
    expect(layout.focus).toBe("sessions");
    const before = layout.focusRequest;
    applyLayout(500);
    expect(layout.focus).toBe("agent");
    expect(layout.focusRequest).toBeGreaterThan(before);
    applyLayout(1600);
    focusPane("changes");
    applyLayout(NEEDS_CHANGES - 1);
    expect(layout.focus).toBe("agent");
  });

  it("does not ask for the keyboard when a dialog holds it as the window narrows past the pane", () => {
    applyLayout(1600);
    focusPane("sessions");
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    const field = document.createElement("input");
    dialog.append(field);
    document.body.append(dialog);
    field.focus();
    const asked = layout.focusRequest;
    applyLayout(500);
    expect(layout.focus).toBe("agent");
    expect(layout.focusRequest).toBe(asked);
    expect(document.activeElement).toBe(field);
    dialog.remove();
  });

  it("asks for the keyboard when it is on the page body as the window narrows past the pane", () => {
    applyLayout(1600);
    focusPane("sessions");
    (document.activeElement as HTMLElement | null)?.blur();
    const asked = layout.focusRequest;
    applyLayout(500);
    expect(layout.focusRequest).toBe(asked + 1);
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

  it("moves focus to the viewer and leaves it in the tree on exit", () => {
    applyLayout(1600);
    enterReview();
    expect(layout.focus).toBe("changes");
    const asked = layout.focusRequest;
    exitReview();
    expect(layout.focus).toBe("changes");
    expect(layout.focusRequest).toBe(asked + 1);
  });

  it("sends focus to the agent on exit when the changes pane is not shown", () => {
    applyLayout(1600);
    enterReview();
    layout.changesChosen = false;
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

  // The pane holds a tree beside the content, and opens at its share of the
  // window rather than at whatever the sessions pane happened to free.
  it("opens at its share of the window, with room for a tree and a diff", () => {
    applyLayout(1600);
    enterReview();
    expect(layout.review).toBe(Math.round(1600 * REVIEW_SHARE));
    expect(layout.review - SPLITTER - layout.tree).toBeGreaterThanOrEqual(
      MIN.viewer,
    );
  });

  it("opens no narrower than its floor in a small window", () => {
    applyLayout(1160);
    enterReview();
    expect(layout.review).toBe(DEFAULT.review);
  });

  it("takes more than that when the changes pane was already wide", () => {
    applyLayout(1600);
    layout.changes = 1200;
    enterReview();
    expect(layout.review).toBeGreaterThan(Math.round(1600 * REVIEW_SHARE));
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
    applyLayout(FOLDED + SPLITTER + MIN_REVIEW + SPLITTER + MIN.agent);
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
    expect(
      JSON.parse(localStorage.getItem("workbench.layout")!),
    ).not.toHaveProperty("mode");
  });
});

// Reviewing folds the sessions pane, and opening it for real would close
// the viewer: peeked, it is drawn over the agent instead, and nothing moves.
describe("peeking the sessions pane", () => {
  it("is for reviewing only", () => {
    applyLayout(1600);
    peekSessions(true);
    expect(layout.sessionsPeek).toBe(false);
    expect(sessionsShown()).toBe(true);
  });

  it("shows the pane open while its column stays folded", () => {
    applyLayout(1600);
    enterReview();
    expect(sessionsShown()).toBe(false);
    peekSessions(true);
    expect(layout.sessionsPeek).toBe(true);
    expect(sessionsShown()).toBe(true);
    expect(sessionsVisible()).toBe(false);
    expect(layout.mode).toBe("reviewing");
  });

  it("lets the pane take the keyboard, and hands it to the viewer when put back", () => {
    applyLayout(1600);
    enterReview();
    peekSessions(true);
    focusPane("sessions");
    expect(layout.focus).toBe("sessions");
    const asked = layout.focusRequest;
    peekSessions(false);
    expect(layout.sessionsPeek).toBe(false);
    expect(layout.focus).toBe("changes");
    expect(layout.focusRequest).toBe(asked + 1);
  });

  it("leaves the keyboard alone when it was elsewhere", () => {
    applyLayout(1600);
    enterReview();
    peekSessions(true);
    layout.focus = "agent";
    peekSessions(false);
    expect(layout.focus).toBe("agent");
  });

  it("ends with the review", () => {
    applyLayout(1600);
    enterReview();
    peekSessions(true);
    exitReview();
    expect(layout.sessionsPeek).toBe(false);
    expect(sessionsVisible()).toBe(true);
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

  it("hands the keyboard back to the pane that has it", () => {
    focusPane("sessions");
    const asked = layout.focusRequest;
    returnFocus();
    expect(layout.focus).toBe("sessions");
    expect(layout.focusRequest).toBe(asked + 1);
  });
});

describe("browserFocused", () => {
  it("marks the changes pane focused without asking for the keyboard", () => {
    focusPane("sessions");
    const asked = layout.focusRequest;
    browserFocused();
    expect(layout.focus).toBe("changes");
    expect(layout.focusRequest).toBe(asked);
  });

  it("does nothing while the changes pane is closed", () => {
    togglePane("changes");
    focusPane("agent");
    browserFocused();
    expect(layout.focus).toBe("agent");
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

  it("remembers how the projects are sorted, and reads only a sort it knows", () => {
    setProjectSort("name");
    const saved = JSON.parse(localStorage.getItem("workbench.layout")!);
    expect(saved.projectSort).toBe("name");
    expect(saved).not.toHaveProperty("sessionsView");

    reset();
    loadLayout();
    expect(layout.projectSort).toBe("name");

    localStorage.setItem("workbench.layout", JSON.stringify({ projectSort: "sideways", sessionsView: "status" }));
    reset();
    loadLayout();
    expect(layout.projectSort).toBe("used");
    expect(layout).not.toHaveProperty("sessionsView");
  });

  it("does not persist focus", () => {
    layout.focus = "changes";
    saveLayout();
    expect(
      JSON.parse(localStorage.getItem("workbench.layout")!),
    ).not.toHaveProperty("focus");
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
    expect(layout.review - SPLITTER - layout.tree).toBeGreaterThanOrEqual(
      MIN.viewer,
    );
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
    expect(JSON.parse(localStorage.getItem("workbench.layout")!).tree).toBe(
      260,
    );
  });
});

describe("the terminal panel", () => {
  it("is closed until asked for", () => {
    applyLayout(1600, 900);
    expect(terminalVisible()).toBe(false);
  });

  it("opens at its default height and takes focus", () => {
    applyLayout(1600, 900);
    toggleTerminal();
    expect(terminalVisible()).toBe(true);
    expect(layout.terminal).toBe(DEFAULT.terminal);
    expect(layout.focus).toBe("terminal");
  });

  it("hands focus back to the agent when it closes", () => {
    applyLayout(1600, 900);
    toggleTerminal();
    toggleTerminal();
    expect(terminalVisible()).toBe(false);
    expect(layout.focus).toBe("agent");
  });

  it("leaves focus alone when closed from another pane", () => {
    applyLayout(1600, 900);
    toggleTerminal();
    layout.focus = "changes";
    toggleTerminal();
    expect(layout.focus).toBe("changes");
  });

  it("never squeezes the panes above below what they keep", () => {
    layout.terminalChosen = true;
    layout.terminal = 2000;
    applyLayout(1600, 700);
    expect(700 - SPLITTER - layout.terminal).toBeGreaterThanOrEqual(MIN.panes);
  });

  it("never drops below its own minimum", () => {
    layout.terminalChosen = true;
    layout.terminal = 10;
    applyLayout(1600, 900);
    expect(layout.terminal).toBe(MIN.terminal);
  });

  // The same rule as the side panes: fold rather than squeeze, and come back
  // as it was once there is room again.
  it("folds away when the window is too short, keeping the intent", () => {
    layout.terminalChosen = true;
    layout.terminal = 300;
    applyLayout(1600, NEEDS_TERMINAL - 1);
    expect(terminalVisible()).toBe(false);
    expect(layout.terminalChosen).toBe(true);

    applyLayout(1600, 900);
    expect(terminalVisible()).toBe(true);
    expect(layout.terminal).toBe(300);
  });

  it("moves focus off a panel the window folded away", () => {
    layout.terminalChosen = true;
    applyLayout(1600, 900);
    layout.focus = "terminal";
    applyLayout(1600, NEEDS_TERMINAL - 1);
    expect(layout.focus).toBe("agent");
  });

  it("is independent of the review shape", () => {
    applyLayout(1600, 900);
    toggleTerminal();
    enterReview();
    expect(terminalVisible()).toBe(true);
    exitReview();
    expect(terminalVisible()).toBe(true);
  });

  it("can be hidden without toggling twice", () => {
    applyLayout(1600, 900);
    hideTerminal();
    expect(terminalVisible()).toBe(false);
    toggleTerminal();
    hideTerminal();
    expect(terminalVisible()).toBe(false);
    expect(layout.focus).toBe("agent");
  });

  it("refuses focus while it is closed", () => {
    focusPane("terminal");
    expect(layout.focus).toBe("agent");
  });

  it("remembers its height and whether it was open", () => {
    applyLayout(1600, 900);
    toggleTerminal();
    layout.terminal = 333;
    saveLayout();

    reset();
    loadLayout();

    expect(layout.terminal).toBe(333);
    expect(layout.terminalChosen).toBe(true);
  });
});

describe("the terminal list", () => {
  it("opens at its default beside the shells", () => {
    applyLayout(1600, 900);
    expect(layout.terminalList).toBe(DEFAULT.terminalList);
  });

  it("gives way before the shells do", () => {
    layout.terminalList = 900;
    applyLayout(1000, 900);
    expect(1000 - SPLITTER - layout.terminalList).toBeGreaterThanOrEqual(
      MIN.shells,
    );
  });

  it("never drops below its own minimum", () => {
    layout.terminalList = 10;
    applyLayout(1600, 900);
    expect(layout.terminalList).toBe(MIN.terminalList);
  });

  it("is persisted with the other widths", () => {
    layout.terminalList = 260;
    saveLayout();
    reset();
    loadLayout();
    expect(layout.terminalList).toBe(260);
  });
});

describe("the leftmost pane", () => {
  it("is the sessions pane while that is showing", () => {
    applyLayout(1600, 900);
    expect(leftmost()).toBe("sessions");
  });

  it("is the agent once the sessions pane is gone", () => {
    togglePane("sessions");
    expect(leftmost()).toBe("agent");
    layout.sessionsChosen = true;
    applyLayout(500);
    expect(leftmost()).toBe("agent");
  });

  it("is the viewer when reviewing hides the agent too", () => {
    layout.mode = "reviewing";
    applyLayout(500);
    expect(leftmost()).toBe("changes");
  });
});

describe("the rightmost pane", () => {
  it("is the changes pane while that is showing", () => {
    applyLayout(1600, 900);
    expect(rightmost()).toBe("changes");
  });

  it("is the agent once the changes pane is gone", () => {
    togglePane("changes");
    expect(rightmost()).toBe("agent");
  });

  it("is the viewer when reviewing, whatever else folded", () => {
    layout.mode = "reviewing";
    applyLayout(500);
    expect(rightmost()).toBe("changes");
  });
});

/** The editor's width while editing, from what the store laid out. */
function editorWidth(width: number) {
  const sessions = (sessionsVisible() ? layout.sessions : FOLDED) + SPLITTER;
  const tree = editTreeVisible() ? layout.editTree + SPLITTER : 0;
  const agent = agentVisible() ? SPLITTER + layout.editAgent : 0;
  return width - sessions - tree - agent;
}

describe("the editing shape", () => {
  it("keeps every pane open when the window holds them beside the editor", () => {
    applyLayout(1728);
    setEditing(true);
    expect(layout.mode).toBe("editing");
    expect(sessionsVisible()).toBe(true);
    expect(editTreeVisible()).toBe(true);
    expect(agentVisible()).toBe(true);
    expect(layout.editTree).toBe(DEFAULT.editTree);
    expect(layout.editAgent).toBe(DEFAULT.editAgent);
    expect(editorWidth(1728)).toBeGreaterThanOrEqual(MIN.editor);
  });

  it("folds the sessions pane first, forced and not chosen", () => {
    applyLayout(1440);
    setEditing(true);
    expect(sessionsVisible()).toBe(false);
    expect(layout.sessionsForced).toBe(true);
    expect(layout.sessionsChosen).toBe(true);
    expect(editTreeVisible()).toBe(true);
    expect(agentVisible()).toBe(true);
    expect(editorWidth(1440)).toBeGreaterThanOrEqual(MIN.editor);
  });

  it("then gives up the tree's column", () => {
    applyLayout(1240);
    setEditing(true);
    expect(sessionsVisible()).toBe(false);
    expect(editTreeVisible()).toBe(false);
    expect(agentVisible()).toBe(true);
    expect(layout.editAgent).toBe(DEFAULT.editAgent);
    expect(editorWidth(1240)).toBeGreaterThanOrEqual(MIN.editor);
  });

  it("then hides the agent rather than squeezing it below its minimum", () => {
    applyLayout(1000);
    setEditing(true);
    expect(agentVisible()).toBe(false);
    expect(layout.agentHidden).toBe(true);
    expect(layout.agentChosen).toBe(true);
    expect(layout.editAgent).toBeGreaterThanOrEqual(MIN.agent);
  });

  it("never lets the agent or the tree drop below their minimums", () => {
    for (const width of [1080, 1120, 1300, 1360]) {
      applyLayout(width);
      setEditing(true);
      if (agentVisible()) expect(layout.editAgent).toBeGreaterThanOrEqual(MIN.agent);
      if (editTreeVisible()) expect(layout.editTree).toBeGreaterThanOrEqual(MIN.tree);
      setEditing(false);
    }
  });

  it("gives the panes back as the window grows", () => {
    applyLayout(1000);
    setEditing(true);
    applyLayout(1728);
    expect(sessionsVisible()).toBe(true);
    expect(editTreeVisible()).toBe(true);
    expect(agentVisible()).toBe(true);
  });

  it("forgets the fold it forced when the window goes back to agent mode", () => {
    applyLayout(1440);
    setEditing(true);
    setEditing(false);
    expect(layout.mode).toBe("working");
    expect(sessionsVisible()).toBe(true);
    expect(agentVisible()).toBe(true);
  });

  it("keeps the files pane in the middle whatever its toggle says", () => {
    layout.changesChosen = false;
    applyLayout(1728);
    setEditing(true);
    expect(changesVisible()).toBe(true);
  });

  it("gives the keyboard to the files pane on the way in, and the agent on the way out", () => {
    applyLayout(1728);
    const asked = layout.focusRequest;
    setEditing(true);
    expect(layout.focus).toBe("changes");
    expect(layout.focusRequest).toBe(asked + 1);
    setEditing(false);
    expect(layout.focus).toBe("agent");
  });

  it("does not open the viewer, or close it, while editing", () => {
    applyLayout(1728);
    setEditing(true);
    enterReview();
    expect(layout.mode).toBe("editing");
    exitReview();
    expect(layout.mode).toBe("editing");
  });
});

describe("the right pane while editing", () => {
  it("is the agent, and its toggle hides it as a choice", () => {
    applyLayout(1728);
    setEditing(true);
    toggleRightPane();
    expect(agentVisible()).toBe(false);
    expect(layout.agentChosen).toBe(false);
    expect(layout.agentHidden).toBe(false);
    toggleRightPane();
    expect(agentVisible()).toBe(true);
  });

  it("is the changes pane in agent mode", () => {
    applyLayout(1728);
    toggleRightPane();
    expect(changesVisible()).toBe(false);
    expect(layout.changesChosen).toBe(false);
  });

  it("hands the keyboard to the files pane when the agent goes with it", () => {
    applyLayout(1728);
    setEditing(true);
    focusPane("agent");
    toggleRightPane();
    expect(layout.focus).toBe("changes");
  });

  it("gives the editor the room the agent leaves, and the panes before it", () => {
    applyLayout(1440);
    setEditing(true);
    expect(sessionsVisible()).toBe(false);
    toggleRightPane();
    expect(sessionsVisible()).toBe(true);
    expect(editorWidth(1440)).toBeGreaterThanOrEqual(MIN.editor);
  });

  it("moves the keyboard off an agent the window hides", () => {
    applyLayout(1728);
    setEditing(true);
    focusPane("agent");
    applyLayout(1000);
    expect(layout.focus).toBe("changes");
  });
});

describe("the editing widths", () => {
  it("drag the agent without folding or hiding a pane", () => {
    applyLayout(1728);
    setEditing(true);
    layout.width = 1728;
    resizeEditAgent(-2000);
    expect(sessionsVisible()).toBe(true);
    expect(editTreeVisible()).toBe(true);
    expect(agentVisible()).toBe(true);
    expect(editorWidth(1728)).toBe(MIN.editor);
    resizeEditAgent(2000);
    expect(layout.editAgent).toBe(MIN.agent);
  });

  it("drag the tree on the same terms", () => {
    applyLayout(1728);
    setEditing(true);
    resizeEditTree(2000);
    expect(sessionsVisible()).toBe(true);
    expect(agentVisible()).toBe(true);
    expect(editorWidth(1728)).toBe(MIN.editor);
    resizeEditTree(-2000);
    expect(layout.editTree).toBe(MIN.tree);
  });

  it("go back to their defaults", () => {
    applyLayout(1728);
    setEditing(true);
    resizeEditAgent(-100);
    resizeEditTree(60);
    resetEditAgent();
    resetEditTree();
    expect(layout.editAgent).toBe(DEFAULT.editAgent);
    expect(layout.editTree).toBe(DEFAULT.editTree);
  });

  it("are remembered apart from the other shapes' widths", () => {
    applyLayout(1728);
    setEditing(true);
    resizeEditAgent(-60);
    resizeEditTree(30);
    const agent = layout.editAgent;
    const tree = layout.editTree;
    setEditing(false);
    expect(layout.changes).toBe(DEFAULT.changes);
    expect(layout.tree).toBe(DEFAULT.tree);
    saveLayout();
    reset();
    loadLayout();
    expect(layout.editAgent).toBe(agent);
    expect(layout.editTree).toBe(tree);
  });
});

describe("editor mode across a restart", () => {
  it("comes back in editor mode, and with the agent's toggle as it was", () => {
    applyLayout(1728);
    setEditing(true);
    toggleRightPane();
    reset();
    loadLayout();
    expect(layout.mode).toBe("editing");
    expect(layout.agentChosen).toBe(false);
  });

  it("comes back in agent mode once it was left", () => {
    applyLayout(1728);
    setEditing(true);
    setEditing(false);
    reset();
    loadLayout();
    expect(layout.mode).toBe("working");
  });

  it("never comes back with a fold the window forced", () => {
    applyLayout(1440);
    setEditing(true);
    const stored = JSON.parse(localStorage.getItem("workbench.layout")!);
    expect(stored.sessionsForced).toBeUndefined();
    expect(stored.editTreeForced).toBeUndefined();
    expect(stored.sessionsChosen).toBe(true);
  });
});

describe("peeking while editing", () => {
  it("peeks a pane the window folded for the editor", () => {
    applyLayout(1440);
    setEditing(true);
    expect(peekable()).toBe(true);
    peekSessions(true);
    expect(layout.sessionsPeek).toBe(true);
    expect(sessionsShown()).toBe(true);
  });

  it("does not peek a pane that has room to open", () => {
    applyLayout(1728);
    setEditing(true);
    togglePane("sessions");
    expect(peekable()).toBe(false);
    peekSessions(true);
    expect(layout.sessionsPeek).toBe(false);
  });

  it("hands the keyboard to the files pane when put back", () => {
    applyLayout(1440);
    setEditing(true);
    peekSessions(true);
    focusPane("sessions");
    peekSessions(false);
    expect(layout.focus).toBe("changes");
  });

  it("ends when the window grows enough to open the pane", () => {
    applyLayout(1440);
    setEditing(true);
    peekSessions(true);
    applyLayout(1728);
    expect(layout.sessionsPeek).toBe(false);
    expect(sessionsVisible()).toBe(true);
  });
});

describe("the edges while editing", () => {
  it("puts the files pane beside the sessions column and leftmost when it folds", () => {
    applyLayout(1440);
    setEditing(true);
    expect(besideSessions()).toBe("changes");
    expect(leftmost()).toBe("changes");
  });

  it("puts the agent rightmost, and the files pane once the agent is away", () => {
    applyLayout(1728);
    setEditing(true);
    expect(rightmost()).toBe("agent");
    toggleRightPane();
    expect(rightmost()).toBe("changes");
  });
});
