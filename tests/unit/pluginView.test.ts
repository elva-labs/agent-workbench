import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginViewDataEvent,
  PluginViewEvent,
  PluginViewMessageRequest,
} from "$lib/core";
import { clear, deselect, files, showMedia } from "$lib/files.svelte";
import { layout } from "$lib/layout.svelte";
import {
  dataArrived,
  open,
  pluginViews,
  resetPluginViews,
  send,
  viewChanged,
  viewOf,
} from "$lib/pluginView.svelte";
import { reset as resetWorkspace, workspace } from "$lib/workspace.svelte";

const sent: PluginViewMessageRequest[] = [];
let refuse: string | null = null;
vi.mock("$lib/core", () => ({
  core: () => ({
    async pluginViewMessage(request: PluginViewMessageRequest) {
      sent.push(request);
      if (refuse !== null) throw new Error(refuse);
    },
  }),
}));

const event = (extra: Partial<PluginViewEvent> = {}): PluginViewEvent => ({
  source: "src-1",
  plugin: "github",
  project: "/one",
  width: "wide",
  html: "<h1>The branch</h1>",
  open: false,
  ...extra,
});

const data = (
  extra: Partial<PluginViewDataEvent> = {},
): PluginViewDataEvent => ({
  source: "src-1",
  plugin: "github",
  project: "/one",
  data: { checks: 2 },
  ...extra,
});

beforeEach(() => {
  clear();
  resetWorkspace();
  resetPluginViews();
  sent.length = 0;
  refuse = null;
  layout.mode = "working";
  workspace.active = "/one";
});

describe("a plugin's page", () => {
  it("keeps the latest the plugin sent, per project", () => {
    viewChanged(event());
    viewChanged(event({ project: "/two", html: "<h1>Two</h1>" }));
    viewChanged(event({ html: "<h1>Again</h1>" }));
    expect(pluginViews.pages).toHaveLength(2);
    expect(viewOf("src-1/github")?.html).toBe("<h1>Again</h1>");
    workspace.active = "/two";
    expect(viewOf("src-1/github")?.html).toBe("<h1>Two</h1>");
  });

  it("has nothing for a plugin that sent no page", () => {
    viewChanged(event());
    expect(viewOf("src-1/graph")).toBeNull();
  });

  it("shows one when it is asked for, and the viewer opens on it", () => {
    viewChanged(event());
    expect(files.pluginView).toBeNull();
    open("src-1/github", "/one");
    expect(files.pluginView?.html).toBe("<h1>The branch</h1>");
    expect(files.pluginView?.width).toBe("wide");
    expect(layout.mode).toBe("reviewing");
  });

  it("opens by itself when the plugin asks, for the project on screen", () => {
    viewChanged(event({ project: "/two", open: true }));
    expect(files.pluginView).toBeNull();
    viewChanged(event({ open: true }));
    expect(files.pluginView?.project).toBe("/one");
  });

  it("hands the open page the newer one the plugin sends", () => {
    viewChanged(event({ open: true }));
    viewChanged(event({ html: "<h1>Newer</h1>" }));
    expect(files.pluginView?.html).toBe("<h1>Newer</h1>");
  });

  it("goes when the plugin sends no page, and takes the viewer with it", () => {
    viewChanged(event({ open: true }));
    viewChanged(event({ html: "" }));
    expect(pluginViews.pages).toHaveLength(0);
    expect(files.pluginView).toBeNull();
    expect(layout.mode).toBe("working");
  });

  it("goes without closing a viewer that is on something else", () => {
    viewChanged(event());
    showMedia({
      id: "m1",
      owner: "session-1",
      project: "/one",
      files: ["/one/shot.png"],
      caption: null,
      at: 0,
    });
    viewChanged(event({ html: "" }));
    expect(pluginViews.pages).toHaveLength(0);
    expect(files.media).not.toBeNull();
    expect(layout.mode).toBe("reviewing");
  });

  it("lets the viewer go to what the agent presents, and back", () => {
    viewChanged(event({ open: true }));
    showMedia({
      id: "m1",
      owner: "session-1",
      project: "/one",
      files: ["/one/shot.png"],
      caption: null,
      at: 0,
    });
    expect(files.pluginView).toBeNull();
    open("src-1/github", "/one");
    expect(files.media).toBeNull();
    deselect();
    expect(files.pluginView).toBeNull();
  });
});

describe("what crosses the bridge", () => {
  it("sends a message to the plugin the page belongs to", async () => {
    viewChanged(event());
    await send("src-1/github", "/one", { hello: 1 });
    expect(sent).toEqual([
      {
        source: "src-1",
        plugin: "github",
        project: "/one",
        payload: { hello: 1 },
      },
    ]);
  });

  it("drops a message for a page that is gone", async () => {
    await send("src-1/github", "/one", { hello: 1 });
    expect(sent).toHaveLength(0);
  });

  it("keeps what the plugin refused to itself", async () => {
    viewChanged(event());
    refuse = "the plugin is not running";
    await expect(send("src-1/github", "/one", {})).resolves.toBeUndefined();
  });

  it("hands the plugin's data to the page that is open", () => {
    viewChanged(event({ open: true }));
    dataArrived(data());
    expect(pluginViews.data).toMatchObject({
      key: "src-1/github",
      project: "/one",
      data: { checks: 2 },
    });
  });

  it("counts each message, so the same data twice arrives twice", () => {
    viewChanged(event({ open: true }));
    dataArrived(data());
    const first = pluginViews.data!.seq;
    dataArrived(data());
    expect(pluginViews.data!.seq).toBeGreaterThan(first);
  });

  it("drops data for a page that is not the open one", () => {
    viewChanged(event({ open: true }));
    dataArrived(data({ project: "/two" }));
    dataArrived(data({ plugin: "graph" }));
    expect(pluginViews.data).toBeNull();
  });

  it("drops data when no page is open at all", () => {
    viewChanged(event());
    dataArrived(data());
    expect(pluginViews.data).toBeNull();
  });
});
