<script lang="ts">
  import { historyDue, readQuietNext } from "$lib/projects.svelte";
  import { onMount, tick, untrack } from "svelte";
  import { cubicOut } from "svelte/easing";
  import Splitter from "$lib/components/Splitter.svelte";
  import Junction from "$lib/components/Junction.svelte";
  import SessionsPane from "$lib/panes/SessionsPane.svelte";
  import AgentPane from "$lib/panes/AgentPane.svelte";
  import ChangesPane from "$lib/panes/ChangesPane.svelte";
  import TerminalPanel from "$lib/panes/TerminalPanel.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import Remote from "$lib/components/Remote.svelte";
  import { closeRemote, remote } from "$lib/remote.svelte";
  import Resume from "$lib/components/Resume.svelte";
  import { closeResume, resume } from "$lib/resume.svelte";
  import Palette from "$lib/components/Palette.svelte";
  import { closePalette, openCommands, openGoTo, palette } from "$lib/palette.svelte";
  import ConductAsk from "$lib/components/ConductAsk.svelte";
  import LeaveAsk from "$lib/components/LeaveAsk.svelte";
  import RefusalBanner from "$lib/components/RefusalBanner.svelte";
  import SettingsAsk from "$lib/components/SettingsAsk.svelte";
  import UserStyles from "$lib/components/UserStyles.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import {
    cancelled as conductCancelled,
    conductor,
    handle as conductRequested,
  } from "$lib/conductor.svelte";
  import { handle as browserRequested } from "$lib/browserTools.svelte";
  import { handle as settingsRequested, settingsAsk } from "$lib/settingsTools.svelte";
  import { folderToRead, load as loadOrchestratorFolder } from "$lib/orchestratorFolder.svelte";
  import { core } from "$lib/core";
  import { ensure as ensureHooks } from "$lib/hook.svelte";
  import { diffRequested, notified, showRequested, switched, terminalRequested } from "$lib/show.svelte";
  import { watchSelection } from "$lib/selection.svelte";
  import { watchViewed } from "$lib/viewed.svelte";
  import { sessionShown, unfoldSessions } from "$lib/viewers.svelte";
  import { newFile, newUntitled } from "$lib/fileOps.svelte";
  import { askFind } from "$lib/find.svelte";
  import {
    activeTab,
    canSaveInFront,
    closeTabInFront,
    findInFile,
    flipMode,
    focusFiles,
    followOwner,
    loadEditorSize,
    otherKindShown,
    putAwayOther,
    save,
    toggleRight,
    walkView,
    zoomEditor,
  } from "$lib/editor.svelte";
  import { watchProcesses } from "$lib/processes.svelte";
  import {
    stateChanged as pluginStateChanged,
    watchPluginProjects,
    watchPluginUpdates,
  } from "$lib/plugins.svelte";
  import ActionInput from "$lib/components/ActionInput.svelte";
  import { cancelAction, noticed as pluginNoticed, pluginSections, sectionChanged } from "$lib/pluginSections.svelte";
  import { dataArrived as pluginViewData, viewChanged as pluginViewChanged } from "$lib/pluginView.svelte";
  import { loadMedia, presented } from "$lib/media.svelte";
  import {
    activeTab as browserTab,
    browser,
    close as closeBrowserTab,
    initBrowser,
    syncOwner,
  } from "$lib/browser.svelte";
  import { loadNotices } from "$lib/notice.svelte";
  import { loadZoom, zoomed } from "$lib/zoom.svelte";
  import { handle as handleDrag } from "$lib/drops.svelte";
  import { stash } from "$lib/exits";
  import {
    closeAlso,
    closeLabel,
    closeTarget,
    resolveAction,
    type Action,
    type CloseState,
  } from "$lib/keymap";
  import { leaveAsked, watchRunning } from "$lib/leaving.svelte";
  import { keys } from "$lib/keys.svelte";
  import { say } from "$lib/flash.svelte";
  import { closeSettings, openSettings, settings } from "$lib/settings.svelte";
  import { cycleTheme, theme } from "$lib/theme.svelte";
  import {
    closeViewer,
    files,
    listed,
    requestField,
    select,
    toggleScope,
    toggleView,
  } from "$lib/files.svelte";
  import {
    activeSession,
    cycle as cycleSession,
    ended as sessionEnded,
    exact,
    followCwd,
    followHistory,
    refreshHistory,
    identified,
    nextNeedingYou,
    onWaiting,
    sessions,
    unreadCount,
    viewed,
  } from "$lib/sessions.svelte";
  import { attention, badge, followFocus } from "$lib/attention.svelte";
  import { askForSession, followLimits, lookAtWork } from "$lib/limitsPoll";
  import { primeChime } from "$lib/chime";
  import { announce } from "$lib/notify.svelte";
  import { PANE_MOTION, reduced } from "$lib/motion";
  import {
    activeShell,
    closeAsking as closeShell,
    create as createShell,
    cycle as cycleShell,
    ended as shellEnded,
    followOwner as followShells,
    ownerOnScreen as shellOwner,
    terminals,
  } from "$lib/terminals.svelte";
  import { goTo, hookedProjects, settleFolder, workspace } from "$lib/workspace.svelte";
  import {
    CONTROLS_INSET,
    DEFAULT,
    defaultChanges,
    minChanges,
    folded,
    MIN,
    MIN_REVIEW,
    agentVisible,
    applyLayout,
    browserFocused,
    changesSpan,
    changesVisible,
    changesWidth,
    editTreeVisible,
    enterReview,
    exitReview,
    focusPane,
    layout,
    peekSessions,
    peekable,
    questionHoldsKeyboard,
    resetEditAgent,
    returnFocus,
    resizeEditAgent,
    saveLayout,
    sessionsOpen,
    sessionsShown,
    sessionsVisible,
    sliding,
    terminalOpen,
    terminalVisible,
    togglePane,
    toggleTerminal,
  } from "$lib/layout.svelte";

  let viewport = $state(1200);
  let stack = $state(800);

  // What the agent presented before this window opened, back on the lists,
  // and which words to the user were already taken.
  loadMedia();
  loadNotices();
  loadZoom();
  loadEditorSize();

  // What is on screen, on record for the agent's tools and for the core
  // to watch where it is, and what runs under the sessions, for the
  // section under the tree.
  watchSelection();
  watchViewed();
  // Each session's tabs in the editor, and its shells in the terminal
  // panel, swapped in as the session on screen changes.
  followOwner();
  followShells();
  watchProcesses();
  // Whether sessions run, for the core to ask before the window goes.
  watchRunning();
  watchPluginUpdates();
  // Which projects are open, told to the core of each machine they are on,
  // so the plugins running there know them.
  watchPluginProjects();

  // Every project opened after the start is brought to the hooks answer,
  // once; the ones the window opened with are asked about together. The
  // orchestrator folder is one more while it is listed.
  $effect(() => {
    for (const path of hookedProjects()) ensureHooks(path);
  });

  // Every pty ends through one event, agent or shell. Whichever store has the
  // row takes it; an exit that beat its own spawn result waits to be claimed.
  onMount(() => {
    const offs: (() => void)[] = [];
    void initBrowser();
    core()
      .onSessionEnded((event) => {
        if (!sessionEnded(event) && !shellEnded(event)) stash(event);
      })
      .then((unlisten) => offs.push(unlisten));
    core()
      .onSessionIdentified((event) => identified(event.ptyId, event.sessionId, event.title))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onSessionEvent((event) =>
        exact(event.sessionId, event.kind, event.note ?? null, event.cut === true, {
          error: event.error ?? null,
          background: Array.isArray(event.background) ? event.background : [],
        }),
      )
      .then((unlisten) => offs.push(unlisten));
    core()
      .onShowRequest((request) => void showRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPresentRequest((request) => presented(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onDiffRequest((request) => void diffRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onTerminalRequest((request) => terminalRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onNotifyRequest((request) => notified(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onConductRequest((request) => void conductRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onConductCancel((request) => conductCancelled(request.id))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onBrowserRequest((request) => void browserRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onSettingsRequest((request) => void settingsRequested(request))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onBrowserFocused(() => browserFocused())
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPluginState((event) => pluginStateChanged(event))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPluginSection((event) => sectionChanged(event))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPluginNotice((event) => pluginNoticed(event))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPluginView((event) => pluginViewChanged(event))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onPluginViewData((event) => pluginViewData(event))
      .then((unlisten) => offs.push(unlisten));
    core()
      .onFileDrag(handleDrag)
      .then((unlisten) => offs.push(unlisten));
    core()
      .onOpenSettings(async () => {
        // The palette gives the keyboard back before the settings take it.
        if (palette.open) {
          closePalette();
          await tick();
        }
        openSettings();
      })
      .then((unlisten) => offs.push(unlisten));
    core()
      .onFullScreen((fullScreen) => (layout.fullScreen = fullScreen))
      .then((unlisten) => offs.push(unlisten));
    // The core held back the window's close or the app's quit while
    // sessions run or the editor has unsaved edits: the question goes over
    // the whole window.
    core()
      .onLeaveRequested((ask) => leaveAsked(ask))
      .then((unlisten) => offs.push(unlisten));
    // The File menu's items do what their actions do.
    core()
      .onMenuAction((action) => menuAction(action))
      .then((unlisten) => offs.push(unlisten));
    // A connection going away takes every pty on it: each ends the way a
    // killed one does, and the pane says why.
    core()
      .onRemoteClosed((closed) => {
        const prefix = `ssh://${closed.host}#`;
        for (const session of sessions.all) {
          if (session.ptyId?.startsWith(prefix)) {
            sessionEnded({ id: session.ptyId, code: null, clean: false });
          }
        }
        for (const shell of terminals.all) {
          if (shell.ptyId?.startsWith(prefix)) {
            shellEnded({ id: shell.ptyId, code: null, clean: false });
          }
        }
        workspace.error = `${closed.host}: ${closed.reason}`;
      })
      .then((unlisten) => offs.push(unlisten));
    void loadOrchestratorFolder().then(settleFolder);
    offs.push(followCwd());
    offs.push(
      followHistory(() => {
        const dir = folderToRead();
        const open = workspace.open.map((project) => project.path);
        const due = untrack(() => historyDue(open, workspace.active));
        return dir === null ? due : [...due, dir];
      }),
    );
    offs.push(followFocus());
    offs.push(followLimits());
    offs.push(primeChime());
    onWaiting(announce);
    offs.push(() => onWaiting(null));
    return () => offs.forEach((off) => off());
  });

  // A session that comes on screen while the window is in use asks for its
  // account's figures, which its machine reads where they are old or
  // missing.
  $effect(() => {
    const key = sessions.active;
    if (key !== null) untrack(() => void askForSession(key));
  });

  // A session at work, until it stops, may move its account's figures,
  // which its machine then reads sooner.
  $effect(() => {
    for (const session of sessions.all) void session.working;
    untrack(() => lookAtWork(sessions.all));
  });

  // Looking at a session is what reads it: the one on screen, in a window
  // that has focus. Either changing is a look.
  $effect(() => {
    const key = sessions.active;
    if (attention.focused && key !== null) viewed(key);
  });

  // Switching to a session puts its viewer back as it was left, then opens
  // what its agent asked to show while the user was looking at another,
  // outside the effect's own reads: either may move the viewer and the
  // project. Before the DOM updates, so the viewer of the session left is
  // recorded before the changes pane clears its tree for the new root.
  $effect.pre(() => {
    const key = sessions.active;
    untrack(() => {
      // Picked from the peeked pane, or started there: the pane goes back.
      peekSessions(false);
      void sessionShown(key).then(() => {
        if (key !== null) switched(key);
      });
    });
  });

  // The browser shows the tabs of the session on screen, or of the project
  // on screen with no session selected: the core is told whenever that
  // changes.
  $effect(() => {
    sessions.active;
    workspace.active;
    sessions.all.length;
    void syncOwner();
  });

  // The platform's own window controls sit on the middle of the sessions
  // pane's header row, open or folded, and a look sets how tall that header
  // is: measured once the look has painted, and again whenever it changes.
  $effect(() => {
    theme.look;
    const frame = requestAnimationFrame(() => {
      const header = document.querySelector("section[data-pane] header");
      if (header === null) return;
      const box = header.getBoundingClientRect();
      void core().controlsCentre(Math.round(box.top + box.height / 2));
    });
    return () => cancelAnimationFrame(frame);
  });

  // Coming back to the window is when what happened elsewhere is wanted:
  // the histories are read again.
  $effect(() => {
    if (!attention.focused) return;
    readQuietNext();
    refreshHistory();
  });

  $effect(() => {
    badge(unreadCount());
  });

  // The native layer takes a chord back from a browser tab's page on the
  // app's behalf, so it needs the table again whenever a binding changes.
  // Save is editor mode's: outside it a browser tab's page keeps it, and on
  // macOS it reaches the File menu as it would from anywhere else. Close is
  // taken back always, the chord with Shift off macOS included: it closes
  // the tab, as in any browser.
  $effect(() => {
    const chords = Object.entries(keys.bindings)
      .filter(([action]) => editing || action !== "file.save")
      .map(([, chord]) => chord);
    const also = closeAlso();
    void core().browserKeys(also === null ? chords : [...chords, also]);
  });

  // The File menu's items that cannot act are greyed out: Save without a
  // file in front to save, the new files and New Shell without a project.
  // Close can always act: with nothing smaller in front it is the window's.
  $effect(() => {
    void core()
      .menuEnabled({
        "file.new": workspace.active !== null,
        "file.untitled": workspace.active !== null,
        "terminal.new": workspace.active !== null,
        "file.save": editing && canSaveInFront(),
        "file.close": true,
      })
      .catch(() => {});
  });

  // Close in the File menu names what it would close.
  let closeName = $derived(closeLabel(closeTarget(closeState(false))));
  $effect(() => {
    void core()
      .menuText({ "file.close": closeName })
      .catch(() => {});
  });

  // The File menu's items show and answer the chords of their actions.
  $effect(() => {
    void core()
      .menuKeys({ ...keys.bindings })
      .catch(() => {});
  });

  let reviewing = $derived(layout.mode === "reviewing");
  let editing = $derived(layout.mode === "editing");

  // Until the window has drawn a couple of frames the sessions column is
  // simply where it belongs: the saved layout and the window's width both
  // arrive then, and neither is a toggle to watch.
  let settled = false;
  $effect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => (settled = true));
    });
    return () => cancelAnimationFrame(frame);
  });

  /** How long the columns take to reach new widths: the whole motion for a
      toggle or a change of shape, nothing for a window too narrow for a pane
      or a splitter being dragged. */
  function easing(moved: boolean) {
    return settled && moved && !reduced() ? PANE_MOTION : 0;
  }

  /** Whether a change of shape is a flip between agent and editor mode,
      which puts the panes in another order: no column eases into it, and
      the layout lands in one step. */
  function flipped(was: string, now: string) {
    return was !== now && (was === "editing" || now === "editing");
  }

  // The sessions column eases between folded and open when the pane is
  // toggled or the shape changes, and the panes beside it take and give back
  // the room as it goes. The pane keeps its own width the whole way and the
  // column cuts it off, so no row moves.
  let sessionsWasChosen = untrack(() => layout.sessionsChosen);
  let sessionsWasMode = untrack(() => layout.mode);
  $effect.pre(() => {
    const shown = sessionsVisible();
    const chosen = layout.sessionsChosen;
    const mode = layout.mode;
    untrack(() => {
      const moved =
        chosen !== sessionsWasChosen ||
        (mode !== sessionsWasMode && !flipped(sessionsWasMode, mode));
      sessionsWasChosen = chosen;
      sessionsWasMode = mode;
      void sessionsOpen.set(shown ? 1 : 0, { duration: easing(moved), easing: cubicOut });
    });
  });

  // The changes column eases between its working and reviewing widths on the
  // same curve as the sessions column, so the agent between them moves
  // steadily from its old width to its new one and never below either. A
  // flip, onto the viewer included, lands in one step.
  let changesWasMode = untrack(() => layout.mode);
  $effect.pre(() => {
    const width = changesWidth();
    const mode = layout.mode;
    untrack(() => {
      const moved = mode !== changesWasMode && !flipped(changesWasMode, mode);
      changesWasMode = mode;
      void changesSpan.set(width, { duration: easing(moved), easing: cubicOut });
    });
  });

  /** How wide the peeked pane is drawn: its own width, and while editing at
      least as wide as the folded column and the tree's, so no sliver of the
      tree stands beside it. */
  let peekWidth = $derived(
    editing && editTreeVisible()
      ? `max(${layout.sessions}px, calc(${folded() + layout.editTreeDrawn}px + var(--splitter-w) + var(--splitter-inner-w)))`
      : `${layout.sessions}px`,
  );

  /** The sessions column's width, folded or open or on its way, the splitter
      beside it included. */
  let sessionsColumn = $derived(
    `calc(${folded() + (layout.sessions - folded()) * sessionsOpen.current}px + var(--splitter-w))`,
  );

  // The terminal panel eases up and down, and the panes above it give up
  // and take back the height as it goes. The shells in it are never
  // unmounted, so it is out of the layout only once it is all the way down.
  let terminalWasShown = untrack(() => terminalVisible());
  $effect.pre(() => {
    const shown = terminalVisible();
    untrack(() => {
      const moved = shown !== terminalWasShown;
      terminalWasShown = shown;
      void terminalOpen.set(shown ? 1 : 0, { duration: easing(moved), easing: cubicOut });
    });
  });

  let columns = $derived.by(() => {
    const cols: string[] = [];
    // The sessions pane and the splitter beside it share one column, folded
    // or open, and move together as it eases between the two.
    cols.push(sessionsColumn);
    // Editing: the files pane takes the middle and the agent the right, at
    // a width of its own.
    if (editing) {
      cols.push("1fr");
      if (agentVisible()) cols.push("var(--splitter-w)", `${layout.editAgentDrawn}px`);
      return cols.join(" ");
    }
    if (agentVisible()) cols.push("1fr");
    if (changesVisible()) {
      if (agentVisible()) cols.push("var(--splitter-w)");
      // With the agent hidden the viewer is the only pane, so it takes the room
      // rather than holding a fixed width against empty space.
      cols.push(
        agentVisible() ? `${changesSpan.current}px` : "1fr",
      );
    }
    return cols.join(" ");
  });

  function resizeSessions(dx: number) {
    layout.sessions = Math.max(MIN.sessions, layout.sessions + dx);
    applyLayout(viewport);
  }

  function resizeChanges(dx: number) {
    if (reviewing) {
      layout.review = Math.max(MIN_REVIEW, layout.review - dx);
      layout.reviewTouched = true;
    } else {
      layout.changes = Math.max(minChanges(), layout.changes - dx);
      layout.changesDragged = true;
    }
    applyLayout(viewport);
  }

  function resetChanges() {
    if (reviewing) {
      layout.review = DEFAULT.review;
      layout.reviewTouched = true;
    } else {
      layout.changes = defaultChanges();
      layout.changesDragged = false;
    }
    applyLayout(viewport);
    saveLayout();
  }

  // The bar sits above the panel, so dragging it down makes the panel shorter.
  function resizeTerminal(dy: number) {
    layout.terminal = Math.max(MIN.terminal, layout.terminal - dy);
    applyLayout(viewport, stack);
  }

  function resetTerminal() {
    layout.terminal = DEFAULT.terminal;
    applyLayout(viewport, stack);
    saveLayout();
  }

  function resetSessions() {
    layout.sessions = DEFAULT.sessions;
    applyLayout(viewport);
    saveLayout();
  }

  /** The dividers between panes that meet the one over the terminal
      panel, each with what a move across and a reset do to it. */
  let meetings = $derived.by(() => {
    const out: { side: string; across: (dx: number) => void; reset: () => void }[] = [];
    if (sessionsVisible()) out.push({ side: "sessions", across: resizeSessions, reset: resetSessions });
    if (changesVisible() && agentVisible()) {
      if (editing) out.push({ side: "agent", across: resizeEditAgent, reset: resetEditAgent });
      else out.push({ side: "changes", across: resizeChanges, reset: resetChanges });
    }
    return out;
  });

  /** What moves the meeting points: the columns, the panel's height and
      the window. */
  let meetingKey = $derived(`${columns}|${layout.terminal}|${viewport}|${stack}|${theme.look}`);

  /** Whether a modal dialog other than the palette is on screen: the
      settings, the remote and resume lists, an action's input, or a prompt
      for the user's say. */
  function dialogUp(): boolean {
    return (
      settings.open ||
      remote.open ||
      resume.open ||
      pluginSections.pending !== null ||
      conductor.asking !== null ||
      settingsAsk.asking !== null
    );
  }

  /** Whether a dialog, or a question in a strip, holds the keyboard where
      a chord that moves it may not take it from. */
  function keyboardHeld(): boolean {
    return dialogUp() || questionHoldsKeyboard();
  }

  /** What close would act on now. */
  function closeState(question: boolean): CloseState {
    return {
      palette: palette.open,
      dialog: settings.open || remote.open || resume.open || pluginSections.pending !== null,
      question,
      focus: layout.focus,
      editing,
      reviewing,
      shell: activeShell() !== null,
      tab: activeTab() !== null,
      other: editing && otherKindShown(),
      browserTab: browser.showing && browserTab() !== null,
    };
  }

  /** Closes what is in front: by the chord, from the File menu, or from
      the palette. */
  async function closeInFront() {
    switch (closeTarget(closeState(questionHoldsKeyboard()))) {
      case "nothing":
        break;
      case "palette":
        closePalette();
        break;
      case "dialog":
        if (settings.open) closeSettings();
        else if (remote.open) closeRemote();
        else if (resume.open) closeResume();
        else cancelAction();
        break;
      case "shell":
        // Closed at once, the keyboard goes to the shell in front next, or
        // where the panel hands it once the last has gone; asked, it stays
        // with the question.
        if (terminals.active !== null && (await closeShell(terminals.active))) returnFocus();
        break;
      case "browserTab": {
        const tab = browserTab();
        if (tab !== null) await closeBrowserTab(tab.id).catch(() => {});
        break;
      }
      case "other": {
        // The keyboard goes back to the editor when it was in what went.
        const inside = layout.focus === "changes";
        putAwayOther();
        if (inside) focusFiles("editor");
        break;
      }
      case "tab":
        closeTabInFront();
        break;
      case "viewer":
        closeViewer();
        break;
      case "window":
        // The core asks first while sessions run or edits are unsaved.
        void core().windowControl("close").catch(() => {});
        break;
    }
  }

  /** A new shell beside the session on screen, or the project's own with
      none, the panel opened for it, with the keyboard in it. */
  function newShell() {
    const owner = shellOwner();
    if (owner === null) {
      say("Open a project to start a shell in");
      return;
    }
    if (layout.terminalForced) {
      say("The window is too short for the terminal");
      return;
    }
    // Made before the panel opens, so opening it starts no second one.
    createShell(owner);
    if (!terminalVisible()) toggleTerminal();
    focusPane("terminal");
  }

  /** The keyboard to the status bar's first control, where it has one. */
  function focusStatus() {
    const bar = document.querySelector<HTMLElement>("[data-testid='status-bar']");
    const first = bar?.querySelector<HTMLElement>("button:not(:disabled)") ?? null;
    if (first === null) {
      say("Nothing to change in the status bar");
      return;
    }
    first.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    const action = resolveAction(e, {
      focus: layout.focus,
      reviewing,
      editing,
      inEditor: editing && editorHasKeyboard(),
      integrated: activeSession()?.kind === "integrated",
    });
    if (!action) return;
    // Opening the palette and the jump move the keyboard, so with a dialog up
    // they do nothing and the webview gets nothing from them either. The
    // chord still puts an open palette away.
    if (
      (action.type === "attention" ||
        ((action.type === "palette" || action.type === "goto") && !palette.open)) &&
      dialogUp()
    ) {
      e.preventDefault();
      return;
    }
    // A new shell, a new untitled file and the chord to the status bar move
    // the keyboard too, and do nothing while a question in a strip holds it
    // either.
    if (
      (action.type === "newShell" || action.type === "newUntitled" || action.type === "focusStatus") &&
      keyboardHeld()
    ) {
      e.preventDefault();
      return;
    }
    // The palette holds the keyboard while it is up: only its own chords,
    // which put it away or switch its list, and close, which puts it away,
    // get past it. The others are swallowed so the native menu does not
    // act on them.
    if (palette.open && action.type !== "palette" && action.type !== "goto" && action.type !== "close") {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    perform(action);
  }

  /** Does what a bound action does, from its chord or from the palette. */
  function perform(action: Action) {
    switch (action.type) {
      case "focus":
        // Going to the sessions pane opens it out of its fold. While
        // reviewing, and while editing in a window that folds it, it peeks
        // over the pane beside it instead, and the chord again puts it back.
        if (action.pane === "sessions" && peekable()) {
          if (layout.sessionsPeek) {
            peekSessions(false);
            break;
          }
          peekSessions(true);
        } else if (action.pane === "sessions") unfoldSessions();
        // The files pane while editing holds the tree and the editor: the
        // chord goes to the editor, and from the editor to the tree.
        if (action.pane === "changes" && editing) {
          focusFiles(editorHasKeyboard() ? "tree" : "editor");
          break;
        }
        focusPane(action.pane);
        break;
      case "toggle":
        if (action.pane === "changes") toggleRight();
        else if (editing && layout.sessionsForced) {
          // A window that folds the pane for the editor has nothing to open
          // it into: the chord peeks it, and puts it back.
          peekSessions(!layout.sessionsPeek);
          if (layout.sessionsPeek) focusPane("sessions");
        } else if (!sessionsVisible()) unfoldSessions();
        else togglePane(action.pane);
        break;
      case "toggleMode":
        flipMode();
        break;
      case "save":
        if (editing) void save();
        break;
      case "close":
        void closeInFront();
        break;
      case "newShell":
        newShell();
        break;
      case "focusStatus":
        focusStatus();
        break;
      case "newFile":
        newFile();
        break;
      case "newUntitled":
        newUntitled();
        break;
      case "findInFile":
        findInFile();
        break;
      case "findInThread":
        askFind();
        break;
      case "toEditor":
        // Escape from the panes around the editor: what took its place is
        // put away, and the keyboard goes back to it.
        if (otherKindShown()) putAwayOther();
        focusFiles("editor");
        break;
      case "cycleTheme":
        cycleTheme();
        break;
      case "toggleReview":
        if (editing) break;
        if (reviewing) closeViewer();
        else {
          // Opening the viewer with nothing chosen shows the first file rather
          // than an empty pane; with nothing listed, the empty pane is honest.
          if (files.selected === null) {
            const first = listed()[0];
            if (first !== undefined) select(first.path);
          }
          enterReview();
        }
        break;
      case "toggleView":
        if (editing) walkView();
        else toggleView();
        break;
      case "toggleScope":
        toggleScope();
        break;
      case "toggleTerminal":
        toggleTerminal();
        break;
      case "openSettings":
        openSettings();
        break;
      case "find":
        // The field lives in the changes pane, so the pane comes out if it
        // was closed, and takes focus.
        if (!changesVisible()) togglePane("changes");
        focusPane("changes");
        requestField(action.mode);
        break;
      case "cycle":
        // Shells when the keyboard is in the panel, sessions anywhere else,
        // and the keyboard lands in what was switched to.
        if (workspace.active === null) break;
        if (layout.focus === "terminal") cycleShell(action.direction);
        else if (cycleSession(workspace.active, action.direction)) focusPane("agent");
        break;
      case "exitReview":
        closeViewer();
        break;
      case "attention":
        nextSession();
        break;
      case "zoom":
        zoomTerminal(action.step);
        break;
      case "goto":
        if (palette.open && palette.mode === "goto") closePalette();
        else openGoTo();
        break;
      case "palette":
        if (palette.open && palette.mode !== "goto") closePalette();
        else openCommands();
        break;
      default:
        action satisfies never;
    }
  }

  /** An item of the File menu: what its action does. */
  function menuAction(action: string) {
    if (action === "file.new") newFile();
    else if (action === "file.untitled" && !palette.open && !keyboardHeld()) newUntitled();
    else if (action === "terminal.new" && !palette.open && !keyboardHeld()) newShell();
    else if (action === "file.save" && editing) void save();
    else if (action === "file.close") void closeInFront();
  }

  /** Whether the keyboard is in the editor, its find panel included. */
  function editorHasKeyboard(): boolean {
    return document.activeElement?.closest(".cm-editor") != null;
  }

  /** The next session waiting on the user, brought forward with the
      keyboard in it. */
  function nextSession() {
    const next = nextNeedingYou();
    if (next === null) {
      say("Nothing else needs you");
      return;
    }
    goTo(next.key);
    focusPane("agent");
  }

  /** Zooms the terminal the keyboard belongs to: the panel's shell when the
      panel has it, the agent on screen otherwise. */
  function zoomTerminal(step: 1 | -1 | 0) {
    if (editing && editorHasKeyboard()) {
      zoomEditor(step);
      return;
    }
    if (layout.focus === "terminal" && terminals.active !== null) {
      say(`${zoomed(terminals.active, null, step)} px`);
      return;
    }
    const session = activeSession();
    if (session === null) return;
    say(`${zoomed(session.key, session.id, step)} px`);
  }

  // Clamp against the grid's own content box rather than the window: the frame
  // has padding, and counting it as usable width is how the agent pane ends up
  // below its minimum on a small display. The height is the stack's, which
  // the panes and the terminal divide between them.
  $effect(() => {
    const width = viewport;
    const height = stack;
    untrack(() => applyLayout(width, height));
  });
</script>

<svelte:window on:keydown={onKeydown} />

<div
  class="frame"
  style:--controls-inset="{CONTROLS_INSET}px"
  style:--sessions-col={sessionsColumn}
  style:--folded="{folded()}px"
>
  <div class="stack" bind:clientHeight={stack}>
  <main
    class="shell"
    style:grid-template-columns={columns}
    data-testid="shell"
    data-mode={layout.mode}
    bind:clientWidth={viewport}
  >
    <!-- The pane and its splitter in one slot, as wide as the column. What
         the pane holds keeps the pane's open width, so a column narrower
         than that cuts it off at the right and no row moves. Folded, the
         splitter gives way to a plain edge: there is nothing to drag. -->
    <div
      class="sessions-slot"
      class:folded={!sessionsShown()}
      class:peeking={layout.sessionsPeek}
      style:--sessions-w="{layout.sessions}px"
      style:--peek-w={peekWidth}
    >
      <SessionsPane />
      {#if sessionsVisible()}
        <Splitter
          label="Resize projects and sessions"
          name="sessions"
          onDelta={resizeSessions}
          onReset={resetSessions}
          onCommit={saveLayout}
        />
      {:else}
        <div class="fold-edge" aria-hidden="true" data-tauri-drag-region></div>
      {/if}
    </div>

    <!-- Hidden rather than unmounted, always. Unmounting would destroy the
         terminal; hiding leaves the pane at its width, so the PTY is never
         resized and the agent comes back exactly as it was. While editing
         the same slot is placed last, on the right. -->
    <div class="agent-slot" class:hidden={!agentVisible()} class:right={editing}>
      <AgentPane />
    </div>

    {#if changesVisible()}
      {#if agentVisible() && !editing}
        <Splitter
          label={reviewing ? "Resize the viewer" : "Resize changes"}
          name="changes"
          onDelta={resizeChanges}
          onReset={resetChanges}
          onCommit={saveLayout}
        />
      {/if}
      <ChangesPane />
      {#if agentVisible() && editing}
        <Splitter
          label="Resize the agent"
          name="agent"
          onDelta={resizeEditAgent}
          onReset={resetEditAgent}
          onCommit={saveLayout}
        />
      {/if}
    {/if}
  </main>

  <!-- The status bar is drawn along the window's foot, and comes before
       the terminal panel in the page so that Tab reaches its controls
       before the panel's: the panel ends in a shell, which keeps Tab. -->
  <StatusBar />

  <!-- Hidden rather than unmounted, for the same reason as the agent: the
       shells in it stay mounted, so hiding is free and showing is a fit. The
       panel and the bar above it go and come back together, in a group as
       tall as the share of them that is up; the panel keeps its own height
       inside, so it slides rather than squeezes. -->
  <div
    class="terminal-group"
    class:hidden={!terminalVisible() && terminalOpen.current === 0}
    class:sliding={terminalOpen.current !== 1}
    style:height="calc({layout.terminal * terminalOpen.current}px + var(--splitter-w) * {terminalOpen.current})"
  >
    {#if terminalVisible() || terminalOpen.current > 0}
      <Splitter
        label="Resize the terminal"
        orientation="horizontal"
        name="terminal"
        onDelta={resizeTerminal}
        onReset={resetTerminal}
        onCommit={saveLayout}
      />
    {/if}
    <div class="terminal-slot" style:height="{layout.terminal}px" data-testid="terminal-slot">
      <TerminalPanel />
    </div>
  </div>
  </div>
</div>

<!-- Where a divider between two panes meets the one over the terminal
     panel, the pointer drags both. -->
{#if terminalVisible() && terminalOpen.current === 1 && !layout.sessionsPeek}
  {#each meetings as meeting (meeting.side)}
    <Junction
      side={meeting.side}
      foot="terminal"
      at={meetingKey}
      onDelta={(dx, dy) => {
        meeting.across(dx);
        resizeTerminal(dy);
      }}
      onReset={() => {
        meeting.reset();
        resetTerminal();
      }}
      onCommit={saveLayout}
    />
  {/each}
{/if}

{#if settings.open}
  <Settings />
{/if}
{#if remote.open}
  <Remote />
{/if}
{#if resume.open}
  <Resume />
{/if}
{#if palette.open || palette.leaving}
  <Palette {perform} />
{/if}
{#if pluginSections.pending !== null}
  <ActionInput />
{/if}
{#if conductor.asking !== null}
  <ConductAsk />
{/if}
<SettingsAsk />
<LeaveAsk />
<RefusalBanner />
<UserStyles />

<style>
  /* The window's ground, with the look's padding around the panes: in the
     terminal look wide enough that a box's sharp corner stays clear of the
     window's rounded one on macOS, in the modern look none before the
     sessions pane and the header row, which lie on the ground. */
  .frame {
    height: calc(100vh - 26px);
    padding: var(--frame-pad-top) var(--frame-pad) var(--frame-pad) var(--frame-pad-left);
    background: var(--ground);
  }

  /* The ground carries a background: the terminal look's between its
     boxes, the modern look's under the headers, the sessions pane and the
     status bar alike. */
  :global(:root[data-background]:not([data-look])) .frame {
    background: linear-gradient(var(--tint-frame), var(--tint-frame)), var(--tint-backdrop);
  }

  :global(:root[data-background][data-look="modern"]) .frame {
    background: linear-gradient(var(--tint-side), var(--tint-side)), var(--tint-backdrop);
  }

  .stack {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  /* No padding here: clientWidth is then exactly the width the panes divide up. */
  .shell {
    display: grid;
    gap: 0;
    flex: 1;
    min-height: 0;
    align-items: stretch;
  }

  /* The bar and the panel, one thing to show and to hide, cut off at the
     window's foot while they are on their way. The panel can stand in from
     the left, clear of the window's edge where the sessions pane lies on
     the ground above it. */
  .terminal-group {
    display: flex;
    flex-direction: column;
    flex: none;
    margin-left: var(--panel-inset);
  }

  .terminal-group.sliding {
    overflow: hidden;
  }

  .terminal-group.hidden {
    display: none;
  }

  .terminal-slot {
    display: flex;
    flex: none;
    min-height: 0;
  }

  .terminal-slot :global(.pane) {
    flex: 1;
    min-width: 0;
  }

  /* The pane and the splitter beside it, in the width of one column. */
  .sessions-slot {
    display: flex;
    min-width: 0;
    min-height: 0;
  }

  .sessions-slot :global(.pane) {
    flex: 1;
    min-width: 0;
  }

  /* Peeked: the pane takes its open width over the agent beside it, and
     the column, the splitter and everything else stay where they are. */
  .sessions-slot.peeking {
    position: relative;
    z-index: 4;
  }

  .sessions-slot.peeking :global(.pane) {
    flex: none;
    width: var(--peek-w);
    box-shadow: 12px 0 28px rgba(0, 0, 0, 0.3);
  }

  @media (prefers-reduced-motion: no-preference) {
    .sessions-slot.peeking :global(.pane) {
      animation: sessions-peek 160ms cubic-bezier(0.22, 0.61, 0.36, 1);
    }
  }

  @keyframes -global-sessions-peek {
    from {
      width: var(--folded);
    }
  }

  /* What the pane holds keeps the open width, and the pane cuts it off
     without ever scrolling to what is past the cut. */
  .sessions-slot :global([data-pane="sessions"] > .body) {
    overflow: clip;
  }

  .sessions-slot :global([data-pane="sessions"] > .body > :not([data-testid="unfold-sessions"])) {
    min-width: calc(var(--sessions-w) - 2 * var(--pane-edge));
  }

  /* Folded, the header row is ground with nothing in it but, where the
     app draws them, the menu button. */
  .sessions-slot.folded :global([data-pane="sessions"] > header > :not(.app-menu)) {
    visibility: hidden;
  }

  /* In the modern look the folded column's header row is the ground's own,
     with no rule under it: the window's buttons stand on it. */
  :global(:root[data-look="modern"]) .sessions-slot.folded :global([data-pane="sessions"] > header) {
    border-bottom-color: transparent;
  }

  .sessions-slot.folded :global([data-pane="sessions"] > header > .app-menu) {
    margin-left: calc((var(--folded) - 2 * var(--pane-edge) - 40px) / 2);
  }

  /* Beside the folded column there is nothing to drag: the gap stays, as
     ground, and the window drags by it as by the headers. */
  .fold-edge {
    flex: none;
    width: var(--splitter-w);
  }

  .agent-slot {
    display: flex;
    min-width: 0;
    min-height: 0;
  }

  .agent-slot.hidden {
    display: none;
  }

  .agent-slot.right {
    order: 1;
  }

  .agent-slot :global(.pane) {
    flex: 1;
    min-width: 0;
  }
</style>
