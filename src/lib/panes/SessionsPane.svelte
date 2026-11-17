<script lang="ts">
  import Pane from "$lib/components/Pane.svelte";
  import ConfirmStrip from "$lib/components/ConfirmStrip.svelte";
  import {
    closeAsking,
    closingCancel,
    closingDrop,
    closingSave,
    editor,
    unsavedNames,
  } from "$lib/editor.svelte";
  import { agentLabel, installed, isReady } from "$lib/agent.svelte";
  import { accountLabel, accountOf, hasAccounts, names } from "$lib/accounts.svelte";
  import type { AgentId, ProjectInfo } from "$lib/core";
  import { busyGoing, closingAside, closingQuestion, type BusyShell, type Closed } from "$lib/leaving.svelte";
  import { closeOwner as closeShells } from "$lib/terminals.svelte";
  import {
    byChange,
    byKey,
    close as closeSession,
    create,
    defaultAgent,
    drafting,
    forProject,
    otherWay,
    otherWayFor,
    midTurn,
    reopenOtherWay,
    historyFor,
    historyLabel,
    isLive,
    label,
    lastChanged,
    loadHistory,
    loadMissingHistories,
    modelLabel,
    moreLabel,
    outsideFor,
    activeSession,
    sessions,
    since,
    statusLabel,
    disown,
    type HistoryEntry,
    type Session,
  } from "$lib/sessions.svelte";
  import {
    bringForward,
    close as closeProject,
    goTo,
    onScreen,
    pick,
    projectLabel,
    startSession,
    workspace,
  } from "$lib/workspace.svelte";
  import { childrenOf, conducting, isAsking, ownFor, parentOf } from "$lib/orchestrator.svelte";
  import { folderShown, folderToRead, startsIn } from "$lib/orchestratorFolder.svelte";
  import {
    placeTextOf,
    startedFor,
    unheard,
    WAKES_MAX,
    wakesSpent,
    wokenBy,
    type Woken,
  } from "$lib/conductor.svelte";
  import { isInstalled } from "$lib/hook.svelte";
  import { hostOf, openRemote } from "$lib/remote.svelte";
  import { openResume } from "$lib/resume.svelte";
  import { lastSegment } from "$lib/paths";
  import {
    FOLDED,
    folded as foldedWidth,
    focusPane,
    layout,
    peekSessions,
    peekable,
    sessionsShown,
    sessionsVisible,
    setProjectSort,
    type PaneId,
    type ProjectSort,
  } from "$lib/layout.svelte";
  import { lastUsed, splitProjects, steady, touch } from "$lib/projects.svelte";
  import { unfoldSessions } from "$lib/viewers.svelte";
  import { compact } from "$lib/compact.svelte";
  import { shown } from "$lib/unseen";
  import { beginNew, closePalette, openCommands, openGoTo } from "$lib/palette.svelte";
  import { openSettings } from "$lib/settings.svelte";
  import { chordFor, describe } from "$lib/keys.svelte";
  import { tick, untrack } from "svelte";
  import { flip } from "svelte/animate";
  import { rowFade, rowMove } from "$lib/motion";
  import { overrideOf, workflowOf } from "$lib/workflows.svelte";
  import { linkOf } from "$lib/integrated.svelte";
  import type { SessionKind } from "$lib/sessionKind.svelte";
  import { subagentNote, subagentSaid, subagentWords, subagentsOf, type Subagent } from "$lib/subagents";
  import { showCall } from "$lib/callShown.svelte";
  import Plain from "$lib/components/conversation/Plain.svelte";
  import Icon from "$lib/components/conversation/Icon.svelte";

  /** Whether more than one agent is installed to choose between. */
  let several = $derived(installed().length > 1);

  /** Whether a new session has anything to choose: an agent, or an
      account to run under. With neither it starts at once. */
  let choosable = $derived(several || hasAccounts());

  /** The project whose choice for a new session is open under its name. */
  let choosing = $state<string | null>(null);

  /** The account the open choice would start under: the project's own to
      begin with, and whatever the control was switched to. */
  let picked = $state<string | null>(null);

  /** New session from a project's own button or menu: with nothing to
      choose it starts; otherwise the choice opens under the project's
      name, the cursor on the agent the project used last and the account
      the project runs under. The project is drawn among the active ones
      while the choice is open. Nothing else changes until the session
      starts, which is when the project counts as used: the session on
      screen stays, and none of the project's own is put on screen, since
      a row left from the last quit starts once it is. */
  function offer(path: string) {
    if (!startsIn(path)) return;
    if (!choosable) {
      startSession(path);
      return;
    }
    choosing = path;
    picked = accountOf(path);
    cursor =
      workflowOf(path) === null
        ? `pick:${path}:${defaultAgent(path)}`
        : `pick:${path}:${FOLLOW}`;
  }

  /** The row id of the project's workflow in the choice. */
  const FOLLOW = "workflow";

  /** How the project came to follow its workflow, as the palette says it. */
  function followedBy(path: string): string {
    return overrideOf(path) === undefined ? "default" : "project's workflow";
  }

  /** Starts a session on the workflow the project follows. */
  function startFollowing(path: string) {
    const workflow = workflowOf(path);
    if (workflow === null) return;
    choosing = null;
    startSession(path, undefined, picked, workflow);
  }

  function startWith(path: string, agent: AgentId) {
    choosing = null;
    startSession(path, agent, picked);
  }

  /** The accounts the control offers, the agents' own first. */
  let offered = $derived<(string | null)[]>([null, ...names()]);

  /** Left and Right in the choice walk the accounts. */
  function pickNext(step: number) {
    const at = offered.indexOf(picked);
    picked = offered[(at + step + offered.length) % offered.length] ?? null;
  }

  /** The folds standing open, by the row id of the fold. A fold is where
      the eye is right now, so nothing about it is remembered. */
  let opened = $state<Record<string, boolean>>({});

  /** The minute the times on the rows are read against, and the split
      into active and inactive with them. */
  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  /** Whether the pointer is over the pane, and whether the keyboard is
      moving through it. While either is, the order holds still: what is
      under the pointer or the cursor stays there, and the order settles
      once both have stopped. Rows still come and go. The keyboard counts
      once it walks the rows or arrives by a chord, not when a click has
      only left it in the pane, so the pointer leaving after a click
      settles the order. */
  let pointerIn = $state(false);
  let walking = $state(false);
  let holding = $derived(pointerIn || walking);

  /** Whether a press of the pointer in the pane is under way, which is
      how the keyboard arriving with a click is told from a chord. */
  let pressing = false;

  /** Whether the keyboard came to the pane by a chord or has walked its
      rows since the pointer last pressed in it: then it is the keyboard's,
      and in compact mode stays while the pointer is away. A menu closed
      with Escape leaves it the pointer's. */
  let keyed = $state(false);
  $effect(() => {
    if (!layout.sessionsPeek) keyed = false;
  });

  function onFocusin(e: FocusEvent) {
    if (nav.contains(e.relatedTarget as Node | null)) return;
    walking = !pressing;
  }

  function onFocusout(e: FocusEvent) {
    if (nav.contains(e.relatedTarget as Node | null)) return;
    walking = false;
  }

  /** The orders last drawn: the projects, the inactive ones, and each
      project's rows by its path, and the sort they were drawn in. A new
      sort is the user asking for a new order, and it is drawn at once. */
  let shownSort: ProjectSort | null = null;
  let shownActive: string[] = [];
  let shownInactive: string[] = [];
  const shownRows = new Map<string, string[]>();

  /** The order to draw: the one wanted, or while the order holds, the one
      drawn with the new ids put in. */
  function held(shown: string[], wanted: string[]): string[] {
    return holding ? steady(shown, wanted) : wanted;
  }

  /** The split last drawn, and its projects in order, to hand back while
      nothing in it has changed. */
  let shownSplit: { active: ProjectInfo[]; inactive: ProjectInfo[] } | null = null;
  let shownProjects: ProjectInfo[] = [];

  function sameList<T>(a: T[], b: T[]): boolean {
    return a.length === b.length && a.every((item, at) => item === b[at]);
  }

  /** The project on screen, which everything here that follows the
      project on screen follows, so the project a started session runs in
      is not drawn as on screen while its starter's is. */
  let screenProject = $derived(onScreen());

  /** The orchestrator folder, while it is listed: a project like the ones
      you opened, though nothing new starts in it. */
  let folder = $derived.by((): ProjectInfo | null => {
    const dir = folderShown(screenProject);
    if (dir === null) return null;
    return { path: dir, name: lastSegment(dir), repository: null, isGit: true };
  });

  /** The projects, the orchestrator folder among them while it is listed,
      split into the ones in use and the ones folded under Inactive, each
      in the order the sort menu says. The project on screen is in use, and
      while the session on screen hangs under its starter in another
      project, that is the starter's. */
  let split = $derived.by(() => {
    const byPath = new Map(workspace.open.map((project) => [project.path, project]));
    if (folder !== null && !byPath.has(folder.path)) byPath.set(folder.path, folder);
    const { active, inactive } = splitProjects([...byPath.keys()], screenProject, layout.projectSort, now, choosing);
    const resorted = shownSort !== layout.projectSort;
    shownSort = layout.projectSort;
    const nextActive = resorted ? active : held(shownActive, active);
    const nextInactive = resorted ? inactive : held(shownInactive, inactive);
    // The same projects in the same order are the split already drawn, so
    // nothing that draws it is asked to again.
    const kept =
      shownSplit !== null &&
      sameList(nextActive, shownActive) &&
      sameList(nextInactive, shownInactive) &&
      [...nextActive, ...nextInactive].every((path, at) => byPath.get(path) === shownProjects[at]);
    shownActive = nextActive;
    shownInactive = nextInactive;
    if (kept) return shownSplit!;
    shownProjects = [...nextActive, ...nextInactive].map((path) => byPath.get(path)!);
    shownSplit = {
      active: nextActive.map((path) => byPath.get(path)!),
      inactive: nextInactive.map((path) => byPath.get(path)!),
    };
    return shownSplit;
  });

  /** The projects under Inactive when the pane last looked. One that
      leaves has its history read again: the clock that keeps histories
      fresh passes over inactive projects. */
  let wasInactive = new Set<string>();

  $effect(() => {
    const inactive = new Set(split.inactive.map((project) => project.path));
    for (const path of wasInactive) {
      if (!inactive.has(path) && workspace.open.some((project) => project.path === path)) void loadHistory(path);
    }
    wasInactive = inactive;
  });

  /** How many inactive projects stand under the fold before the rest go
      behind a row of their own. */
  const INACTIVE_SHOWN = 7;

  /** The inactive projects drawn once the fold is open: all of them, or
      the first few and a row for the rest. */
  let idle = $derived(
    opened["idle-more"] || split.inactive.length <= INACTIVE_SHOWN + 1
      ? split.inactive
      : split.inactive.slice(0, INACTIVE_SHOWN),
  );

  /** The orders the sort menu offers. */
  const SORTS: { sort: ProjectSort; label: string }[] = [
    { sort: "used", label: "Last used" },
    { sort: "name", label: "Name" },
  ];

  /** The sort menu, and the item its keyboard cursor is on while open. */
  let sortOpen = $state(false);
  let sortAt = $state(0);

  function openSort() {
    sortOpen = !sortOpen;
    menuOpen = false;
    projectMenu = null;
    sessionMenu = null;
    nav?.focus();
    sortAt = Math.max(
      0,
      SORTS.findIndex((choice) => choice.sort === layout.projectSort),
    );
  }

  let sortLabel = $derived(SORTS.find((choice) => choice.sort === layout.projectSort)?.label ?? "");

  function pickSort(sort: ProjectSort) {
    setProjectSort(sort);
    sortOpen = false;
  }

  /** New session in a project's menu, an inactive project's as well: what
      its header's + does, and the pane scrolls to the project, which is
      among the active ones while a session is asked for in it. */
  function startIn(path: string) {
    offer(path);
    void reveal(path);
  }

  /** An inactive project picked: it comes forward, which makes it active,
      and the pane scrolls to where it lands among the active ones, with
      the cursor on its header. */
  async function wake(path: string) {
    bringForward(path);
    cursor = `project:${path}`;
    await reveal(path);
  }

  /** Scrolls the pane to a project once it is drawn where it now stands. */
  async function reveal(path: string) {
    await tick();
    nav
      ?.querySelector(`[data-row="${CSS.escape(`project:${path}`)}"]`)
      ?.closest("section")
      ?.scrollIntoView({ block: "nearest" });
  }

  /** The menu beside the sort on the title's row: the ways to open a
      project, and the settings. Its keyboard cursor walks the items while
      it is open. */
  let menuOpen = $state(false);
  let menuAt = $state(0);

  interface MenuItem {
    id: string;
    label: string;
    title?: string;
    /** The chord that does the same, shown at the item's end. */
    chord?: string;
    /** It stops or removes something: set apart below a separator, and in
        the colour that says so. */
    destructive?: boolean;
    disabled: boolean;
    run: () => void;
  }

  let menuItems = $derived<MenuItem[]>([
    { id: "open-project", label: "Open project…", disabled: workspace.opening, run: () => void pick() },
    {
      id: "open-remote",
      label: "Open remote project…",
      title: "A project on another machine, over ssh",
      disabled: workspace.opening,
      run: openRemote,
    },
    {
      id: "menu-settings",
      label: "Settings…",
      chord: describe(chordFor("settings")),
      disabled: false,
      run: () => openSettings(),
    },
  ]);

  /** A project's own menu, from the ⋯ on its header or its row under
      Inactive, or a right click on either: a new session in it, and
      closing it. It opens upwards when the row is near the pane's foot,
      and its keyboard cursor walks the items while it is open. */
  let projectMenu = $state<{ path: string; up: boolean } | null>(null);
  let projectMenuAt = $state(0);

  let projectItems = $derived.by((): MenuItem[] => {
    if (projectMenu === null) return [];
    const path = projectMenu.path;
    const agent = defaultAgent(path);
    const other = startsIn(path) ? otherWay(path) : null;
    return [
      ...(startsIn(path)
        ? [{ id: "project-menu-new", label: "New session", disabled: !isReady(), run: () => startIn(path) }]
        : []),
      // One session the other way from New session, alone.
      ...(other === null
        ? []
        : [
            {
              id: "project-menu-other",
              label: other === "integrated" ? "New integrated session" : "New session in a terminal",
              disabled: !isReady(),
              run: () => {
                startSession(path, agent, accountOf(path), null, other);
                void reveal(path);
              },
            },
          ]),
      {
        id: "close-project",
        label: "Close project",
        destructive: true,
        disabled: false,
        run: () => void closeProjectAsking(path),
      },
    ];
  });

  function openProjectMenu(path: string, e: MouseEvent) {
    e.preventDefault();
    if (projectMenu?.path === path && e.type === "click") {
      projectMenu = null;
      return;
    }
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-row]");
    const tree = nav?.querySelector<HTMLElement>(".tree");
    const up =
      row !== null && tree !== null && tree !== undefined
        ? row.getBoundingClientRect().bottom > tree.getBoundingClientRect().bottom - 90
        : false;
    menuOpen = false;
    sortOpen = false;
    sessionMenu = null;
    projectMenu = { path, up };
    projectMenuAt = 0;
    if (row?.dataset.row !== undefined) cursor = row.dataset.row;
    nav?.focus();
  }

  /** An item of the project's menu runs and the menu closes behind it. */
  function fromProjectMenu(item: MenuItem) {
    if (item.disabled) return;
    projectMenu = null;
    item.run();
  }

  /** A session's own menu, from a right click on its row or the menu key
      on the row under the cursor: the session reopened the other way where
      its agent runs both ways, and stopping it. It opens upwards near the
      pane's foot, and its keyboard cursor walks the items while it is
      open. */
  let sessionMenu = $state<{ key: string; up: boolean } | null>(null);
  let sessionMenuAt = $state(0);

  let sessionItems = $derived.by((): MenuItem[] => {
    if (sessionMenu === null) return [];
    const session = byKey(sessionMenu.key);
    if (session === null) return [];
    const other = otherWayFor(session);
    const live = isLive(session);
    return [
      ...(other === null
        ? []
        : [
            {
              id: "session-menu-reopen",
              label: other === "integrated" ? "Reopen as a conversation" : "Reopen in a terminal",
              title:
                other === "integrated"
                  ? "Stop it, and go on with the same conversation drawn here"
                  : "Stop it, and go on with the same conversation in the agent's own terminal",
              disabled: false,
              run: () => reopenAsking(session, other),
            },
          ]),
      {
        id: "session-menu-stop",
        label: live ? "Stop" : "Close",
        destructive: true,
        disabled: false,
        run: () => void closeSessionAsking(session),
      },
    ];
  });

  function openSessionMenu(key: string, e: MouseEvent | null) {
    e?.preventDefault();
    const row = nav?.querySelector<HTMLElement>(`[data-row="${CSS.escape(`session:${key}`)}"]`) ?? null;
    const tree = nav?.querySelector<HTMLElement>(".tree");
    const up =
      row !== null && tree !== null && tree !== undefined
        ? row.getBoundingClientRect().bottom > tree.getBoundingClientRect().bottom - 90
        : false;
    menuOpen = false;
    sortOpen = false;
    projectMenu = null;
    sessionMenu = { key, up };
    sessionMenuAt = 0;
    cursor = `session:${key}`;
    nav?.focus();
  }

  /** An item of the session's menu runs and the menu closes behind it. */
  function fromSessionMenu(item: MenuItem) {
    if (item.disabled) return;
    sessionMenu = null;
    item.run();
  }

  /** Reopening a session the other way stops it, so while a turn runs the
      pane asks first. */
  let reopenAsk = $state<{ key: string; to: SessionKind } | null>(null);

  function reopenAsking(session: Session, to: SessionKind) {
    if (midTurn(session)) reopenAsk = { key: session.key, to };
    else void reopen(session.key);
  }

  function reopenConfirm() {
    const ask = reopenAsk;
    reopenAsk = null;
    if (ask !== null) void reopen(ask.key);
    nav?.focus();
  }

  /** Why the last reopen was given up, until it is put away. */
  let reopenError = $state<string | null>(null);

  async function reopen(key: string) {
    reopenError = null;
    const session = byKey(key);
    if (session === null) return;
    const name = closingName(session);
    if (!(await reopenOtherWay(key)) && byKey(key) !== null)
      reopenError = `${name} did not stop in time, so it was not reopened. It goes on as it was.`;
  }

  function reopenCancel() {
    reopenAsk = null;
    nav?.focus();
  }

  // The question goes with its session.
  $effect(() => {
    if (reopenAsk !== null && byKey(reopenAsk.key) === null) untrack(() => (reopenAsk = null));
  });

  /** The question about reopening a session, while it is up. */
  let reopenQuestion = $derived.by(() => {
    if (reopenAsk === null) return null;
    const session = byKey(reopenAsk.key);
    if (session === null) return null;
    const name = closingName(session);
    return {
      question:
        reopenAsk.to === "integrated" ? `Reopen ${name} as a conversation?` : `Reopen ${name} in a terminal?`,
      detail: `${agentLabel(session.agent)} is in the middle of a turn. Reopening stops it there, and the conversation goes on from where it stopped.`,
    };
  });


  function openMenu() {
    menuOpen = !menuOpen;
    sortOpen = false;
    projectMenu = null;
    sessionMenu = null;
    menuAt = 0;
    nav?.focus();
  }

  /** An item runs and the menu closes behind it. */
  function fromMenu(item: MenuItem) {
    if (item.disabled) return;
    menuOpen = false;
    item.run();
  }

  /** The button beside the go-to field: the palette's New session, which
      asks which project when more than one is open, then whatever else
      there is to choose. With nothing to ask, the session starts at once. */
  async function newFromHead() {
    if (!isReady() || workspace.open.length === 0) return;
    openCommands();
    const outcome = beginNew(null);
    if (outcome.type === "stay") return;
    closePalette();
    await tick();
    if (outcome.type === "close") outcome.then();
  }

  /** The account the session on screen runs under, for the foot, which
      is there only once there are accounts to tell apart. */
  let footAccount = $derived(
    hasAccounts() && activeSession() !== null ? accountLabel(activeSession()?.account ?? null) : null,
  );

  /** The sessions whose started sessions are folded into dots on their
      own row rather than hanging under it. Open is how a parent starts,
      and nothing about it is remembered. */
  let collapsed = $state<Record<string, boolean>>({});

  /** What the sessions a session started are doing, in words, each counted
      once: how many run, how many ask for a permission, and how many are
      done. */
  function startedWords(kids: Session[]): string {
    const asking = kids.filter(isAsking).length;
    const running = kids.filter(isLive).length - asking;
    const done = kids.length - running - asking;
    return [
      running > 0 ? `${running} running` : null,
      asking > 0 ? `${asking} asking` : null,
      done > 0 ? `${done} done` : null,
    ]
      .filter((part) => part !== null)
      .join(", ");
  }

  /** What a starter's row says of the sessions it started that stopped,
      asked or ended since it last looked: how many, and on hover which,
      and how it hears of them. Your next message tells it only where the
      workbench gives it the note: running integrated, or with hooks. */
  function newsWords(news: Session[]): string {
    return `${news.length} not heard yet`;
  }

  function newsTitle(starter: Session, news: Session[]): string {
    const what = (kid: Session) =>
      !isLive(kid) ? "ended" : kid.needs === "permission" ? "is asking" : "stopped";
    const told = starter.kind === "integrated" || isInstalled(starter.project);
    const hears = `It hears on its next wait${told ? ", or with your next message" : ""}.`;
    const woken = wakesSpent(starter)
      ? ` The workbench has woken it ${WAKES_MAX} times in a row, and wakes it again only after a turn it did not start, such as one of yours.`
      : starter.kind === "terminal" && drafting(starter.key)
        ? " The workbench does not wake it while keys of yours are on its line: it waits until you send a line or clear it with Ctrl+C."
        : "";
    return `${label(starter)} has not heard: ${news.map((kid) => `${label(kid)} ${what(kid)}`).join(", ")}. ${hears}${woken}`;
  }

  /** What a woken starter's row says woke it: the session, by the name its
      row has now, or had then, or how many sessions when there were more.
      Short of room the name is cut; the count never is. */
  function wokenWords(woken: Woken): { name: string | null; count: string | null } {
    return woken.by.length === 1
      ? { name: wokenName(woken.by[0]), count: null }
      : { name: null, count: `${woken.by.length} sessions` };
  }

  function wokenName(by: Woken["by"][number]): string {
    const row = byKey(by.key);
    return row === null ? by.name : label(row);
  }

  function wokenTitle(starter: Session, woken: Woken): string {
    const what = (by: Woken["by"][number]) =>
      `${wokenName(by)} ${by.rest === "ended" ? "ended" : by.rest === "permission" ? "asked for permission" : "stopped"}`;
    const list = woken.by.map(what);
    const said = list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
    return `${label(starter)} was idle, so the workbench sent it what happened: ${said}.`;
  }

  function toggleKids(key: string) {
    collapsed[key] = !collapsed[key];
  }

  /** Whether a session runs under another account than its project's,
      once there are accounts to tell apart. */
  function otherAccount(session: Session): boolean {
    return hasAccounts() && session.account !== accountOf(session.project);
  }

  /** A row under a project's name: a session, live or left from the last
      quit, or a past session of the project on screen, with when it
      changed. */
  type Entry =
    | { kind: "session"; id: string; session: Session; at: number }
    | { kind: "past"; id: string; transcript: HistoryEntry; at: number };

  /** Whether an entry has something running behind it, or ran this time. */
  function running(entry: Entry): boolean {
    return entry.kind === "session" && entry.session.status !== "dormant";
  }

  /** How many quiet rows a project shows before the rest fold into one
      row that counts them. */
  const QUIET_SHOWN = 2;

  /** What stands under a project's name: its sessions with something
      running behind them, in the order they last changed, then the quiet
      rows, latest first, the tail of them folded once there are more than
      a few. Past sessions are listed under the project on screen alone. */
  function bodyOf(path: string): { entries: Entry[]; hidden: Entry[] } {
    const own = byChange(ownFor(path)).map(
      (session): Entry => ({ kind: "session", id: `session:${session.key}`, session, at: lastChanged(session) }),
    );
    const quiet: Entry[] = [
      ...own.filter((entry) => !running(entry)),
      ...(screenProject === path ? historyFor(path) : []).map(
        (transcript): Entry => ({ kind: "past", id: `past:${transcript.id}`, transcript, at: transcript.modified * 1000 }),
      ),
    ].sort((a, b) => b.at - a.at);
    const wanted = [...own.filter(running), ...quiet];
    const byId = new Map(wanted.map((entry) => [entry.id, entry]));
    const order = held(shownRows.get(path) ?? [], [...byId.keys()]);
    shownRows.set(path, order);
    const all = opened[`more:${path}`] || quiet.length <= QUIET_SHOWN + 1;
    const entries: Entry[] = [];
    const hidden: Entry[] = [];
    let shown = 0;
    for (const id of order) {
      const entry = byId.get(id)!;
      if (running(entry)) entries.push(entry);
      else if (all || shown < QUIET_SHOWN) {
        entries.push(entry);
        shown += 1;
      } else hidden.push(entry);
    }
    return { entries, hidden };
  }

  type Body = ReturnType<typeof bodyOf>;

  /** The bodies and the entries last drawn, by project and by row id. */
  let shownBodies = new Map<string, Body>();
  let shownEntries = new Map<string, Entry>();

  /** What stands under each project drawn, worked out once per change for
      the keyboard's rows and the template alike. A project whose rows have
      not changed keeps the very rows it was drawn with, so a change in one
      project redraws and measures that project alone. */
  let bodies = $derived.by(() => {
    const out = new Map<string, Body>();
    const was = shownEntries;
    shownEntries = new Map();
    const keep = (path: string) => {
      const fresh = bodyOf(path);
      const entries = fresh.entries.map(reuse(was));
      const hidden = fresh.hidden.map(reuse(was));
      const prev = shownBodies.get(path);
      out.set(
        path,
        prev !== undefined && sameList(prev.entries, entries) && sameList(prev.hidden, hidden)
          ? prev
          : { entries, hidden },
      );
    };
    for (const project of split.active) keep(project.path);
    shownBodies = out;
    return out;
  });


  /** The entry already drawn for a row when it says the same. */
  function reuse(was: Map<string, Entry>) {
    return (entry: Entry): Entry => {
      const prev = was.get(entry.id);
      const same =
        prev !== undefined &&
        prev.at === entry.at &&
        (prev.kind === "session"
          ? entry.kind === "session" && prev.session === entry.session
          : entry.kind === "past" && prev.transcript === entry.transcript);
      const kept = same ? prev : entry;
      shownEntries.set(kept.id, kept);
      return kept;
    };
  }

  const NO_BODY: ReturnType<typeof bodyOf> = { entries: [], hidden: [] };

  function toggle(id: string) {
    opened[id] = !opened[id];
  }

  /** Closes the choice, the cursor back on the project it opened under. */
  function dismiss(): boolean {
    if (choosing === null) return false;
    cursor = `project:${choosing}`;
    choosing = null;
    return true;
  }

  /**
   * Every row the keyboard can land on, in the order the pane shows them.
   * The pane is one tab stop with a cursor inside it, like the file tree:
   * Up and Down move the cursor, Enter does what a click on the row does.
   */
  interface Row {
    id: string;
    run: () => void;
  }

  /** Every row but the subagents', in the order the pane shows them. */
  let walk = $derived.by(() => {
    const out: Row[] = [
      { id: "sort", run: openSort },
      { id: "menu", run: openMenu },
      { id: "go", run: openGoTo },
      { id: "new", run: newFromHead },
    ];
    if (workspace.open.length === 0) out.push({ id: "open", run: () => void pick() });
    for (const project of split.active) {
      const path = project.path;
      out.push({ id: `project:${path}`, run: () => pickProject(path) });
      out.push(...body(path));
    }
    if (split.inactive.length > 0) {
      out.push({ id: "inactive", run: () => toggle("inactive") });
      if (opened.inactive) {
        for (const project of idle) {
          const path = project.path;
          out.push({ id: `idle:${path}`, run: () => void wake(path) });
        }
        if (idle.length < split.inactive.length) out.push({ id: "idle-more", run: () => toggle("idle-more") });
      }
    }
    return out;
  });

  /** Every row, a session's subagents right under it. */
  let rows = $derived.by(() => {
    const out: Row[] = [];
    for (const row of walk) {
      out.push(row);
      if (!row.id.startsWith("session:")) continue;
      const key = row.id.slice("session:".length);
      for (const one of subGroups.get(key) ?? []) out.push({ id: subId(key, one.call), run: () => openSubagent(key, one.call) });
    }
    return out;
  });

  /** A subagent's row id: its session's key and the call that started it. */
  function subId(key: string, call: string): string {
    return `sub:${key}\n${call}`;
  }

  /** The session a subagent's row hangs under, by its row id. */
  function subOwner(id: string): string | null {
    if (!id.startsWith("sub:")) return null;
    const cut = id.indexOf("\n");
    return cut === -1 ? null : id.slice("sub:".length, cut);
  }

  /** A session's subagents as its conversation has them. Only an
      integrated Claude Code session's are known: Codex's run as threads
      of their own that the window does not follow, and a terminal's hooks
      do not say enough. */
  function liveSubagents(session: Session): Subagent[] {
    if (session.kind !== "integrated" || session.agent !== "claude-code" || !isLive(session)) return [];
    const link = linkOf(session.key);
    return link === null ? [] : subagentsOf(link.conversation);
  }

  /** The row the pointer is on, by its row id, while it is in the pane. */
  let pointed = $state<string | null>(null);

  function onPointerover(e: PointerEvent) {
    pointed = (e.target as HTMLElement).closest<HTMLElement>("[data-row]")?.dataset.row ?? null;
  }

  /** The subagents each session's rows show last drawn, by its key. */
  const shownSubs = new Map<string, Subagent[]>();

  /** Where the pointer and the keyboard are in the order of the rows: a
      subagent's row counts as just under its session's. */
  function anchors(): number[] {
    const at = (id: string | null): number | null => {
      if (id === null) return null;
      const owner = subOwner(id);
      const index = walk.findIndex((row) => row.id === (owner === null ? id : `session:${owner}`));
      return index === -1 ? null : owner === null ? index : index + 0.5;
    };
    const keys = walking ? (cursor ?? (sessions.active === null ? null : `session:${sessions.active}`)) : null;
    return [at(keys), pointerIn ? at(pointed) : null].filter((index) => index !== null);
  }

  /**
   * The subagents each session's rows show, by its key. They come and go
   * as the conversations say, except where that would move the row under
   * the pointer or the keyboard's place: a session's rows above either
   * keep what they show until both have moved off or away. Kept, a row
   * that has gone stays, its subagent as done, and one that has come
   * waits, while each row kept shows its subagent as it now stands.
   */
  let subGroups = $derived.by(() => {
    const held = anchors();
    const out = new Map<string, Subagent[]>();
    for (const [index, row] of walk.entries()) {
      if (!row.id.startsWith("session:")) continue;
      const key = row.id.slice("session:".length);
      const session = byKey(key);
      const live = session === null ? [] : liveSubagents(session);
      const before = shownSubs.get(key) ?? [];
      const drawn = held.some((at) => at > index) ? kept(before, live) : live;
      if (drawn.length > 0) out.set(key, drawn);
    }
    shownSubs.clear();
    for (const [key, drawn] of out) shownSubs.set(key, drawn);
    return out;
  });

  /** The rows drawn before, each with its subagent as it now stands, or
      as done once it has gone. */
  function kept(before: Subagent[], live: Subagent[]): Subagent[] {
    const now = new Map(live.map((one) => [one.call, one]));
    return before.map(
      (one) => now.get(one.call) ?? (one.state === "running" || one.state === "asking" ? { ...one, state: "done" } : one),
    );
  }

  /** Picking a subagent's row opens its session at the call that started
      it, the call open and marked. */
  function openSubagent(key: string, call: string) {
    if (!goTo(key)) return;
    showCall(key, call);
    focusPane("agent");
  }

  /** What a screen reader is told of subagents as they start, politely:
      each session's starts gathered over a moment and said in one line,
      each subagent once, and none whose call was made before the pane
      came, as those read from what a conversation said before were. */
  let subagentSaidNow = $state("");
  const toldOf = new Set<string>();
  const cameAt = Date.now();
  /** How long starts are gathered before they are said. */
  const GATHER_MS = 1500;
  /** The starts gathered, by session, with the session's name and what
      each was asked. */
  let gathered = new Map<string, { name: string; about: (string | null)[] }>();
  let gathering: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    for (const session of sessions.all)
      for (const one of liveSubagents(session)) {
        if (toldOf.has(one.call)) continue;
        if (one.began < cameAt) {
          toldOf.add(one.call);
          continue;
        }
        // What it was asked is said once the call says it.
        if (one.about === null && one.state === "running") continue;
        toldOf.add(one.call);
        if (one.state === "running" || one.state === "asking") untrack(() => gather(session, one.about));
      }
  });

  $effect(() => () => {
    if (gathering !== null) clearTimeout(gathering);
  });

  function gather(session: Session, about: string | null) {
    const held = gathered.get(session.key) ?? { name: label(session), about: [] };
    held.about.push(about === null ? null : shown(about));
    gathered.set(session.key, held);
    gathering ??= setTimeout(sayGathered, GATHER_MS);
  }

  function sayGathered() {
    gathering = null;
    const lines = [...gathered.values()].map(({ name, about }) =>
      about.length === 1
        ? `${name} started a subagent${about[0] === null ? "" : ` for ${about[0]}`}.`
        : `${name} started ${about.length} subagents.`,
    );
    gathered = new Map();
    const text = lines.join(" ");
    if (subagentSaidNow !== text) subagentSaidNow = text;
    else {
      subagentSaidNow = "";
      queueMicrotask(() => (subagentSaidNow = text));
    }
  }

  /** A project's rows in the order drawn: its sessions, each with the
      sessions it started under it, the quiet rows and the fold of the
      rest of them, and under the project on screen the way to a new
      session and to its earlier ones. */
  function body(path: string): Row[] {
    const out: Row[] = [];
    const { entries, hidden } = bodies.get(path) ?? NO_BODY;
    out.push(...starting(path));
    for (const entry of entries) {
      if (entry.kind === "past") {
        out.push({ id: entry.id, run: () => resume(path, entry.transcript) });
        continue;
      }
      const session = entry.session;
      out.push({ id: entry.id, run: () => choose(session.key) });
      if (collapsed[session.key]) continue;
      for (const kid of childrenOf(session)) {
        out.push({ id: `session:${kid.key}`, run: () => choose(kid.key) });
      }
    }
    const more = `more:${path}`;
    if (hidden.length > 0) out.push({ id: more, run: () => toggle(more) });
    if (screenProject !== path) return out;
    if (outsideFor(path).length > 0) {
      out.push({ id: `earlier:${path}`, run: () => openResume(path) });
    }
    return out;
  }

  /** The rows a project offers for starting a session: the choice of agent
      while it is open under its name, else none. */
  function starting(path: string): Row[] {
    if (!isReady() || !choosable || choosing !== path) return [];
    const own: Row[] =
      workflowOf(path) === null
        ? []
        : [{ id: `pick:${path}:${FOLLOW}`, run: () => startFollowing(path) }];
    return [
      ...own,
      ...installed().map((agent) => ({
        id: `pick:${path}:${agent}`,
        run: () => startWith(path, agent),
      })),
    ];
  }

  let cursor = $state<string | null>(null);
  let nav: HTMLDivElement;

  /** The cursor, or where it starts: the session you are in, else the top. */
  let current = $derived.by(() => {
    if (cursor !== null && rows.some((row) => row.id === cursor)) return cursor;
    const active = sessions.active === null ? null : `session:${sessions.active}`;
    if (active !== null && rows.some((row) => row.id === active)) return active;
    const project = screenProject === null ? null : `project:${screenProject}`;
    if (project !== null && rows.some((row) => row.id === project)) return project;
    return rows[0]?.id ?? null;
  });

  /** What the button on the row under the cursor would do: × on a project
      or a live session, archive on a past one. */
  function remove(id: string) {
    if (id.startsWith("idle:")) {
      void closeProjectAsking(id.slice("idle:".length));
    } else if (id.startsWith("project:")) {
      void closeProjectAsking(id.slice("project:".length));
    } else if (id.startsWith("session:")) {
      // A session another started hangs quietly on its rail: the cursor
      // walks through those rows, and a key pressed on the way past is no
      // reason to stop work its starter is waiting on. Its own × on hover
      // stops it.
      const key = id.slice("session:".length);
      const session = byKey(key);
      if (startedFor(key) === null && session !== null) void closeSessionAsking(session);
    } else if (id.startsWith("past:") && screenProject !== null) {
      disown(screenProject, id.slice("past:".length));
    }
  }

  // A question in the pane, about closing a session or a project or about
  // reopening a session the other way, is answered in the pane: when the
  // pane folds, a peek put away above all, or in compact mode goes out of
  // sight by any way at all, the question goes with it, and nothing is
  // closed or reopened.
  $effect(() => {
    if (!(folded || (compact.on && !layout.sessionsPeek))) return;
    untrack(() => {
      if (editor.closing !== null) closingCancel();
      reopenAsk = null;
    });
  });

  /** The question about closing a session or a project, while it is up. */
  let closingStrip = $state<HTMLDivElement | null>(null);

  /** The session as the question names it: its label, and its project
      too where another row reads the same, as a started session's row
      names the project it runs in. */
  function closingName(session: Session): string {
    const name = label(session);
    const same = sessions.all.some((other) => other.key !== session.key && label(other) === name);
    return same ? `${name} in ${projectLabel(session.project)}` : name;
  }

  /** The sessions and projects whose shells are being read before the
      close asked for goes ahead, so a second click meanwhile asks nothing
      twice. */
  const reading = new Set<string>();

  /** Reads what a close would stop, once at a time for each thing closed. */
  function readBusy(id: string, closed: Closed): Promise<BusyShell[]> | null {
    if (reading.has(id)) return null;
    reading.add(id);
    const read = busyGoing(closed);
    void read.finally(() => reading.delete(id));
    return read;
  }

  /** Closes a session, asking first when tabs beside it hold the only
      copy of unsaved edits or one of its shells is busy. Once the user has
      said to, its shells close with it, whatever runs in them. */
  async function closeSessionAsking(session: Session) {
    const { key, project } = session;
    const read = readBusy(`session:${key}`, { session: key });
    if (read === null) return;
    const busy = await read;
    closeAsking(
      closingName(session),
      [key],
      () => {
        closeShells({ project, session: key });
        closeSession(key);
      },
      "session",
      busy,
    );
  }

  /** Closes a project, asking first when tabs beside it or beside one of
      its sessions hold the only copy of unsaved edits, or a shell that
      started in it is busy. */
  async function closeProjectAsking(path: string) {
    const owners = [...forProject(path).map((session) => session.key), `project:${path}`];
    const read = readBusy(`project:${path}`, { project: path });
    if (read === null) return;
    const busy = await read;
    closeAsking(projectLabel(path), owners, () => closeProject(path), "project", busy);
  }

  /** The question about busy shells, when nothing is unsaved as well. */
  let busyAsk = $derived(
    editor.closing === null ? null : closingQuestion(editor.closing.kind, editor.closing.what, editor.closing.busy),
  );

  /** The pane the focus state named last time this was looked at, so an
      arrival from another pane can be told from the keyboard coming back. */
  let previous: PaneId = layout.focus;

  // Focusing the pane by key puts the keyboard here, so the arrows work at
  // once. Arriving from another pane starts the cursor over from the session
  // you are in rather than from whatever a click left it on; the keyboard
  // coming back from a dialog finds the cursor where it was. A click inside
  // already has the keyboard.
  $effect(() => {
    layout.focusRequest;
    const here = layout.focus === "sessions";
    const arrived = here && previous !== "sessions";
    previous = layout.focus;
    if (!here || !nav || nav.contains(document.activeElement)) return;
    // A question in the pane keeps the keyboard it was given.
    if (closingStrip?.contains(document.activeElement)) return;
    // So does a stop in the header: the menu button off macOS, which Tab
    // reaches before the rows. The header's tools are no stops; the rows
    // walk them, and a click on one gives the rows the keyboard.
    const owner = document.activeElement;
    const header = nav.closest("section")?.querySelector(":scope > header");
    if (owner instanceof HTMLElement && owner.tabIndex >= 0 && header?.contains(owner)) return;
    if (arrived) cursor = null;
    if (arrived && !pressing) keyed = true;
    nav.focus();
  });

  /** Picking a session is wanting to type into it, and to see its project:
      one under another project brings that project forward first. */
  function choose(key: string) {
    if (!goTo(key)) return;
    focusPane("agent");
  }

  /** A past session resumes where it ran: in its worktree when it had
      one, and under the account it ran under. */
  function resume(path: string, transcript: HistoryEntry) {
    touch(path);
    create(path, transcript.id, transcript.agent, transcript.cwd ?? null, null, null, transcript.account);
    focusPane("agent");
  }

  function moveTo(index: number) {
    if (rows.length === 0) return;
    const at = Math.max(0, Math.min(index, rows.length - 1));
    cursor = rows[at].id;
    nav.querySelector(`[data-row="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function onKeydown(e: KeyboardEvent) {
    walking = true;
    if (/^(Arrow|Home$|End$)/.test(e.key)) keyed = true;
    if (
      (sortOpen && onSortKeydown(e)) ||
      (menuOpen && onMenuKeys(e)) ||
      (projectMenu !== null && onProjectMenuKeys(e)) ||
      (sessionMenu !== null && onSessionMenuKeys(e))
    ) {
      nav.focus();
      e.preventDefault();
      return;
    }
    const at = rows.findIndex((row) => row.id === current);
    // The menu key, or Shift+F10 where there is none, opens the menu of
    // the session under the cursor, as a right click on it does.
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      if (current?.startsWith("session:")) openSessionMenu(current.slice("session:".length), null);
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        moveTo(at + 1);
        break;
      case "ArrowUp":
        moveTo(at - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "ArrowLeft":
      case "ArrowRight":
        if (choosing !== null && hasAccounts()) pickNext(e.key === "ArrowLeft" ? -1 : 1);
        else if (!onRail(e.key === "ArrowLeft")) return;
        break;
      case "Tab":
        // The keyboard leaving the pane takes an open menu with it. A peeked
        // pane stands over the panes beside it, so Tab puts it back, as
        // Escape does, rather than reach what is under it.
        menuOpen = false;
        sortOpen = false;
        projectMenu = null;
        sessionMenu = null;
        if (!layout.sessionsPeek) return;
        peekSessions(false);
        e.preventDefault();
        return;
      case "Escape":
        // Closes the menu or an open choice of agent, then puts a peeked
        // pane back, and goes no further: Escape elsewhere is the agent's,
        // or closes the viewer.
        if (menuOpen) menuOpen = false;
        else if (dismiss()) {
          // The choice is gone; the pane stays.
        } else if (layout.sessionsPeek) peekSessions(false);
        else return;
        e.stopPropagation();
        break;
      case "Enter":
      case " ":
        if (at === -1) return;
        rows[at].run();
        break;
      case "Delete":
      case "Backspace":
        if (current === null) return;
        remove(current);
        break;
      default:
        return;
    }
    // The arrows put the keyboard back on the pane, so Enter is the row
    // under the cursor and not a button a click left focused.
    nav.focus();
    e.preventDefault();
  }

  /** Left and Right on a session that started others fold its started
      sessions into dots and let them out again; Left on one of those, or
      on a subagent's row, climbs to the session it hangs under. False
      when the row under the cursor is none of these. */
  function onRail(left: boolean): boolean {
    const owner = current === null ? null : subOwner(current);
    if (owner !== null) {
      if (!left) return false;
      cursor = `session:${owner}`;
      return true;
    }
    const session = current?.startsWith("session:") ? byKey(current.slice("session:".length)) : null;
    if (session === null) return false;
    const parent = parentOf(session);
    if (parent !== null) {
      if (!left) return false;
      cursor = `session:${parent.key}`;
      return true;
    }
    if (childrenOf(session).length === 0) return false;
    collapsed[session.key] = left;
    return true;
  }

  /** While the menu is open the arrows walk its items, Enter runs one and
      Escape closes it. False for a key the menu leaves alone. */
  function onMenuKeys(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "ArrowDown":
        menuAt = Math.min(menuAt + 1, menuItems.length - 1);
        return true;
      case "ArrowUp":
        menuAt = Math.max(menuAt - 1, 0);
        return true;
      case "Enter":
      case " ":
        fromMenu(menuItems[menuAt]);
        return true;
      case "Escape":
        menuOpen = false;
        e.stopPropagation();
        return true;
      default:
        return false;
    }
  }

  /** While a project's menu is open the arrows walk its items, Enter runs
      one and Escape closes it. False for a key the menu leaves alone. */
  function onProjectMenuKeys(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "ArrowDown":
        projectMenuAt = Math.min(projectMenuAt + 1, projectItems.length - 1);
        return true;
      case "ArrowUp":
        projectMenuAt = Math.max(projectMenuAt - 1, 0);
        return true;
      case "Enter":
      case " ":
        fromProjectMenu(projectItems[projectMenuAt]);
        return true;
      case "Escape":
        projectMenu = null;
        e.stopPropagation();
        return true;
      default:
        return false;
    }
  }

  /** While a session's menu is open the arrows walk its items, Enter runs
      one and Escape closes it. False for a key the menu leaves alone. */
  function onSessionMenuKeys(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "ArrowDown":
        sessionMenuAt = Math.min(sessionMenuAt + 1, sessionItems.length - 1);
        return true;
      case "ArrowUp":
        sessionMenuAt = Math.max(sessionMenuAt - 1, 0);
        return true;
      case "Enter":
      case " ":
        fromSessionMenu(sessionItems[sessionMenuAt]);
        return true;
      case "Escape":
        sessionMenu = null;
        e.stopPropagation();
        return true;
      default:
        return false;
    }
  }

  /** While the sort menu is open the arrows walk its items, Enter picks
      one and Escape closes it. False for a key the menu leaves alone. */
  function onSortKeydown(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "ArrowDown":
        sortAt = Math.min(sortAt + 1, SORTS.length - 1);
        return true;
      case "ArrowUp":
        sortAt = Math.max(sortAt - 1, 0);
        return true;
      case "Enter":
      case " ":
        pickSort(SORTS[sortAt].sort);
        return true;
      case "Escape":
        sortOpen = false;
        e.stopPropagation();
        return true;
      default:
        return false;
    }
  }

  /** A click puts the cursor on what was clicked, so the keyboard carries on
      from there. */
  function onPointerdown(e: PointerEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (row?.dataset.row !== undefined) cursor = row.dataset.row;
  }

  // Read for every open project not yet read, in one request per machine.
  // The index is history on disk, so it changes when an agent writes, not
  // when this window does.
  $effect(() => {
    const wanted = workspace.open.map((project) => project.path);
    const dir = folderToRead();
    if (dir !== null) wanted.push(dir);
    void loadMissingHistories(wanted);
  });

  /** Folded to its narrow column: the rows keep their places, and the pane
      is one button that opens it. Peeked over the agent, it is open. In
      compact mode it is never folded: it is drawn open over the panes, or
      not at all. */
  let folded = $derived(!compact.on && !sessionsShown());

  /** Picking a project brings it forward. In compact mode that is done with
      the pane, which goes back with the keyboard, as picking a session
      does. */
  function pickProject(path: string) {
    bringForward(path);
    if (compact.on) peekSessions(false);
  }

  /** A press that began in the pane and is not yet let go: a click, or a
      drag of a scroll bar or a selection. */
  let pressHeld = $state(false);

  // What holds the pane in compact mode while the pointer is away from it:
  // a menu, the new-session choice, a question in the pane, a press under
  // way, or the keyboard walking it.
  $effect(() => {
    compact.held =
      menuOpen ||
      sortOpen ||
      projectMenu !== null ||
      sessionMenu !== null ||
      choosing !== null ||
      reopenQuestion !== null ||
      editor.closing !== null ||
      pressHeld ||
      (keyed && layout.focus === "sessions");
  });
  /** Folded wide enough to show the start of each session's name, where
      the column holds the window's buttons. */
  let wide = $derived(foldedWidth() > FOLDED);

  /** The list scrolls under the foot: only then does a rule part them. */
  let tree = $state<HTMLDivElement | null>(null);
  let under = $state(false);
  function measureUnder() {
    if (tree === null) return;
    under = tree.scrollTop + tree.clientHeight < tree.scrollHeight - 1;
  }
  $effect(() => {
    if (tree === null) return;
    const observer = new ResizeObserver(measureUnder);
    observer.observe(tree);
    for (const child of tree.children) observer.observe(child);
    const mutations = new MutationObserver(measureUnder);
    mutations.observe(tree, { childList: true, subtree: true });
    measureUnder();
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  });
  /** Reviewing folds the pane, and so does editing in a window that keeps
      the editor's room, and the column peeks it over the pane beside it;
      a window too narrow for it otherwise has nothing to open it into. */
  let unfoldable = $derived(peekable() || !layout.sessionsForced);

  /** The column was clicked: where the pane peeks, so the viewer or the
      editor stays; otherwise it opens for real. */
  function unfold() {
    if (peekable()) peekSessions(true);
    else unfoldSessions();
    focusPane("sessions");
  }

  /** How long the pointer rests on the column before the pane peeks, so a
      pointer crossing it on the way to the agent does not flash it, and
      how long it is gone before the pane goes back. */
  const PEEK_AFTER = 200;
  const UNPEEK_AFTER = 300;

  // The pointer resting on the folded column peeks the pane over the pane
  // beside it where it peeks, and leaving the pane puts it back, unless the keyboard
  // is in it: then Escape, Enter or the focus chord put it back. A wait for
  // either ends once the pane peeks or goes back some other way, a click or
  // a chord, so a peek put away is not brought back by a pointer that came
  // to the column before it. A press in the pane is noted while it lasts,
  // so the keyboard arriving with a click is not taken for the keyboard
  // walking the rows.
  $effect(() => {
    const pane = nav?.closest<HTMLElement>('[data-pane="sessions"]');
    if (!pane) return;
    void layout.sessionsPeek;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = (what: () => void, after: number) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        what();
      }, after);
    };
    const enter = () => {
      pointerIn = true;
      if (!peekable() || sessionsVisible() || layout.sessionsPeek) return;
      later(() => peekSessions(true), PEEK_AFTER);
    };
    const press = () => {
      pressing = true;
      pressHeld = true;
      walking = false;
      keyed = false;
    };
    const release = () => {
      pressHeld = false;
      setTimeout(() => (pressing = false));
    };
    // A press let go outside the window may never be reported: the pointer
    // moving with no button down is the press over.
    const moved = (e: PointerEvent) => {
      if (pressHeld && e.buttons === 0) pressHeld = false;
    };
    const leave = () => {
      pointerIn = false;
      pointed = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // In compact mode the edge decides when the pane goes.
      if (compact.on) return;
      if (!layout.sessionsPeek || layout.focus === "sessions") return;
      later(() => peekSessions(false), UNPEEK_AFTER);
    };
    pane.addEventListener("pointerenter", enter);
    pane.addEventListener("pointerleave", leave);
    pane.addEventListener("pointerdown", press, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("pointermove", moved, true);
    return () => {
      if (timer !== null) clearTimeout(timer);
      pane.removeEventListener("pointerenter", enter);
      pane.removeEventListener("pointerleave", leave);
      pane.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("pointermove", moved, true);
    };
  });

</script>

<!-- The one glyph for a row that opens: pointing at what it holds while
     closed, and down at what it let out once open. -->
{#snippet chevron(open: boolean)}
  <svg class="chev" class:open viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
{/snippet}

<!-- A session's row. Its first line is its name and, at the end, when it
     last changed. A second line holds what the agent left for the row,
     with the model at its end, and for a session that started others what
     those are doing; a row with neither, and a row left from the last
     quit, takes the one line. The row's own buttons take the time's place
     on hover, and a session that started others has a chevron of its own
     at the end of its second line that folds them away. -->
{#snippet sessionRow(session: Session)}
  {@const kids = childrenOf(session)}
  {@const news = unheard(session)}
  {@const woken = wokenBy(session)}
  {@const folded = kids.length > 0 && collapsed[session.key] === true}
  {@const drawnSubs = subGroups.get(session.key) ?? []}
  <!-- Said of the rows drawn, so the line and the rows agree while they
       hold still. -->
  {@const subsSaid =
    folded || session.note !== null || kids.length > 0 || news.length > 0 || drawnSubs.length === 0
      ? null
      : subagentWords(drawnSubs)}
  {@const line = folded
    ? startedWords(kids)
    : (session.note ?? (kids.length > 0 || news.length > 0 ? startedWords(kids) : subsSaid))}
  {@const owned = session.note !== null && !folded}
  <div
    class="session"
    class:on={sessions.active === session.key}
    class:cursor={current === `session:${session.key}`}
    class:starter={kids.length > 0}
    data-row="session:{session.key}"
  >
    <button
      class="row line"
      class:two={line !== null}
      tabindex="-1"
      onclick={() => choose(session.key)}
      oncontextmenu={(e) => openSessionMenu(session.key, e)}
      title={session.model === null ? undefined : modelLabel(session.model)}
      data-testid="session-row"
    >
      <span
        class="dot"
        class:live={isLive(session)}
        class:dormant={session.status === "dormant"}
        class:working={conducting(session)}
        class:unread={session.unread}
        class:permission={session.needs === "permission"}
        title={statusLabel(session)}
      ></span>
      <span class="first">
        <span
          class="label"
          class:strong={session.status !== "dormant"}
          class:unread={session.unread || isAsking(session)}>{label(session)}</span
        >
        <span class="when" data-testid="session-when">{since(lastChanged(session), now)}</span>
      </span>
      {#if line !== null}
        <span class="second">
          <span
            class="note"
            class:asking={owned
              ? session.needs === "permission"
              : subsSaid !== null
                ? drawnSubs.some((one) => one.state === "asking")
                : kids.some(isAsking)}
            class:first-say={news.length > 0}
            class:shares={!folded && news.length === 0 && woken !== null}
            title={line}
            data-testid={owned ? "session-note" : subsSaid !== null ? "subagent-summary" : "orchestrator-summary"}>{line}</span
          >
          {#if news.length > 0}
            <!-- What it has not heard from the sessions it started, while it
                 is idle with no wait held, quietly where the model stands.
                 Short of room it gives way before the line beside it: the
                 words go first, then the dot and the count. -->
            <span class="news" title={newsTitle(session, news)} data-testid="starter-news"
              ><span class="news-gap"></span><span class="news-count">{news.length}</span
              ><span class="news-words">{" not heard yet"}</span></span
            >
          {/if}
          {#if folded}
            <!-- Folded, each session it started is a dot where the model
                 stands otherwise. -->
            <span class="meta" data-testid="started-dots">
              {#each kids as kid (kid.key)}<span
                  class="dot mini"
                  class:live={isLive(kid)}
                  class:working={kid.working}
                  class:permission={kid.needs === "permission"}
                ></span>{/each}
            </span>
          {:else if news.length === 0 && woken !== null}
            <!-- The workbench woke it, idle, with what the sessions it
                 started did: which, quietly where the model stands, until
                 the user looks at it with the wake's turn over, or a turn of
                 theirs begins. -->
            {@const words = wokenWords(woken)}
            <span
              class="meta woken"
              class:counted={words.count !== null}
              title={wokenTitle(session, woken)}
              data-testid="starter-woken"
              ><span class="woken-by">{"woken by "}</span
              >{#if words.name !== null}<span class="woken-name">{words.name}</span>{:else}{words.count}{/if}</span
            >
          {:else if news.length === 0 && session.model !== null}
            <span class="meta" data-testid="session-model">{modelLabel(session.model)}</span>
          {/if}
        </span>
      {/if}
      <!-- The dot says what the agent is doing; the words are for a
           screen reader and for anything reading the row's text. -->
      <span class="state told"
        >{statusLabel(session)}{#if news.length > 0}, {newsWords(news)}{/if}{#if woken !== null}, woken by {wokenWords(
            woken,
          ).name ?? wokenWords(woken).count}{/if}</span
      >
    </button>
    {#if kids.length > 0}
      <button
        class="disclose"
        tabindex="-1"
        onclick={() => toggleKids(session.key)}
        aria-expanded={!folded}
        aria-label={folded ? "Show the sessions it started" : "Fold the sessions it started"}
        title={folded ? "Show the sessions it started" : "Fold the sessions it started"}
        data-testid="collapse-started">{@render chevron(!folded)}</button
      >
    {/if}
    <span class="actions">
      <button
        class="icon"
        tabindex="-1"
        onclick={() => void closeSessionAsking(session)}
        aria-label="Close {label(session)}"
        title="Stop"
        data-testid="close-session">×</button
      >
    </span>
    {@render sessionMenuFor(session.key)}
  </div>
{/snippet}

<!-- A session's own menu, under its row, or over it near the pane's foot. -->
{#snippet sessionMenuFor(key: string)}
  {#if sessionMenu?.key === key}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="scrim" onclick={() => (sessionMenu = null)}></div>
    <div class="menu session-menu" data-card class:up={sessionMenu.up} role="menu" data-testid="session-menu">
      {#each sessionItems as item, index (item.id)}
        {#if item.destructive && index > 0}<div class="separator" role="separator"></div>{/if}
        <button
          role="menuitem"
          tabindex="-1"
          class:at={sessionMenuAt === index}
          class:destructive={item.destructive}
          onclick={() => fromSessionMenu(item)}
          disabled={item.disabled}
          title={item.title}
          data-testid={item.id}
        >
          <span>{item.label}</span>
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

<!-- A session's subagents, hanging under it on a rail of their own while
     they run, one line each: the state, the agent's glyph, what it was
     asked, which is the agent's text and drawn as it is, its kind while it
     runs or its state in a word after, asking in the accent, and when that
     last changed. A started session's hang one step further in, under its
     own row. One done stays greyed until its session's turn ends. A
     subagent is a run inside its session, not a session: it has no × and
     cannot be typed into, and its row opens the session at the call that
     started it. Folded to the narrow column, the rows keep their height
     and show only a dot for each, packed together. -->
{#snippet subagents(owner: Session, deep: boolean, pass: boolean, more: boolean)}
  {@const subs = subGroups.get(owner.key) ?? []}
  {#if subs.length > 0}
    <div class="subs" class:deep data-testid="subagent-rail">
      {#if pass}<span class="rail-pass" aria-hidden="true"></span>{/if}
      {#if more}<span class="rail-through" aria-hidden="true"></span>{/if}
      <span class="sub-dots" aria-hidden="true" data-testid="subagent-dots"
        >{#each subs as one (one.call)}<span
            class="dot mini"
            class:live={one.state === "running" || one.state === "asking"}
            class:working={one.state === "running"}
            class:permission={one.state === "asking"}
            class:over={one.state === "done" || one.state === "stopped"}
            class:bad={one.state === "failed"}
          ></span>{/each}</span
      >
      {#each subs as one, index (one.call)}
        {@const id = subId(owner.key, one.call)}
        {@const note = subagentNote(one)}
        {@const over = one.state !== "running" && one.state !== "asking"}
        <div
          class="session sub"
          class:first={index === 0}
          class:over
          class:cursor={current === id}
          data-row={id}
          in:rowFade|local
          out:rowFade|local
        >
          <span class="rail-in" aria-hidden="true"></span>
          {#if index < subs.length - 1 || more}<span class="rail-on" aria-hidden="true"></span>{/if}
          <button
            class="row sub-row"
            tabindex="-1"
            onclick={() => openSubagent(owner.key, one.call)}
            title={one.about === null ? undefined : shown(one.about)}
            aria-label={subagentSaid(one)}
            data-testid="subagent-row"
            data-state={one.state}
          >
            <span
              class="dot"
              class:live={!over}
              class:working={one.state === "running"}
              class:permission={one.state === "asking"}
              class:bad={one.state === "failed"}
            ></span>
            <span class="sub-glyph"><Icon name="agent" size={11} /></span>
            <span class="label sub-label" data-testid="subagent-about"
              >{#if one.about === null}Subagent{:else}<Plain text={one.about} />{/if}</span
            >
            {#if note !== null}
              <span
                class="sub-note"
                class:asking={one.state === "asking"}
                class:bad={one.state === "failed"}
                data-testid="subagent-note">{#if one.state === "running"}<Plain text={note} />{:else}{note}{/if}</span
              >
            {/if}
            <span class="when">{since(one.at, now)}</span>
          </button>
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

<!-- The sessions a session started, hanging under it on a rail from its
     dot, one line each: the state, the name, the account it runs under
     when that is not its project's, the project it runs in when that is
     another, the model, or its step and round, or, in the accent, that it
     is asking for a permission, and when it last changed. Short of room,
     the project is cut first, then the model goes whole and the project
     with it, then the account, and the name gives way last; the time, the
     step and round, and asking always stand. Delete does nothing on these
     rows; their own × stops them. -->
{#snippet rail(parent: Session)}
  {@const kids = childrenOf(parent)}
  {@const news = unheard(parent)}
  {#if kids.length > 0 && !collapsed[parent.key]}
    <div class="kids" class:after-subs={subGroups.has(parent.key)} data-testid="started-rail">
      {#each kids as kid, index (kid.key)}
        <!-- A session started for a step of its starter's workflow shows
             its step and round where another shows its model, "Review, 2
             of 4": the step set the model, and the step is what tells the
             rows apart. -->
        {@const role = placeTextOf(kid.key)?.short ?? null}
        <div
          class="session kid"
          class:first={index === 0}
          class:on={sessions.active === kid.key}
          class:cursor={current === `session:${kid.key}`}
          data-row="session:{kid.key}"
          in:rowFade|local
          out:rowFade|local
        >
          <span class="rail-in" aria-hidden="true"></span>
          {#if index < kids.length - 1}<span class="rail-on" aria-hidden="true"></span>{/if}
          <button
            class="row kid-row"
            tabindex="-1"
            onclick={() => choose(kid.key)}
            oncontextmenu={(e) => openSessionMenu(kid.key, e)}
            data-testid="started-session"
          >
            <span
              class="dot"
              class:live={isLive(kid)}
              class:dormant={kid.status === "dormant"}
              class:working={kid.working}
              class:unread={kid.unread}
              class:permission={kid.needs === "permission"}
              title={statusLabel(kid)}
            ></span>
            <span class="fit">
              <span class="label" class:unread={kid.unread || isAsking(kid)}>{label(kid)}</span>
              {#if otherAccount(kid)}<span
                  class="account"
                  title="Runs under the {accountLabel(kid.account)} account"
                  data-testid="started-account">as {accountLabel(kid.account)}</span
                >{/if}
              {#if kid.project !== parent.project}<span class="where" data-testid="started-where"
                  >{projectLabel(kid.project)}</span
                >{/if}
              {#if !isAsking(kid) && role === null && kid.model !== null}
                <span class="model" data-testid="started-model">{modelLabel(kid.model)}</span>
              {/if}
              {#if news.includes(kid)}
                <!-- What its starter has not heard, which the starter's row
                     counts: last on the line, so it goes before the rest. -->
                <span
                  class="news-mark"
                  title="{label(parent)} has not heard this yet"
                  data-testid="started-news"
                ></span>
              {/if}
            </span>
            {#if isAsking(kid)}
              <span class="model asking" data-testid="started-asking">asking</span>
            {:else if role !== null}
              <span class="model role" data-testid="started-role">{role}</span>
            {/if}
            <span class="when">{since(lastChanged(kid), now)}</span>
            <span class="state told"
              >{statusLabel(kid)}{#if news.includes(kid)}, not heard by {label(parent)} yet{/if}</span
            >
          </button>
          <span class="actions">
            <button
              class="icon"
              tabindex="-1"
              onclick={() => void closeSessionAsking(kid)}
              aria-label="Close {label(kid)}"
              title="Stop"
              data-testid="close-session">×</button
            >
          </span>
          {@render sessionMenuFor(kid.key)}
        </div>
        {@render subagents(kid, true, index < kids.length - 1, false)}
      {/each}
    </div>
  {/if}
{/snippet}

<!-- A past session of the project on screen, to resume where it ran: one
     line, like a row left from the last quit, with its time. -->
{#snippet pastRow(path: string, transcript: HistoryEntry)}
  <div class="session past-row" class:cursor={current === `past:${transcript.id}`} data-row="past:{transcript.id}">
    <button
      class="row past"
      tabindex="-1"
      onclick={() => resume(path, transcript)}
      disabled={!isReady()}
      title={shown(transcript.title ?? transcript.id)}
      data-testid="past-session"
    >
      <span class="dot"></span>
      <span class="label">{historyLabel(transcript)}</span>
      {#if transcript.cwd}<span class="tag where" title={transcript.cwd} data-testid="session-where"
          >{lastSegment(transcript.cwd)}</span
        >{/if}
      {#if transcript.account !== null}<span class="tag account" data-testid="past-account">{transcript.account}</span
        >{/if}
      <span class="when">{since(transcript.modified * 1000, now)}</span>
    </button>
    <span class="actions">
      <button
        class="icon"
        tabindex="-1"
        onclick={() => disown(path, transcript.id)}
        aria-label="Archive {historyLabel(transcript)}"
        title="File with the sessions to resume"
        data-testid="archive-past">↧</button
      >
    </span>
  </div>
{/snippet}

<!-- A project's name, with the part of the path that tells it from
     another of the same name dimmed in front of it. -->
{#snippet projectName(path: string)}
  {@const full = projectLabel(path)}
  {@const cut = full.lastIndexOf("/") + 1}
  {#if cut > 0}<span class="prefix">{full.slice(0, cut)}</span>{/if}{full.slice(cut)}
{/snippet}

<!-- A project's own menu, under the button that opened it, or over it
     near the pane's foot. -->
{#snippet projectMenuFor(path: string)}
  {#if projectMenu?.path === path}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="scrim" onclick={() => (projectMenu = null)}></div>
    <div class="menu project-menu" data-card class:up={projectMenu.up} role="menu" data-testid="project-menu">
      {#each projectItems as item, index (item.id)}
        {#if item.destructive && index > 0}<div class="separator" role="separator"></div>{/if}
        <button
          role="menuitem"
          tabindex="-1"
          class:at={projectMenuAt === index}
          class:destructive={item.destructive}
          onclick={() => fromProjectMenu(item)}
          disabled={item.disabled}
          data-testid={item.id}
        >
          <span>{item.label}</span>
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

<!-- The ⋯ that opens a project's menu, shown while the pointer is on its
     row. -->
{#snippet moreButton(path: string)}
  <button
    class="add-here more"
    class:open={projectMenu?.path === path}
    tabindex="-1"
    onclick={(e) => openProjectMenu(path, e)}
    aria-haspopup="menu"
    aria-expanded={projectMenu?.path === path}
    aria-label="More for {projectLabel(path)}"
    title={startsIn(path) ? "New session, close" : "Close"}
    data-testid="project-more"
    ><svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"
      ><circle cx="3.5" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12.5" cy="8" r=".9" /></svg
    ></button
  >
{/snippet}

<!-- A project's header: its name, with the part of the path that tells it
     from another of the same name dimmed, what else tells it apart, and a
     button for a new session in it. Its ⋯, or a right click, opens its
     menu, which is where closing it is. It stays in view while its rows
     scroll under it. -->
{#snippet projectRow(project: { path: string; isGit: boolean })}
  <div
    class="project"
    class:on={screenProject === project.path}
    class:menu-open={projectMenu?.path === project.path}
    class:cursor={current === `project:${project.path}`}
    data-row="project:{project.path}"
    data-testid="project-head"
  >
    <button
      class="row project-row"
      tabindex="-1"
      onclick={() => pickProject(project.path)}
      oncontextmenu={(e) => openProjectMenu(project.path, e)}
      title={project.path}
    >
      <span class="name">{@render projectName(project.path)}</span>
      {#if accountOf(project.path) !== null}<span class="tag account" data-testid="project-account"
          >{accountOf(project.path)}</span
        >{/if}
      {#if hostOf(project.path) !== null}<span class="host" data-testid="project-host">{hostOf(project.path)}</span>{/if}
      {#if !project.isGit}<span class="flag" title="Not a git repository">no git</span>{/if}
    </button>
    {@render moreButton(project.path)}
    {#if startsIn(project.path)}
      <button
        class="add-here"
        tabindex="-1"
        onclick={() => offer(project.path)}
        disabled={!isReady()}
        aria-label="New session in {projectLabel(project.path)}"
        title="New session"
        data-testid="project-new-session"><svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button
      >
    {/if}
    {@render projectMenuFor(project.path)}
  </div>
{/snippet}

<!-- What stands under a project's name, in the order the keyboard walks
     it. Each row is drawn in a slot of its own, which is what fades and
     what moves: a row that goes leaves the ones below it to close the gap
     rather than jump into it. -->
{#snippet projectBody(path: string)}
  {@const { entries, hidden } = bodies.get(path) ?? NO_BODY}
  {@render newSession(path)}
  {#each entries as entry (entry.id)}
    <div class="row-slot" animate:flip={rowMove()} in:rowFade|local out:rowFade|local>
      {#if entry.kind === "session"}
        {@render sessionRow(entry.session)}
        {@render subagents(entry.session, false, false, childrenOf(entry.session).length > 0 && !collapsed[entry.session.key])}
        {@render rail(entry.session)}
      {:else}
        {@render pastRow(path, entry.transcript)}
      {/if}
    </div>
  {/each}
  {#if hidden.length > 0}
    <button
      class="fold tail"
      class:cursor={current === `more:${path}`}
      tabindex="-1"
      onclick={() => toggle(`more:${path}`)}
      data-row="more:{path}"
      data-testid="quiet-more"
    >
      {@render chevron(false)}
      <span class="fold-text">{moreLabel(hidden.length, Math.min(...hidden.map((entry) => entry.at)), now)}</span>
    </button>
  {/if}

  {#if screenProject === path}
    <!-- Every session the agents ran here and this window does not list,
         from a plain terminal most of all: one row that counts them and
         opens the dialog to resume from. It opens something else rather
         than opening here, so it has a glyph of its own, not the chevron,
         and ends in an ellipsis. -->
    {#if outsideFor(path).length > 0}
      {@const earlier = outsideFor(path).length}
      <button
        class="fold tail"
        class:cursor={current === `earlier:${path}`}
        tabindex="-1"
        onclick={() => openResume(path)}
        data-row="earlier:{path}"
        data-testid="earlier-sessions"
      >
        <svg class="chev history" viewBox="0 0 16 16" aria-hidden="true"
          ><path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7" /><path d="M2.6 2.6v2.6h2.6" /><path d="M8 5.2V8l1.9 1.2" /></svg
        >
        <span class="fold-text">{earlier} earlier {earlier === 1 ? "session" : "sessions"}…</span>
      </button>
    {/if}
  {/if}
{/snippet}

<!-- With several agents, or accounts to run under, a new session opens
     the choice under the project's name; with neither there is nothing to
     choose and it starts. -->
{#snippet newSession(path: string)}
  {#if choosable && choosing === path}
    <div class="choice" role="group" aria-label="Agent for the new session" data-testid="agent-choice">
      <div class="choice-head">
        <span>new session {hasAccounts() ? "as" : "with"}</span>
        <button class="cancel" tabindex="-1" onclick={dismiss} aria-label="Cancel" data-testid="choice-cancel"
          >Esc</button
        >
      </div>
      <!-- The account comes before the agent: the control takes the row's
           width under the head, and the agents follow under "with". -->
      {#if hasAccounts()}
        <div class="accounts" role="radiogroup" aria-label="Account for the new session" data-testid="account-choice">
          {#each offered as account (account ?? "")}
            <button
              role="radio"
              tabindex="-1"
              aria-checked={picked === account}
              class:on={picked === account}
              onclick={() => (picked = account)}
              data-testid="account-option"
              data-account={account ?? ""}>{accountLabel(account)}</button
            >
          {/each}
        </div>
        <div class="choice-head"><span>with</span></div>
      {/if}
      {#if workflowOf(path) !== null}
        <button
          class="option"
          class:cursor={current === `pick:${path}:${FOLLOW}`}
          tabindex="-1"
          onclick={() => startFollowing(path)}
          data-row="pick:{path}:{FOLLOW}"
          data-testid="workflow-option"
          data-workflow={workflowOf(path)?.name}
        >
          <span class="mark">›</span>
          <span class="label">{workflowOf(path)?.name}</span>
          <span class="state">{followedBy(path)}</span>
        </button>
      {/if}
      {#each installed() as id (id)}
        <button
          class="option"
          class:cursor={current === `pick:${path}:${id}`}
          tabindex="-1"
          onclick={() => startWith(path, id)}
          data-row="pick:{path}:{id}"
          data-testid="agent-option"
          data-agent={id}
        >
          <span class="mark">›</span>
          <span class="label">{agentLabel(id)}</span>
          {#if sessions.preferred[path] === id}<span class="state">last used</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

<!-- On the pane's title row: the order the projects are listed in, and
     the menu with the ways to open a project and the settings. Both are on
     the cursor path, and the arrows walk a menu's items while it is open. -->
{#snippet titleTools()}
  <div class="tools" class:folded inert={folded}>
    <button
      class="sort"
      class:cursor={current === "sort"}
      class:open={sortOpen}
      tabindex="-1"
      onclick={openSort}
      aria-haspopup="menu"
      aria-expanded={sortOpen}
      data-row="sort"
      data-testid="project-sort"
      aria-label="Sort projects: {sortLabel}"
      title="Sort projects: {sortLabel}"
      ><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h7M3 11.5h4" /></svg></button
    >
    {#if sortOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="scrim" onclick={() => (sortOpen = false)}></div>
      <div class="menu sort-menu" data-card role="menu" data-testid="project-sort-menu">
        {#each SORTS as choice, index (choice.sort)}
          <button
            role="menuitemradio"
            tabindex="-1"
            aria-checked={layout.projectSort === choice.sort}
            class:at={sortAt === index}
            onclick={() => pickSort(choice.sort)}
            data-testid="project-sort-{choice.sort}"
          >
            <span>{choice.label}</span>
            {#if layout.projectSort === choice.sort}<svg class="tick" viewBox="0 0 16 16" aria-hidden="true"
                ><path d="m3.5 8.5 3 3 6-7" /></svg
              >{/if}
          </button>
        {/each}
      </div>
    {/if}
    <button
      class="tool"
      class:cursor={current === "menu"}
      tabindex="-1"
      onclick={openMenu}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label="More"
      title="Open a project, or the settings"
      data-row="menu"
      data-testid="sessions-menu"
      ><svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"
        ><circle cx="3.5" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12.5" cy="8" r=".9" /></svg
      ></button
    >
    {#if menuOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="scrim" onclick={() => (menuOpen = false)}></div>
      <div class="menu more-menu" data-card role="menu" data-testid="sessions-menu-items">
        {#each menuItems as item, index (item.id)}
          <button
            role="menuitem"
            tabindex="-1"
            class:at={menuAt === index}
            onclick={() => fromMenu(item)}
            disabled={item.disabled}
            title={item.title}
            data-testid={item.id}
          >
            <span>{item.label}</span>
            {#if item.chord}<kbd class="chord">{item.chord}</kbd>{/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<Pane id="sessions" title="Projects &amp; sessions" meta="" head={titleTools}>
  {#if folded}
    <button
      class="unfold"
      onpointerdown={(e) => e.preventDefault()}
      onclick={unfold}
      disabled={!unfoldable}
      aria-label="Show sessions"
      title="Show sessions ({describe(chordFor('toggle.sessions'))})"
      data-testid="unfold-sessions"><span class="unfold-mark" aria-hidden="true">›</span></button
    >
  {/if}

  {#if editor.closing !== null || reopenQuestion !== null}
    <!-- Closing a session or a project whose tabs hold the only copy of
         unsaved edits, or whose shells are busy, asks first, here where it
         was closed; so does reopening a session the other way in the
         middle of a turn. -->
    <div class="closing" class:folded inert={folded} bind:this={closingStrip}>
      {#if reopenQuestion !== null}
        <ConfirmStrip
          question={reopenQuestion.question}
          detail={reopenQuestion.detail}
          action="Stop and reopen"
          onConfirm={reopenConfirm}
          onCancel={reopenCancel}
          testid="reopen-session"
        />
      {:else if editor.closing !== null && editor.closing.keys.length > 0}
        <ConfirmStrip
          question="Close {editor.closing.what} with unsaved edits?"
          detail="{editor.closing.keys.length === 1 ? '1 file' : `${editor.closing.keys.length} files`} open beside it {editor.closing.keys.length === 1 ? 'has' : 'have'} edits not yet saved: {unsavedNames(editor.closing.keys).join(', ')}.{closingAside(editor.closing.kind, editor.closing.busy)}"
          action="Close without saving"
          alternative={{ label: "Save and close", onClick: () => void closingSave() }}
          safe
          onConfirm={closingDrop}
          onCancel={closingCancel}
          testid="close-owner"
        />
      {:else if busyAsk !== null}
        <ConfirmStrip
          question={busyAsk.question}
          detail={busyAsk.detail}
          action={busyAsk.action}
          onConfirm={closingDrop}
          onCancel={closingCancel}
          testid="close-owner"
        />
      {/if}
    </div>
  {/if}

  {#if reopenError !== null}
    <div class="error-row" class:folded inert={folded}>
      <p class="error" data-testid="reopen-error">{reopenError}</p>
      <button
        class="dismiss"
        tabindex="-1"
        onclick={() => (reopenError = null)}
        aria-label="Dismiss"
        title="Dismiss"
        data-testid="reopen-error-dismiss">×</button
      >
    </div>
  {/if}

  {#if workspace.error}
    <div class="error-row" class:folded inert={folded}>
      <p class="error" data-testid="project-error">{workspace.error}</p>
      <button
        class="dismiss"
        tabindex="-1"
        onclick={() => (workspace.error = null)}
        aria-label="Dismiss"
        title="Dismiss"
        data-testid="project-error-dismiss">×</button
      >
    </div>
  {/if}

  <!-- One tab stop with a cursor inside, the tree's pattern. The rows stay
       buttons for the mouse; the keyboard goes through here. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="nav"
    class:folded
    class:wide
    inert={folded}
    tabindex="0"
    aria-label="Projects and sessions"
    bind:this={nav}
    onkeydown={onKeydown}
    onpointerdown={onPointerdown}
    onpointerover={onPointerover}
    onfocusin={onFocusin}
    onfocusout={onFocusout}
    data-testid="sessions-nav"
  >
  <!-- The way to any session or project, which is the palette's go to, and
     a new session, asked for in the palette, on the same cursor as the
     rows. -->
  <div class="head">
    <button class="go" class:cursor={current === "go"} tabindex="-1" onclick={openGoTo} data-row="go" data-testid="go-to">
      <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3 3" /></svg>
      <span class="go-text">Go to session or project</span>
      <kbd>{describe(chordFor("goto"))}</kbd>
    </button>
    <button
      class="add"
      class:cursor={current === "new"}
      tabindex="-1"
      onclick={newFromHead}
      disabled={workspace.open.length === 0 || !isReady()}
      aria-label="New session"
      title="New session"
      data-row="new"
      data-testid="new-session"><svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button
    >
  </div>
  <div class="tree" bind:this={tree} onscroll={measureUnder}>
    {#if workspace.open.length === 0}
      <div class="empty" data-testid="no-project">
        <p>Open a folder to work in. A session starts there, and the changes pane watches it.</p>
        <button
          class="open-first"
          class:cursor={current === "open"}
          tabindex="-1"
          onclick={() => void pick()}
          disabled={workspace.opening}
          data-row="open"
          data-testid="open-first-project">Open project…</button
        >
      </div>
    {/if}
      {#each split.active as project (project.path)}
        <section class="proj" data-testid="project-section">
          {@render projectRow(project)}
          {@render projectBody(project.path)}
        </section>
      {/each}

      <!-- The projects nobody has used for a while, folded at the foot:
           each with when it was last used, and its menu on hover in that
           time's place. Picking one brings it forward, and it is in use
           again. -->
      {#if split.inactive.length > 0}
        <div class="inactive" data-testid="inactive">
          <button
            class="inactive-head"
            class:cursor={current === "inactive"}
            tabindex="-1"
            onclick={() => toggle("inactive")}
            aria-expanded={opened.inactive === true}
            data-row="inactive"
            data-testid="inactive-fold"
          >
            {@render chevron(opened.inactive === true)}
            <span class="inactive-title">Inactive</span>
            <span class="inactive-count"
              >{split.inactive.length} {split.inactive.length === 1 ? "project" : "projects"}</span
            >
          </button>
          {#if opened.inactive}
            {#each idle as project (project.path)}
              {@const used = lastUsed(project.path)}
              <div
                class="idle"
                class:cursor={current === `idle:${project.path}`}
                data-row="idle:{project.path}"
                in:rowFade|local
                out:rowFade|local
              >
                <button
                  class="row idle-row"
                  tabindex="-1"
                  onclick={() => void wake(project.path)}
                  oncontextmenu={(e) => openProjectMenu(project.path, e)}
                  title={project.path}
                  data-testid="inactive-project"
                >
                  <span class="name">{@render projectName(project.path)}</span>
                  {#if accountOf(project.path) !== null}<span class="tag account">{accountOf(project.path)}</span>{/if}
                  {#if hostOf(project.path) !== null}<span class="host">{hostOf(project.path)}</span>{/if}
                  <span class="when" data-testid="inactive-when">{used === null ? "" : since(used, now)}</span>
                </button>
                <span class="actions">{@render moreButton(project.path)}</span>
                {@render projectMenuFor(project.path)}
              </div>
            {/each}
            {#if idle.length < split.inactive.length}
              <button
                class="fold idle-more"
                class:cursor={current === "idle-more"}
                tabindex="-1"
                onclick={() => toggle("idle-more")}
                data-row="idle-more"
                data-testid="inactive-more"
                >{@render chevron(false)}<span class="fold-text">{split.inactive.length - idle.length} more</span></button
              >
            {/if}
          {/if}
        </div>
      {/if}
  </div>
  <!-- Whose login the session on screen runs under, once there are
       accounts to tell apart, and the way to the settings beside it. -->
  {#if footAccount !== null}
    <div class="foot" class:under>
      <span class="avatar" aria-hidden="true">{footAccount.slice(0, 1).toUpperCase()}</span>
      <span class="who" data-testid="pane-account">{footAccount}</span>
      <button
        class="gear"
        tabindex="-1"
        onclick={() => openSettings()}
        aria-label="Settings"
        title="Settings ({describe(chordFor('settings'))})"
        data-testid="pane-settings"
        ><svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"
          ><circle cx="8" cy="8" r="2.2" /><path
            d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"
          /></svg
        ></button
      >
    </div>
  {/if}
  </div>
  <!-- Subagents as they start, said once each, outside the rows, which
       are inert while the pane is folded. -->
  <p class="state told" aria-live="polite" data-testid="subagent-said">{subagentSaidNow}</p>
</Pane>

<style>
  /* The button the folded pane is, laid over it so a click anywhere opens
     it, with its mark where the way in stands when the pane is open. */
  :global([data-pane="sessions"] > .body) {
    position: relative;
  }

  .unfold {
    position: absolute;
    inset: 0;
    z-index: 3;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }

  .unfold:disabled {
    cursor: default;
  }

  .unfold-mark {
    position: absolute;
    top: 8px;
    left: 0;
    width: var(--folded);
    height: 26px;
    display: grid;
    place-items: center;
    font-family: var(--chrome);
    font-size: 15px;
    color: var(--ink-3);
  }

  .unfold:hover:not(:disabled) .unfold-mark {
    color: var(--accent);
  }

  .unfold:disabled .unfold-mark {
    visibility: hidden;
  }

  /* Folded, every row keeps its place and its height and shows only what
     says whose sessions these are: a project's name, cut at the column's
     edge, and the dots of the sessions under it. Nothing moves when the pane
     opens again. */
  .nav.folded {
    mask-image: linear-gradient(to right, #000 calc(var(--folded) - 14px), transparent calc(var(--folded) - 3px));
  }

  /* Folded wide, the start of each session's name shows beside its dot,
     fading out at the column's edge. */
  .nav.folded.wide {
    mask-image: linear-gradient(to right, #000 calc(var(--folded) - 20px), transparent calc(var(--folded) - 2px));
  }

  .nav.folded .project-row .name {
    text-overflow: clip;
  }

  /* The column is too narrow for the part of a path that tells two
     projects of one name apart: it shows the name. */
  .nav.folded .prefix {
    display: none;
  }

  .nav.folded .head,
  .nav.folded .label,
  .nav.folded .when,
  .nav.folded .second,
  .nav.folded .model,
  .nav.folded .where,
  .nav.folded .disclose,
  .nav.folded .tag,
  .nav.folded .state,
  .nav.folded .actions,
  .nav.folded .icon,
  .nav.folded .host,
  .nav.folded .flag,
  .nav.folded .fold,
  .nav.folded .add-here,
  .nav.folded .foot,
  .nav.folded .empty,
  .nav.folded .inactive,
  .nav.folded .choice,
  .nav.folded .cursor::before,
  .error-row.folded {
    visibility: hidden;
  }

  .nav.folded.wide .session .first .label {
    visibility: visible;
  }

  /* The head: a field that opens go to, and beside it the accent button
     that asks for a new session. */
  .head {
    flex: none;
    display: flex;
    gap: 6px;
    padding: 10px 10px 8px;
  }

  .glyph {
    width: 14px;
    height: 14px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .go {
    flex: 1;
    min-width: 0;
    height: 30px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 9px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--field-bg);
    font-family: var(--chrome);
    font-size: var(--field-size);
    color: var(--ink-3);
    text-align: left;
    cursor: pointer;
  }

  .go:hover {
    color: var(--ink-2);
  }

  .go-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  kbd {
    flex: none;
    padding: 0 4px;
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius-tag);
    font: 11px/16px var(--chrome);
    color: var(--ink-3);
  }

  .add {
    flex: none;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius);
    background: var(--accent);
    color: var(--on-accent, var(--bg));
    cursor: pointer;
  }

  .add:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* The head's controls show the cursor as a ring, while the keyboard is
     in the pane. */
  .nav:focus-within .go.cursor,
  .nav:focus-within .add.cursor,
  :global([data-pane="sessions"]:has(.nav:focus-within)) .tools .cursor {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .nav:focus-within .head .cursor::before {
    content: none;
  }

  /* The sort and the menu, at the end of the pane's title row. */
  /* Taller than the title's line, they reach into the header's padding
     rather than make the row taller than the header beside it. */
  .tools {
    position: relative;
    margin: -4px 0 -4px auto;
    display: flex;
    align-items: center;
    gap: 2px;
    font-family: var(--chrome);
    font-size: var(--fold-size);
    color: var(--ink-3);
  }

  .tools.folded {
    visibility: hidden;
  }

  /* The title's row keeps room for its tools, and the title gives way
     first. */
  :global([data-pane="sessions"] > header > .head) {
    flex: none;
    align-self: center;
  }

  .sort,
  .tool {
    flex: none;
    width: 22px;
    height: 22px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .sort svg,
  .sort-menu .tick {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
  }

  .sort:hover,
  .sort.open {
    background: var(--surface-2);
    color: var(--ink);
  }

  .sort-menu {
    top: calc(100% + 2px);
    right: var(--row-pad-x);
    min-width: 150px;
  }

  .sort-menu button {
    align-items: center;
  }

  .sort-menu button.at {
    background: var(--surface-2);
    color: var(--ink);
  }

  .sort-menu .tick {
    color: var(--accent);
  }

  .tool:hover,
  .tool[aria-expanded="true"] {
    background: var(--surface-2);
    color: var(--ink);
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 4;
  }

  /* A few short items, in a pane that can be narrower than the changes
     pane's menu: sized to fit inside the pane rather than past its edge. */
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 5;
    min-width: 184px;
    padding: 4px 0;
    background: var(--paint-surface);
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px color-mix(in srgb, black 25%, transparent);
  }

  .menu button {
    display: flex;
    width: 100%;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding: 5px var(--pane-pad);
    border: 0;
    background: none;
    font-size: 12.5px;
    color: var(--ink-2);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .menu button:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink);
  }

  .menu button.at:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink);
  }

  .more-menu {
    right: var(--row-pad-x);
  }

  .menu .separator {
    height: 1px;
    margin: 4px 0;
    background: var(--rule);
  }

  .menu button.destructive,
  .menu button.destructive:hover:not(:disabled),
  .menu button.destructive.at:not(:disabled) {
    color: var(--del);
  }

  .menu button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* Where a project is, when it is not here. */
  .host {
    flex: none;
    margin-left: 6px;
    padding: 0 4px;
    border: 1px solid var(--rule);
    border-radius: var(--radius-tag);
    font-size: 9.5px;
    letter-spacing: var(--label-track-fine);
    color: var(--ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 12ch;
  }

  .nav {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    outline: none;
  }

  .tree {
    flex: 1;
    overflow-y: auto;
    padding: 0 0 12px;
    min-height: 0;
    /* The rows and the pinned headers stack inside the list, so the
       scroll bar the list draws over them stays above every one. */
    isolation: isolate;
  }

  /* A project and what stands under it. A hairline separates it from the
     one above. */
  .proj + .proj {
    margin-top: 6px;
    padding-top: 2px;
    border-top: 1px solid var(--head-rule);
  }

  /* The project's header stays in view while its rows scroll under it,
     until the next project's pushes it out. It spans the pane's width so
     nothing shows past its edges as the rows go under it. */
  .proj > .project {
    position: sticky;
    top: 0;
    z-index: 2;
    margin: 0;
    padding: 0 var(--row-inset);
    border-radius: 0;
    background: var(--pane-bg);
  }

  /* With a background the header that stays in view carries the pane's
     tint, so the rows still pass under it and nothing shows a seam. */
  :global(:root[data-background][data-look="modern"]) .proj > .project {
    background: linear-gradient(var(--tint-side), var(--tint-side)), var(--tint-backdrop);
  }

  .project-row {
    padding-top: calc(var(--row-pad-y) + 2px);
    gap: 7px;
  }

  /* The account a project runs under, in the header's quieter hand. */
  .project .tag.account {
    color: var(--ink-2);
    border-color: var(--rule-strong);
  }

  .add-here {
    flex: none;
    width: 22px;
    height: 22px;
    margin-right: calc(var(--row-pad-x) - 6px);
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .add-here:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink);
  }

  /* A project's ⋯: there while the pointer is on its row, or its menu is
      open. */
  .add-here.more {
    opacity: 0;
  }

  .project:hover .add-here.more,
  .idle:hover .add-here.more,
  .add-here.more.open {
    opacity: 1;
  }

  .add-here.more.open {
    background: var(--surface-2);
    color: var(--ink);
  }

  /* A header with its menu open stands over the headers below it. */
  .proj > .project.menu-open {
    z-index: 6;
  }

  .project-menu {
    top: calc(100% + 2px);
    right: var(--row-pad-x);
    min-width: 150px;
  }

  .project-menu.up {
    top: auto;
    bottom: calc(100% + 2px);
  }

  /* A session's menu hangs from its row's right, under the row's own
     buttons, and stands over the rows below it. */
  .session-menu {
    top: calc(100% + 2px);
    right: var(--row-pad-x);
    min-width: 190px;
  }

  .session-menu.up {
    top: auto;
    bottom: calc(100% + 2px);
  }

  .session:has(> .session-menu) {
    z-index: 6;
  }

  .menu .chord {
    flex: none;
    margin-left: auto;
    font-size: 11px;
  }

  .add-here:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* The foot: the account the session on screen runs under, and the
     settings. */
  .foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 37px;
    padding: 6px 14px;
    border-top: 1px solid transparent;
    font-family: var(--chrome);
    font-size: var(--label-size);
    color: var(--ink-2);
  }

  .foot.under {
    border-top-color: var(--head-rule);
  }

  .avatar {
    flex: none;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 10.5px;
    font-weight: 600;
  }

  .who {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gear {
    flex: none;
    margin-left: auto;
    padding: 4px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .gear:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  /* The cursor is a bar at the pane's left edge, clear of any text: every
     row spans the pane's width, so the bar sits in the same place whatever
     the row's own indent. It shows while the keyboard is in the pane, and
     only then: a highlight that outlives the keyboard would look like a
     second selection. */
  .cursor {
    position: relative;
  }

  .nav:focus-within .cursor::before {
    content: "";
    position: absolute;
    left: 3px;
    top: 3px;
    bottom: 3px;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
  }

  .project,
  .session {
    --row-bg: var(--pane-bg);
    display: flex;
    align-items: center;
    margin: 0 var(--row-inset);
    border-radius: var(--radius);
    /* The fill moves from row to row rather than jumping between them. */
    transition: background-color 120ms ease;
  }

  .session {
    position: relative;
  }

  .session:hover {
    --row-bg: var(--surface-2);
    background: var(--row-bg);
  }

  /* The row's own button takes the time's place on its first line while
     the pointer is on the row, so it never covers a word. */
  .actions {
    position: absolute;
    top: var(--row-pad-y);
    right: calc(var(--row-pad-x) - 5px);
    height: calc(var(--row-size) * 1.5);
    display: flex;
    align-items: center;
    opacity: 0;
  }

  .session:hover .actions,
  .idle:hover .actions,
  .actions:focus-within {
    opacity: 1;
  }

  .session:hover > .row .when,
  .idle:hover > .row .when {
    visibility: hidden;
  }

  .kid .actions {
    top: 3px;
    height: calc(var(--fold-size) * 1.5);
  }

  .past-row .past {
    flex: 1;
  }

  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    line-height: 1.5;
    text-align: left;
    padding: var(--row-pad-y) var(--row-pad-x);
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: var(--row-size);
    color: var(--ink-2);
    cursor: pointer;
  }

  .project-row .name {
    color: var(--ink);
    font-weight: var(--project-weight);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }


  .flag {
    font-size: 10px;
    color: var(--ink-3);
    flex: none;
  }

  /* A session's row: the dot in a column of its own beside the first
     line, and each line laid out on its own, so what the second carries
     at its end takes nothing from the name on the first. The dot sits
     under the project's name, so the folded column keeps it in view. */
  .row.line {
    display: grid;
    grid-template-columns: calc(var(--dot) + 10px) minmax(0, 1fr);
    row-gap: 1px;
    align-items: center;
  }

  .row.line .dot {
    grid-column: 1;
    grid-row: 1;
  }

  .first,
  .second {
    grid-column: 2;
    min-width: 0;
    display: flex;
    align-items: baseline;
  }

  .first {
    grid-row: 1;
  }

  .second {
    grid-row: 2;
    font-size: var(--label-size);
    line-height: 1.35;
    color: var(--ink-3);
  }

  .first .label,
  .second .note {
    flex: 1;
  }

  /* The model, or a folded starter's dots, at the second line's end. */
  .meta {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding-left: 10px;
    white-space: nowrap;
    color: var(--ink-3);
  }

  /* What woke a starter gives way before the line beside it, down to
     "woken by" and the first letters of the name; how many sessions woke
     it is never cut. Its shrink so outweighs the line's that the line
     gives not a fraction of a pixel, which would cut its last letter,
     until the mark is down to its least. */
  .second .note.shares {
    flex: 1 1 auto;
    min-width: 0;
  }

  .meta.woken {
    flex: 0 1000 auto;
    min-width: calc(13ch + 10px);
    overflow: hidden;
    gap: 0;
  }

  .meta.woken.counted {
    flex: none;
  }

  .woken-by {
    flex: none;
    white-space: pre;
  }

  .woken-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* A starter keeps the end of its second line for its chevron. */
  .starter .second {
    padding-right: 18px;
  }

  .disclose {
    position: absolute;
    right: calc(var(--row-pad-x) - 4px);
    top: calc(var(--row-pad-y) + var(--row-size) * 1.5 + 1px);
    width: 18px;
    height: calc(var(--label-size) * 1.35);
    padding: 0;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-3);
    cursor: pointer;
  }

  .disclose:hover {
    color: var(--ink);
  }

  /* A live row's name in ink. One that needs the user, unread or asking,
     is a step stronger still, so what needs them reads at a glance. */
  .label.strong {
    color: var(--ink);
  }

  .note.asking {
    color: var(--accent);
  }

  .model {
    min-width: 0;
    padding-left: 8px;
    font-size: var(--label-size);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ink-3);
  }

  /* Past sessions are history until you open one, so they sit back from the
     live rows rather than competing with them. */
  .past {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 7px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--row-size);
    color: var(--ink-3);
    cursor: pointer;
    text-align: left;
    padding-right: var(--row-pad-x);
  }

  .past:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink-2);
  }

  .past:disabled {
    cursor: default;
  }

  /* The name starts where a session's does, past the dot's column. */
  .past .dot {
    margin-right: 3px;
  }

  .session.on {
    --row-bg: var(--accent-soft);
    background: var(--row-bg);
  }

  .session.on .label {
    color: var(--ink);
  }

  .label,
  .note {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* What the agent left for the row: a line under the name, in the same
     hand, quieter. */
  .note {
    font-size: var(--label-size);
    line-height: 1.35;
    color: var(--ink-3);
  }

  .state {
    font-size: 10px;
    color: var(--ink-3);
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state.told {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  /* Where a past session ran, when not in the project itself. */
  .tag.where {
    color: var(--accent);
    border-color: var(--accent-soft);
    max-width: 10ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag {
    flex: none;
    font-size: 9.5px;
    letter-spacing: var(--label-track-fine);
    color: var(--ink-3);
    border: 1px solid var(--rule);
    border-radius: var(--radius-tag);
    padding: 0 4px;
    line-height: 1.4;
  }

  .choice {
    margin: 2px 0 10px;
  }

  /* The account a project runs under, when it is not the agents' own. */
  .tag.account {
    color: var(--accent);
    border-color: var(--accent-soft);
    max-width: 10ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The account the choice starts under, switched for this one session:
     one segment per account, sharing the row's width. */
  .accounts {
    display: flex;
    margin: 2px var(--row-pad-x) 4px var(--row-indent);
    border: 1px solid var(--rule);
    border-radius: var(--radius-tag);
    overflow: hidden;
  }

  .accounts button {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    border: 0;
    border-right: 1px solid var(--rule);
    background: none;
    font-family: var(--chrome);
    font-size: 10.5px;
    letter-spacing: var(--label-track-fine);
    color: var(--ink-3);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .accounts button:hover {
    color: var(--ink-2);
  }

  .accounts button:last-child {
    border-right: 0;
  }

  .accounts button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .choice-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 2px var(--row-pad-x) 2px var(--row-indent);
    font-family: var(--chrome);
    font-size: var(--label-size);
    letter-spacing: 0.05em;
    color: var(--ink-3);
  }

  .cancel {
    padding: 0 5px;
    border: 1px solid var(--rule);
    border-radius: var(--radius-tag);
    background: none;
    font-family: var(--chrome);
    font-size: 9.5px;
    letter-spacing: var(--label-track-fine);
    color: var(--ink-3);
    cursor: pointer;
  }

  .cancel:hover {
    color: var(--ink-2);
  }

  .option {
    display: flex;
    align-items: baseline;
    gap: 7px;
    width: 100%;
    text-align: left;
    padding: 3px var(--row-pad-x) 3px var(--row-indent);
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--row-size);
    color: var(--ink-2);
    cursor: pointer;
  }

  .option:hover {
    color: var(--accent);
  }

  .mark {
    flex: none;
    color: var(--ink-3);
  }

  /* The dot says what is behind the row: green while a process runs, the
     dormant yellow for a row left from the last quit, the accent while it
     waits for you, and the quiet grey once it is done or ended. Only
     asking is a ring. */
  .dot {
    --done: color-mix(in srgb, var(--ink-3) 60%, transparent);
    width: var(--dot);
    height: var(--dot);
    flex: none;
    border: 1px solid var(--done);
    border-radius: 50%;
    background: var(--done);
  }

  .dot.live {
    background: var(--add);
    border-color: var(--add);
  }

  /* Open when the app last quit, and not started since: it starts when
     selected. */
  .dot.dormant {
    background: var(--dormant);
    border-color: var(--dormant);
  }

  /* At work: the dot breathes. Waiting for you: the accent, and the name
     stronger, until you look. */
  .dot.working {
    animation: breathe 1.2s ease-in-out infinite;
  }

  .dot.unread {
    background: var(--accent);
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .label.unread {
    color: var(--ink);
    font-weight: 500;
  }


  /* Asking: a hollow accent ring, whatever else the dot was. */
  .dot.permission {
    background: var(--clear-surface);
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
    animation: none;
  }

  @keyframes breathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot.working {
      animation: none;
    }

    .project,
    .session,
    .chev {
      transition: none;
    }
  }

  .icon {
    flex: none;
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 14px;
    line-height: 1;
    padding: 2px 8px;
    cursor: pointer;
    opacity: 0;
  }

  .session:hover .icon,
  .icon:focus-visible {
    opacity: 1;
  }

  .actions .icon {
    padding: 2px 5px;
  }

  .actions .icon:hover {
    color: var(--accent);
  }

  .fold {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    min-width: 0;
    margin: 0 0 4px;
    border: 0;
    background: none;
    font-family: var(--chrome);
    font-size: 11px;
    color: var(--ink-3);
    cursor: pointer;
    padding: 2px var(--row-pad-x) 2px var(--row-indent);
  }

  /* The rows that count what a project keeps out of sight, the tail of
     its quiet rows and its earlier sessions: the chevron in the names'
     column, in the quieter hand. */
  .fold.tail {
    margin: 0;
    padding: var(--row-pad-y) var(--row-pad-x) var(--row-pad-y)
      calc(var(--row-inset) + var(--row-pad-x) + var(--dot) + 10px);
    font-size: var(--fold-size);
  }

  .fold-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fold:hover {
    color: var(--ink-2);
  }

  /* The one glyph for a row that opens. */
  .chev {
    width: 14px;
    height: 14px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 150ms ease;
  }

  .chev.open {
    transform: rotate(90deg);
  }

  /* The earlier sessions open a dialog: a clock turning back, drawn a
     little smaller so it weighs what the chevron does. */
  .chev.history {
    width: 13px;
    height: 13px;
    margin: 0 0.5px;
    stroke-width: 1.4;
  }

  /* The sessions a session started hang under it, a line each, joined to
     its dot by a rail: down the dot's column, then across to each one's
     own dot. The first reaches up past its starter's second line to the
     dot itself. */
  .kids {
    --rail-x: calc(var(--row-pad-x) + var(--dot) / 2 - 0.5px);
    --rail-reach: calc(var(--row-pad-y) + var(--label-size) * 1.35 + 1px + var(--row-size) * 0.75 - var(--dot) / 2);
    margin-bottom: 3px;
  }

  .rail-in,
  .rail-on {
    position: absolute;
    left: var(--rail-x);
    width: 9px;
    border-left: 1px solid var(--rule-strong);
    pointer-events: none;
  }

  .rail-in {
    top: 0;
    height: 50%;
    border-bottom: 1px solid var(--rule-strong);
    border-bottom-left-radius: var(--radius-sm);
  }

  .kid.first .rail-in {
    top: calc(-1 * var(--rail-reach));
    height: calc(50% + var(--rail-reach));
  }

  .rail-on {
    top: 50%;
    bottom: 0;
  }

  /* Rows hang right under a session's subagents and carry on the rail
     theirs come down, across the gap below them. */
  .kids.after-subs .kid.first .rail-in {
    top: -1px;
    height: calc(50% + 1px);
  }

  /* A session's subagents hang under it on a rail of their own, a little
     smaller than the sessions it started; a started session's hang from
     its own dot, one step further in. */
  .subs {
    --rail-x: calc(var(--row-pad-x) + var(--dot) / 2 - 0.5px);
    --rail-reach: calc(var(--row-pad-y) + var(--label-size) * 1.35 + 1px + var(--row-size) * 0.75 - var(--dot) / 2);
    position: relative;
    margin-bottom: 1px;
  }

  .subs.deep {
    --rail-x: calc(var(--row-pad-x) + var(--dot) + 14px);
    --rail-reach: calc(3px + var(--fold-size) * 0.75 - var(--dot) / 2);
  }

  .sub.first .rail-in {
    top: calc(-1 * var(--rail-reach));
    height: calc(50% + var(--rail-reach));
  }

  /* The rail of the sessions their starter started goes on past a
     started session's subagents to the next of them. */
  .rail-pass {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(var(--row-inset) + var(--row-pad-x) + var(--dot) / 2 - 0.5px);
    border-left: 1px solid var(--rule-strong);
    pointer-events: none;
  }

  .sub-row {
    gap: 0;
    padding: 2px var(--row-pad-x) 2px calc(var(--rail-x) + 15px);
    font-size: calc(var(--fold-size) - 0.5px);
  }

  .sub-row .dot {
    width: calc(var(--dot) - 1px);
    height: calc(var(--dot) - 1px);
    margin-right: 8px;
  }

  .dot.bad {
    background: var(--del);
    border-color: var(--del);
  }

  .sub-glyph {
    flex: none;
    margin-right: 7px;
    color: var(--ink-3);
  }

  .sub-label {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-2);
  }

  .sub.over .sub-label {
    color: var(--ink-3);
  }

  .sub-note {
    flex: none;
    max-width: 12ch;
    margin-left: auto;
    padding-left: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--label-size);
    color: var(--ink-3);
  }

  .sub-note.asking {
    color: var(--accent);
  }

  .sub-note.bad {
    color: var(--del);
  }

  .sub-note + .when {
    margin-left: 0;
  }

  /* A subagent's row has no button of its own to give its time up to. */
  .session.sub:hover > .row .when {
    visibility: visible;
  }

  /* Folded to the narrow column, a session's subagents are a dot each,
     packed beside its rail to the column's edge, where their rows stand,
     and the rail runs straight past them to the sessions it started. */
  .sub-dots,
  .rail-through {
    display: none;
  }

  /* Never so far in that the column's fading edge takes the first. */
  .nav.folded .sub-dots {
    --dots-x: min(calc(var(--row-inset) + var(--rail-x) + 6px), calc(var(--folded) - 20px));
    position: absolute;
    top: 4px;
    left: var(--dots-x);
    width: max(var(--dot), calc(var(--folded) - 8px - var(--dots-x)));
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }

  .nav.folded .rail-through {
    display: block;
    position: absolute;
    top: calc(-1 * var(--rail-reach));
    bottom: 0;
    left: calc(var(--row-inset) + var(--rail-x));
    border-left: 1px solid var(--rule-strong);
    pointer-events: none;
  }

  .nav.folded .sub {
    visibility: hidden;
  }

  /* With no words beside them, the dots differ in shape as well as
     colour: running is filled, asking a ring with a halo, done a plain
     hollow ring, failed a cross. */
  .sub-dots .dot.over {
    background: none;
  }

  .sub-dots .dot.bad {
    position: relative;
    border-color: transparent;
    background: none;
  }

  .sub-dots .dot.bad::before,
  .sub-dots .dot.bad::after {
    content: "";
    position: absolute;
    top: -1.5px;
    bottom: -1.5px;
    left: 50%;
    width: 1.5px;
    margin-left: -0.75px;
    border-radius: 1px;
    background: var(--del);
    transform: rotate(45deg);
  }

  .sub-dots .dot.bad::after {
    transform: rotate(-45deg);
  }

  /* A started session on one line. */
  .kid-row {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 3px var(--row-pad-x) 3px calc(var(--rail-x) + 15px);
    font-size: var(--fold-size);
  }

  .kid-row .dot {
    margin-right: 8px;
  }

  /* The name, the account, the project and the model share one line that
     wraps what does not fit onto a second one out of sight, so what goes,
     goes whole: the project is cut down to a few letters first, then the
     model goes, then the project, then the account, and the name alone is
     cut last. */
  .kid-row .fit {
    flex: 1;
    min-width: 0;
    height: calc(var(--fold-size) * 1.5);
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    overflow: hidden;
  }

  .kid-row .label {
    flex: 0 1 auto;
  }

  .kid-row .where {
    flex: 1 1 4ch;
    max-width: max-content;
    min-width: 0;
    margin-left: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-3);
  }

  .kid-row .account {
    flex: none;
    max-width: 12ch;
    margin-left: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-3);
  }

  .kid-row .model {
    flex: none;
    margin-left: auto;
  }

  .kid-row .when,
  .model.asking,
  .model.role {
    flex: none;
  }

  .model.asking {
    color: var(--accent);
  }

  /* What a starter has not heard from the sessions it started: a step
     above the model it stands in for, with a small mark in the accent. It
     is the starter's to read, not yours to answer, so it stays quiet. */
  /* Beside the count, the line takes the room it needs first, and gives
     any up only once the count has none left. */
  .second .note.first-say {
    flex: 0 1 auto;
  }

  /* It takes only the room the line beside it leaves, and inside it what
     does not fit wraps onto a line out of sight, so what goes goes whole:
     the words first, then the dot and the count. */
  .news {
    flex: 1 1 0;
    min-width: 0;
    height: calc(var(--label-size) * 1.35);
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: baseline;
    overflow: hidden;
    white-space: pre;
    color: var(--ink-2);
  }

  /* Holds the line's baseline, and the line itself once the rest has gone. */
  .news-gap::before {
    content: "\200b";
  }

  .news-count {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 10px;
  }

  .news-count::before,
  .news-mark::before {
    content: "";
    flex: none;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }

  /* At the end of the started session's line, beside its time, and the
     first thing on it to go. */
  .news-mark {
    flex: none;
    align-self: center;
    display: flex;
    margin-left: auto;
    padding-left: 8px;
  }

  /* A starter folded: a small dot for each session it started. */
  .dot.mini {
    width: calc(var(--dot) - 2px);
    height: calc(var(--dot) - 2px);
  }

  /* The projects nobody has used for a while: one fold at the foot, behind
     a hairline, each project a single line with when it was last used. */
  .inactive {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--head-rule);
  }

  .inactive-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: calc(100% - 2 * var(--row-inset));
    margin: 0 var(--row-inset);
    padding: var(--row-pad-y) var(--row-pad-x);
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-family: var(--chrome);
    font-size: var(--row-size);
    text-align: left;
    color: var(--ink-2);
    cursor: pointer;
  }

  .inactive-head:hover {
    background: var(--surface-2);
  }

  .inactive-title {
    font-weight: var(--project-weight);
  }

  .inactive-count {
    color: var(--ink-3);
  }

  .idle {
    --row-bg: var(--pane-bg);
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 var(--row-inset);
    border-radius: var(--radius);
  }

  .idle:hover {
    --row-bg: var(--surface-2);
    background: var(--row-bg);
  }

  .idle:hover .actions,
  .idle .actions:focus-within {
    opacity: 1;
  }


  .idle-row {
    padding-left: var(--row-indent);
  }

  .idle-row .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .prefix {
    color: var(--ink-3);
    font-weight: normal;
  }

  .when {
    flex: none;
    min-width: 2.2em;
    margin-left: auto;
    padding-left: 10px;
    text-align: right;
    font-size: var(--label-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-3);
  }

  .idle-more {
    width: calc(100% - 2 * var(--row-inset));
    margin: 0 var(--row-inset);
    padding: var(--row-pad-y) var(--row-pad-x) var(--row-pad-y) var(--row-indent);
    font-size: var(--fold-size);
  }

  .open-first {
    margin: 0 var(--pane-pad);
    padding: 4px 9px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--accent-soft);
    font-family: var(--chrome);
    font-size: var(--btn-size);
    font-weight: var(--btn-weight);
    letter-spacing: var(--label-track-tight);
    text-transform: var(--label-case);
    color: var(--accent);
    cursor: pointer;
  }

  .open-first.cursor {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .nav:focus-within .open-first.cursor::before {
    content: none;
  }

  .empty p,
  .error {
    margin: 0;
    padding: 12px var(--pane-pad);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-3);
  }

  .error {
    color: var(--del);
  }

  .closing {
    flex: none;
    padding: 8px 10px 4px;
  }

  .closing.folded {
    visibility: hidden;
  }

  .error-row {
    display: flex;
    align-items: flex-start;
  }

  .error-row .error {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .dismiss {
    flex: none;
    margin: 10px var(--pane-pad) 0 0;
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 4px;
  }

  .dismiss:hover {
    color: var(--ink);
  }

  /* A session's name and its last line are the agent's or a caller's text:
     set apart, so nothing in them turns the row around. */
  .label,
  .note {
    unicode-bidi: isolate;
  }
</style>
