import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, SettingsRequest } from "$lib/core";

const answers: {
  id: string;
  cwd: string;
  content: string | null;
  error: string | null;
}[] = [];
const sets: Partial<Settings>[] = [];
const sheets: string[] = [];
let refuseSheet: string | null = null;
let refuseSettings: string | null = null;

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsAnswer: async (
      id: string,
      cwd: string,
      content: string | null,
      error: string | null,
    ) => {
      answers.push({ id, cwd, content, error });
    },
    settingsSet: async (change: Partial<Settings>) => {
      if (refuseSettings !== null) throw new Error(refuseSettings);
      sets.push(change);
      return change as Settings;
    },
    stylesSet: async (css: string) => {
      if (refuseSheet !== null) throw new Error(refuseSheet);
      sheets.push(css);
      return { css, problem: null };
    },
  }),
}));

import { PRESETS, keys, resetKeys } from "$lib/keys.svelte";
import { resetPersist } from "$lib/persist";
import { sessions } from "$lib/sessions.svelte";
import {
  UNDO_FOR,
  allowChange,
  declineChange,
  describeSettings,
  dismissUndo,
  handle,
  plan,
  planStyles,
  planTheme,
  resetSettingsTools,
  settingsAsk,
  undoChange,
} from "$lib/settingsTools.svelte";
import { setThemes, theme } from "$lib/theme.svelte";
import { resetUserStyles, userStyles } from "$lib/userStyles.svelte";
import {
  addWorkflow,
  adoptWorkflows,
  changed,
  defaultWorkflow,
  setOverride,
  workflows,
  workflowsSettings,
} from "$lib/workflows.svelte";

let next = 0;
function request(
  tool: SettingsRequest["tool"],
  args: Record<string, unknown> = {},
  session: string | null = null,
): SettingsRequest {
  next += 1;
  return { id: `call-${next}`, tool, arguments: args, cwd: "/p", session };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  theme.themes = {};
  sheets.length = 0;
  refuseSheet = null;
  refuseSettings = null;
  resetUserStyles();
  answers.length = 0;
  sets.length = 0;
  resetSettingsTools();
  resetPersist();
  adoptWorkflows(undefined);
  resetKeys();
  theme.choice = "system";
  theme.palette = "teal";
  theme.look = "modern";
  theme.mono = "system";
  theme.sans = "system";
  delete document.documentElement.dataset.palette;
  delete document.documentElement.dataset.look;
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the settings tool", () => {
  it("reads the settings as they are, with what each takes", async () => {
    theme.palette = "amber";
    await handle(request("settings"));
    expect(answers).toHaveLength(1);
    const text = answers[0].content!;
    expect(answers[0].error).toBeNull();
    expect(text).toContain("palette: amber (one of teal, indigo, amber, rose, mono)");
    expect(text).toContain("look: modern (one of modern, terminal)");
    expect(text).toContain("review: d  (Open or close the file viewer)");
    expect(text).toContain("session.next: shift+down");
    expect(text).toContain("user's to change");
  });

  it("answers a call delivered twice once", async () => {
    const call = request("settings");
    await handle(call);
    await handle(call);
    expect(answers).toHaveLength(1);
  });
});

describe("plan", () => {
  it("lists only what moves, in the user's words", () => {
    const { changes } = plan({ palette: "amber", look: "modern", appearance: "dark" });
    expect(changes).toEqual([
      { field: "appearance", label: "Appearance", from: "System", to: "Dark" },
      { field: "palette", label: "Palette", from: "Teal", to: "Amber" },
    ]);
  });

  it("refuses a value a setting does not take, and names what it does", () => {
    expect(() => plan({ look: "baroque" })).toThrow(/look is one of modern, terminal/);
    expect(() => plan({ terminalFont: "comic" })).toThrow(/terminalFont is one of/);
  });

  it("refuses a setting that does not exist", () => {
    expect(() => plan({ colour: "red" })).toThrow(/no setting called colour/);
  });

  it("refuses the hooks and the plugins as the user's own", () => {
    expect(() => plan({ hooks: { everywhere: false } })).toThrow(/user's to change/);
    expect(() => plan({ plugins: [] })).toThrow(/user's to change/);
    expect(() => plan({ notifications: false })).toThrow(/user's to change/);
    expect(() => plan({ chime: true })).toThrow(/user's to change/);
  });

  it("reads chords as text, the modifier implied", () => {
    const { next, changes } = plan({ keys: { review: "shift+g", find: "cmd+alt+k" } });
    expect(next.keys?.review).toEqual({ key: "g", shift: true, alt: false });
    expect(next.keys?.find).toEqual({ key: "k", shift: false, alt: true });
    expect(changes.map((change) => change.field)).toEqual(["keys.review", "keys.find"]);
    expect(changes[0].label).toBe("Open or close the file viewer");
  });

  it("names a whole preset as one change", () => {
    const { next, changes } = plan({ keyPreset: "vim" });
    expect(next.keys).toEqual(PRESETS.vim);
    expect(changes).toEqual([{ field: "keyPreset", label: "Keys", from: "Default", to: "Vim" }]);
  });

  it("lays chords over a preset", () => {
    const { next } = plan({ keyPreset: "vim", keys: { review: "g" } });
    expect(next.keys?.["focus.sessions"]).toEqual(PRESETS.vim["focus.sessions"]);
    expect(next.keys?.review).toEqual({ key: "g", shift: false, alt: false });
  });

  it("refuses a table with a chord twice, or one the agent needs", () => {
    expect(() => plan({ keys: { review: "e" } })).toThrow(/would be both/);
    expect(() => plan({ keys: { review: "c" } })).toThrow(/stays with the agent/);
    expect(() => plan({ keys: { review: "shift+c" } })).not.toThrow();
  });

  it("refuses an action that does not exist or a chord that does not read", () => {
    expect(() => plan({ keys: { launch: "k" } })).toThrow(/no action called launch/);
    expect(() => plan({ keys: { review: "hyper+k" } })).toThrow(/not a chord/);
    expect(() => plan({ keys: { review: 7 } })).toThrow(/not a chord/);
    expect(() => plan({ keys: "shift+k" })).toThrow(/object of chords/);
    expect(() => plan({ keyPreset: "emacs" })).toThrow(/keyPreset is one of default, vim/);
  });
});

describe("a change", () => {
  it("is refused at once when it will not do, and the user is not asked", async () => {
    await handle(request("settings_change", { look: "baroque" }));
    expect(settingsAsk.asking).toBeNull();
    expect(answers[0].error).toMatch(/look is one of/);
    expect(theme.look).toBe("modern");
  });

  it("that changes nothing is answered without asking", async () => {
    await handle(request("settings_change", { palette: "teal" }));
    expect(settingsAsk.asking).toBeNull();
    expect(answers[0].content).toMatch(/already so/);
  });

  it("waits for the user, and is made when they allow it", async () => {
    sessions.all = [{ id: "s-1", key: "k1", title: "Tidy the docs" } as never];
    const done = handle(request("settings_change", { palette: "amber", reason: "warmer" }, "s-1"));
    await settle();
    expect(answers).toHaveLength(0);
    expect(theme.palette).toBe("teal");
    const ask = settingsAsk.asking!;
    expect(ask.caller).toBe("Tidy the docs");
    expect(ask.reason).toBe("warmer");
    expect(ask.changes).toHaveLength(1);

    allowChange();
    await done;
    expect(theme.palette).toBe("amber");
    expect(document.documentElement.dataset.palette).toBe("amber");
    expect(sets).toContainEqual({ palette: "amber" });
    expect(answers[0].content).toMatch(/allowed the change\. Palette is now Amber/);
    expect(settingsAsk.undo?.caller).toBe("Tidy the docs");
    sessions.all = [];
  });

  it("is told the core refused it, when the user allowed it and the core could not keep it", async () => {
    refuseSettings = "the settings file could not be read, so nothing was saved";
    const done = handle(request("settings_change", { palette: "amber" }));
    await settle();
    allowChange();
    await done;
    expect(answers[0].error).toMatch(/allowed the change, but it could not be saved/);
    expect(answers[0].error).toMatch(/could not be read/);
    expect(answers[0].content).toBeNull();
    expect(settingsAsk.undo).toBeNull();
  });

  it("changes nothing when the user declines, and says so", async () => {
    const done = handle(request("settings_change", { look: "terminal" }));
    await settle();
    declineChange();
    await done;
    expect(theme.look).toBe("modern");
    expect(sets).toEqual([]);
    expect(answers[0].error).toBe("The user declined the change. Nothing changed.");
    expect(settingsAsk.undo).toBeNull();
  });

  it("waits behind another one being asked", async () => {
    const first = handle(request("settings_change", { palette: "rose" }));
    const second = handle(request("settings_change", { look: "terminal" }));
    await settle();
    expect(settingsAsk.asking?.changes[0].field).toBe("palette");
    allowChange();
    await first;
    await settle();
    expect(settingsAsk.asking?.changes[0].field).toBe("look");
    declineChange();
    await second;
    expect(theme.palette).toBe("rose");
    expect(theme.look).toBe("modern");
    expect(answers.map((answer) => answer.error === null)).toEqual([true, false]);
  });

  it("is read against the settings the one before it left", async () => {
    const first = handle(request("settings_change", { palette: "rose" }));
    const second = handle(request("settings_change", { palette: "mono" }));
    const third = handle(request("settings_change", { palette: "rose" }));
    await settle();
    allowChange();
    await first;
    await settle();
    expect(settingsAsk.asking?.changes[0]).toMatchObject({ from: "Rose", to: "Mono" });
    declineChange();
    await second;
    await settle();
    // Rose is what the settings already are: nothing to ask.
    await third;
    expect(settingsAsk.asking).toBeNull();
    expect(answers.at(-1)?.content).toMatch(/already so/);
  });

  it("can be undone, which puts back only what it moved", async () => {
    const done = handle(
      request("settings_change", { palette: "amber", keys: { review: "g" } }),
    );
    await settle();
    allowChange();
    await done;
    expect(keys.bindings.review).toEqual({ key: "g", shift: false, alt: false });
    // The user changes something else meanwhile; undo leaves that alone.
    theme.look = "terminal";
    undoChange();
    expect(theme.palette).toBe("teal");
    expect(keys.bindings.review).toEqual(PRESETS.default.review);
    expect(theme.look).toBe("terminal");
    expect(settingsAsk.undo).toBeNull();
    expect(sets.at(-1)).toEqual({ keys: { ...PRESETS.default } });
  });

  it("is offered for undo for a while, then kept", async () => {
    vi.useFakeTimers();
    const done = handle(request("settings_change", { palette: "mono" }));
    await vi.advanceTimersByTimeAsync(0);
    allowChange();
    await done;
    expect(settingsAsk.undo).not.toBeNull();
    await vi.advanceTimersByTimeAsync(UNDO_FOR + 10);
    expect(settingsAsk.undo).toBeNull();
    undoChange();
    expect(theme.palette).toBe("mono");
  });

  it("can be kept at once", async () => {
    const done = handle(request("settings_change", { palette: "mono" }));
    await settle();
    allowChange();
    await done;
    dismissUndo();
    undoChange();
    expect(theme.palette).toBe("mono");
  });
});

describe("describeSettings", () => {
  it("lists every action with its chord", () => {
    const text = describeSettings();
    for (const action of Object.keys(PRESETS.default)) {
      expect(text).toContain(`  ${action}: `);
    }
  });
});

describe("a theme", () => {
  const dusk = {
    name: "dusk",
    label: "Dusk",
    light: { accent: "#7a4a8c" },
    dark: { accent: "#c39ad4" },
    shape: { radius: "10px" },
  };

  it("is a new theme and a switch to it", () => {
    const { next, changes, theme: shown } = planTheme(dusk);
    expect(shown.label).toBe("Dusk");
    expect(next.palette).toBe("dusk");
    expect(next.themes?.dusk.light.accent).toBe("#7a4a8c");
    expect(changes).toEqual([
      { field: "theme", label: "Theme", from: "none", to: "Dusk, new" },
      { field: "palette", label: "Palette", from: "Teal", to: "Dusk" },
    ]);
  });

  it("saved again under its name while in use is one change", () => {
    setThemes({ dusk: { label: "Dusk", light: {}, dark: {}, shape: {} } }, "dusk");
    const { changes } = planTheme(dusk);
    expect(changes).toEqual([
      { field: "theme", label: "Theme", from: "Dusk as it was", to: "Dusk, changed" },
    ]);
    setThemes({ dusk: planTheme(dusk).theme }, "dusk");
    expect(planTheme(dusk).changes).toEqual([]);
  });

  it("is refused when it cannot be read, or breaks the rules", () => {
    expect(() => planTheme({ ...dusk, light: { ink: "#dddddd" } })).toThrow(/contrast/);
    expect(() => planTheme({ ...dusk, name: "Teal" })).toThrow(/not a theme's name/);
    expect(() => planTheme({ ...dusk, light: { accent: "blue" } })).toThrow(/hex colour/);
    expect(() => planTheme({ ...dusk, extra: true })).toThrow(/not extra/);
  });

  it("is shown to the user as swatches, and kept only if allowed", async () => {
    const done = handle(request("theme_save", { ...dusk, reason: "Purple, as asked." }));
    await settle();
    expect(settingsAsk.asking?.theme?.light.accent).toBe("#7a4a8c");
    expect(settingsAsk.asking?.reason).toBe("Purple, as asked.");
    expect(theme.themes).toEqual({});
    allowChange();
    await done;
    expect(theme.palette).toBe("dusk");
    expect(theme.themes.dusk.shape.radius).toBe("10px");
    expect(sets.at(-1)).toMatchObject({ palette: "dusk", themes: { dusk: { label: "Dusk" } } });
    expect(answers[0].content).toMatch(/allowed the change/);
  });

  it("is taken away again by undo, with the palette it replaced", async () => {
    theme.palette = "rose";
    const done = handle(request("theme_save", dusk));
    await settle();
    allowChange();
    await done;
    undoChange();
    expect(theme.themes).toEqual({});
    expect(theme.palette).toBe("rose");
  });

  it("the user has can be chosen by settings_change", () => {
    setThemes({ dusk: planTheme(dusk).theme });
    const { changes } = plan({ palette: "dusk" });
    expect(changes).toEqual([{ field: "palette", label: "Palette", from: "Teal", to: "Dusk" }]);
    expect(describeSettings()).toContain("dusk (Dusk)");
    expect(describeSettings()).toMatch(/palette: teal \(one of teal, indigo, amber, rose, mono, dusk\)/);
  });
});

describe("the user's stylesheet", () => {
  const css = "header {\n  letter-spacing: 0.2em;\n}\n";

  it("is the sheet and the styles turned on", () => {
    const { next, changes, css: shown } = planStyles({ css, reason: "wider" });
    expect(shown).toBe(css);
    expect(next.css).toBe(css);
    expect(next.userStyles).toBe(true);
    expect(changes).toEqual([
      { field: "css", label: "Stylesheet", from: "none", to: "3 lines" },
      { field: "userStyles", label: "Custom styles", from: "Off", to: "On" },
    ]);
  });

  it("is refused when it would load anything, in the core's words", () => {
    expect(() => planStyles({ css: "@import 'https://x';" })).toThrow(/imports another/);
    expect(() => planStyles({ css: "a { background: url(https://x) }" })).toThrow(/url\(\)/);
    expect(() => planStyles({})).toThrow(/needs the css/);
    expect(() => planStyles({ css, path: "/etc" })).toThrow(/not path/);
  });

  it("is shown to the user as it is, and written and turned on when allowed", async () => {
    const done = handle(request("styles_write", { css }));
    await settle();
    expect(settingsAsk.asking?.css).toBe(css);
    expect(sheets).toEqual([]);
    allowChange();
    await done;
    expect(sheets).toEqual([css]);
    expect(userStyles.on).toBe(true);
    expect(sets).toContainEqual({ userStyles: true });
    expect(answers[0].content).toMatch(/allowed the change/);
  });

  it("is put back as it was by undo", async () => {
    userStyles.css = "p { color: red; }";
    const done = handle(request("styles_write", { css }));
    await settle();
    allowChange();
    await done;
    undoChange();
    await settle();
    expect(sheets).toEqual([css, "p { color: red; }"]);
    expect(userStyles.on).toBe(false);
  });

  it("refused by the core after all is the answer, and nothing else changes", async () => {
    refuseSheet = "could not write user.css";
    const done = handle(request("styles_write", { css }));
    await settle();
    allowChange();
    await done;
    expect(answers[0].error).toBe("could not write user.css");
    expect(userStyles.on).toBe(false);
    expect(settingsAsk.undo).toBeNull();
  });

  it("is turned on or off by settings_change", () => {
    expect(plan({ userStyles: true }).changes).toEqual([
      { field: "userStyles", label: "Custom styles", from: "Off", to: "On" },
    ]);
    expect(() => plan({ userStyles: "yes" })).toThrow(/true or false/);
  });

  it("is read out by the settings tool, with its reason when it is not used", () => {
    userStyles.css = "header { color: red; }";
    expect(describeSettings()).toContain("```css\nheader { color: red; }\n```");
    userStyles.css = "";
    userStyles.problem = "the stylesheet imports another";
    expect(describeSettings()).toContain("is not used: the stylesheet imports another");
  });
});

describe("workflows", () => {
  const quick = {
    name: "Quick fix",
    orchestrator: { agent: "claude-code", model: "opus" },
    steps: [{ kind: "work", name: "Fix", models: [], parallel: 2 }],
  };

  it("are read with the shape a change writes them in", async () => {
    await handle(request("settings"));
    const text = answers[0].content!;
    expect(text).toContain("workflows: a workflow says which model a session starts on");
    expect(text).toContain('"name": "Build and review"');
    expect(text).toContain('"backTo": "Work"');
    expect(text).toContain("New sessions start with the workflow Build and review.");
    expect(text).toContain("workflow argument");
    expect(text).toContain("claude-code takes the models fable, opus, sonnet, haiku");
    expect(text).toContain("codex takes default");
    expect(text).toContain("Which workflow a project follows is the user's to choose.");
  });

  it("are said to be none when there are none", async () => {
    adoptWorkflows({ list: [], default: null, overrides: {} });
    await handle(request("settings"));
    expect(answers[0].content).toContain("none.");
    expect(answers[0].content).toContain("New sessions start with no workflow.");
  });

  /** What a call would make of the workflows as they are. */
  const made = (args: Record<string, unknown>) =>
    changed(workflowsSettings(), plan(args).next.workflows!);

  it("add one by name, shown to the user as what it makes of the workflows", () => {
    const { changes } = plan({ workflow: quick });
    expect(made({ workflow: quick }).list.map((workflow) => workflow.name)).toEqual([
      "Build and review",
      "Quick fix",
    ]);
    expect(made({ workflow: quick }).default).toBe("Build and review");
    expect(changes).toEqual([
      {
        field: "workflow.Quick fix",
        label: "Workflow Quick fix",
        from: "none",
        to: "Opus directs Fix (any model, 2 at once), new",
      },
    ]);
  });

  it("replace the one of the name written, and are shown from what it was", () => {
    const written = { ...defaultWorkflow(), orchestrator: { agent: "claude-code", model: "opus" } };
    const { changes } = plan({ workflow: written });
    expect(made({ workflow: written }).list).toHaveLength(1);
    expect(made({ workflow: written }).list[0].orchestrator.model).toBe("opus");
    expect(changes).toHaveLength(1);
    expect(changes[0].from).toMatch(/^Fable directs Work/);
    expect(changes[0].to).toMatch(/^Opus directs Work/);
  });

  it("a workflow already so changes nothing", () => {
    expect(plan({ workflow: defaultWorkflow() }).changes).toEqual([]);
  });

  it("are deleted by name, and the default goes with the one that was it", () => {
    const { changes } = plan({ deleteWorkflow: "Build and review" });
    expect(made({ deleteWorkflow: "Build and review" })).toEqual({
      list: [],
      default: null,
      overrides: {},
    });
    expect(changes.map((change) => change.field)).toEqual([
      "workflow.Build and review",
      "defaultWorkflow",
    ]);
    expect(changes[1]).toMatchObject({ from: "Build and review", to: "none" });
  });

  it("name the default, or none", () => {
    expect(made({ defaultWorkflow: null }).default).toBeNull();
    const added = plan({ workflow: quick, defaultWorkflow: "Quick fix" });
    expect(made({ workflow: quick, defaultWorkflow: "Quick fix" }).default).toBe("Quick fix");
    expect(added.changes.map((change) => change.field)).toEqual([
      "workflow.Quick fix",
      "defaultWorkflow",
    ]);
  });

  it("are refused with the reason when they will not do", () => {
    expect(() => plan({ defaultWorkflow: "Gone" })).toThrow(/no workflow called Gone/);
    expect(() => plan({ deleteWorkflow: "Gone" })).toThrow(/no workflow called Gone/);
    expect(() => plan({ workflow: "quick" })).toThrow(/object/);
    expect(() => plan({ workflow: { ...quick, extra: 1 } })).toThrow(/not extra/);
    expect(() => plan({ workflow: { ...quick, steps: [] } })).toThrow(/at least one step/);
    expect(() =>
      plan({ workflow: { ...quick, orchestrator: { agent: "gpt", model: "x" } } }),
    ).toThrow(/one of claude-code, codex/);
    const step = (extra: object) => ({
      ...quick,
      steps: [{ kind: "work", name: "Fix", models: [], parallel: 2 }, extra],
    });
    expect(() =>
      plan({ workflow: step({ kind: "work", name: "fix", models: [], parallel: 1 }) }),
    ).toThrow(/taken/);
    expect(() =>
      plan({ workflow: step({ kind: "work", name: "More", models: [], parallel: 9 }) }),
    ).toThrow(/between 1 and 8/);
    expect(() =>
      plan({
        workflow: step({
          kind: "review",
          name: "Check",
          models: [],
          reviewerApproves: false,
          orchestratorAgrees: false,
          backTo: "Fix",
          limit: 2,
        }),
      }),
    ).toThrow(/passes the work/);
    expect(() =>
      plan({
        workflow: step({
          kind: "review",
          name: "Check",
          models: [],
          reviewerApproves: true,
          orchestratorAgrees: true,
          backTo: "Later",
          limit: 2,
        }),
      }),
    ).toThrow(/before it/);
    expect(() =>
      plan({
        workflow: step({ kind: "review", name: "Check", models: [], backTo: "Fix", limit: 2 }),
      }),
    ).toThrow(/reviewerApproves/);
    expect(() => plan({ workflow: step({ kind: "plan", name: "P" }) })).toThrow(/work or review/);
  });

  it("are asked about, and made and sent when the user allows it", async () => {
    const done = handle(request("settings_change", { workflow: quick, reason: "for small fixes" }));
    await settle();
    expect(workflows.list).toHaveLength(1);
    expect(settingsAsk.asking?.changes[0].field).toBe("workflow.Quick fix");
    allowChange();
    await done;
    expect(workflows.list.map((workflow) => workflow.name)).toEqual([
      "Build and review",
      "Quick fix",
    ]);
    expect(sets.at(-1)).toMatchObject({ workflows: { default: "Build and review" } });
    expect(answers[0].content).toMatch(/allowed the change\. Workflow Quick fix is now/);
  });

  it("are left as they were when the user declines", async () => {
    const done = handle(request("settings_change", { deleteWorkflow: "Build and review" }));
    await settle();
    declineChange();
    await done;
    expect(workflows.list).toHaveLength(1);
    expect(workflows.default).toBe("Build and review");
    expect(sets).toEqual([]);
  });

  it("can be undone, which puts back the workflows as they were", async () => {
    const done = handle(request("settings_change", { deleteWorkflow: "Build and review" }));
    await settle();
    allowChange();
    await done;
    expect(workflows.list).toEqual([]);
    undoChange();
    expect(workflows.list).toEqual([defaultWorkflow()]);
    expect(workflows.default).toBe("Build and review");
  });

  it("are refused at once, without asking, when a call writes one that will not do", async () => {
    await handle(request("settings_change", { workflow: { ...quick, steps: [] } }));
    expect(settingsAsk.asking).toBeNull();
    expect(answers[0].error).toMatch(/at least one step/);
  });

  it("which a project follows is not the agent's to change", () => {
    for (const name of ["workflowOverrides", "projectWorkflow"]) {
      expect(() => plan({ [name]: {} })).toThrow(/the user's to change/);
    }
  });

  it("show a change to when the work passes, which would otherwise read the same", () => {
    const written = defaultWorkflow();
    const review = written.steps[1];
    if (review.kind !== "review") throw new Error("the default ends in a review");
    review.reviewerApproves = false;
    const [line] = plan({ workflow: written }).changes;
    expect(line.from).toContain(
      "Review (Opus, passes when the reviewer approves and the orchestrator agrees, else back to Work 3 times at most)",
    );
    expect(line.to).toContain("Review (Opus, passes when the orchestrator agrees, else back to Work");
    expect(line.from).not.toBe(line.to);
  });

  it("show each project that chose a workflow deleted, which follows new sessions again", () => {
    adoptWorkflows({
      list: [defaultWorkflow(), { ...defaultWorkflow(), name: "Other" }],
      default: "Other",
      overrides: { "/repo/app": "Build and review", "/repo/site": null, "/repo/lib": "Other" },
    });
    const { changes } = plan({ deleteWorkflow: "Build and review" });
    expect(changes.map((change) => change.field)).toEqual([
      "workflow.Build and review",
      "workflowOverride./repo/app",
    ]);
    expect(changes[1]).toMatchObject({
      label: "Workflow for app",
      from: "Build and review",
      to: "as for new sessions",
    });
  });

  it("are refused before asking when the core would refuse them", () => {
    const one = (models: object[]) => ({
      ...quick,
      steps: [{ kind: "work", name: "Fix", models, parallel: 1 }],
    });
    expect(() => plan({ workflow: one([{ agent: "codex", model: "gpt 5" }]) })).toThrow(/one word/);
    expect(() => plan({ workflow: one([{ agent: "codex", model: "x".repeat(41) }]) })).toThrow(
      /one word, 40 characters at most/,
    );
    const sonnet = { agent: "claude-code", model: "sonnet" };
    expect(() => plan({ workflow: one([sonnet, sonnet]) })).toThrow(/Sonnet twice/);
    const many = Array.from({ length: 17 }, (_, n) => ({ agent: "claude-code", model: `m${n}` }));
    expect(() => plan({ workflow: one(many) })).toThrow(/16 models at most/);
  });

  it("are not said to be made when the core refuses them after the user allows", async () => {
    const done = handle(request("settings_change", { workflow: quick }));
    await settle();
    refuseSettings = "the settings file could not be written";
    allowChange();
    await done;
    expect(answers[0].content).toBeNull();
    expect(answers[0].error).toBe(
      "The user allowed the change, but it could not be made: the settings file could not be written. Nothing changed.",
    );
    expect(workflows.list.map((workflow) => workflow.name)).toEqual(["Build and review"]);
    expect(settingsAsk.undo).toBeNull();
  });

  it("are made over the user's own edits while the question is open, and undone without them", async () => {
    const done = handle(request("settings_change", { workflow: quick }));
    await settle();
    expect(addWorkflow()).toBe("New workflow");
    allowChange();
    await done;
    expect(workflows.list.map((workflow) => workflow.name)).toEqual([
      "Build and review",
      "New workflow",
      "Quick fix",
    ]);
    expect(addWorkflow()).toBe("New workflow 2");
    undoChange();
    expect(workflows.list.map((workflow) => workflow.name)).toEqual([
      "Build and review",
      "New workflow",
      "New workflow 2",
    ]);
  });

  it("set aside in the file are read out with why, and writing one under its name mends it", async () => {
    const careful = {
      name: "Careful",
      reason: "the step Review of Careful goes back between 1 and 10 times, not 11",
      entry: { name: "Careful", note: "as written" },
      at: 1,
      default: true,
      projects: ["/repo/app"],
    };
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: {}, unread: [careful] });
    await handle(request("settings"));
    const text = answers[0].content!;
    expect(text).toContain("also holds workflows that are not used");
    expect(text).toContain("- Careful: the step Review of Careful goes back between 1 and 10 times, not 11");
    expect(text).toContain('"note": "as written"');

    const mended = { ...defaultWorkflow(), name: "Careful" };
    const { changes } = plan({ workflow: mended });
    expect(changes[0]).toMatchObject({
      field: "workflow.Careful",
      from: "in the file but not used: the step Review of Careful goes back between 1 and 10 times, not 11",
    });
    expect(changes.map((change) => change.field)).toEqual([
      "workflow.Careful",
      "workflowOverride./repo/app",
      "defaultWorkflow",
    ]);
    const after = made({ workflow: mended });
    expect(after.unread).toBeUndefined();
    expect(after.default).toBe("Careful");
    expect(after.overrides).toEqual({ "/repo/app": "Careful" });
    // A name that differs from it only in case is taken, not a mend.
    expect(() => plan({ workflow: { ...mended, name: "careful" } })).toThrow(/not used/);
  });

  it("are asked about again when what they would reset has changed since they were asked", async () => {
    adoptWorkflows({
      list: [defaultWorkflow(), { ...defaultWorkflow(), name: "Other" }],
      default: "Other",
      overrides: {},
    });
    const done = handle(request("settings_change", { deleteWorkflow: "Build and review" }));
    await settle();
    expect(settingsAsk.asking?.changes.map((change) => change.field)).toEqual(["workflow.Build and review"]);
    // Meanwhile the user points a project at the workflow being deleted.
    setOverride("/repo/app", "Build and review");
    allowChange();
    await settle();
    expect(workflows.list).toHaveLength(2);
    expect(settingsAsk.asking?.changes.map((change) => change.field)).toEqual([
      "workflow.Build and review",
      "workflowOverride./repo/app",
    ]);
    allowChange();
    await done;
    expect(workflows.list.map((workflow) => workflow.name)).toEqual(["Other"]);
    expect(workflows.overrides).toEqual({});
    expect(answers[0].content).toMatch(/Workflow for app is now as for new sessions/);
  });

  it("say so when undoing them is refused, and the window keeps what is stored", async () => {
    const done = handle(request("settings_change", { workflow: quick }));
    await settle();
    allowChange();
    await done;
    refuseSettings = "the settings file could not be written";
    undoChange();
    await settle();
    expect(workflows.list.map((workflow) => workflow.name)).toEqual(["Build and review", "Quick fix"]);
    expect(workflows.refused).toBe("the settings file could not be written");
  });

  it("deleted come back where they stood, with the projects that chose them, on undo", async () => {
    adoptWorkflows({
      list: [defaultWorkflow(), { ...defaultWorkflow(), name: "Other" }],
      default: "Build and review",
      overrides: { "/repo/app": "Build and review" },
    });
    const done = handle(request("settings_change", { deleteWorkflow: "Build and review" }));
    await settle();
    allowChange();
    await done;
    expect(workflows.overrides).toEqual({});
    undoChange();
    await settle();
    expect(workflows.list.map((workflow) => workflow.name)).toEqual(["Build and review", "Other"]);
    expect(workflows.default).toBe("Build and review");
    expect(workflows.overrides).toEqual({ "/repo/app": "Build and review" });
  });
});
