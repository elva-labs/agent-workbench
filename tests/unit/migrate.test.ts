import { describe, expect, it } from "vitest";
import { migrateStorage } from "$lib/migrate";

const ON_CHORD = async () => "/home/ada/.chord/orchestrator";
const ON_OLD = async () => "/home/ada/.agent-workbench/orchestrator";

function storedUnder(prefix: string): string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith(prefix));
}

describe("the window's storage under the earlier name", () => {
  it("moves each key to Chord's name, with paths into the moved folder", async () => {
    localStorage.clear();
    localStorage.setItem("workbench.layout", '{"sessions":240}');
    localStorage.setItem(
      "workbench.open",
      JSON.stringify(["/home/ada/dev/demo", "/home/ada/.agent-workbench/orchestrator", "ssh://ada@lab/home/ada/.agent-workbench/orchestrator"]),
    );
    localStorage.setItem("workbench.orchestratorFolder", "C:\\Users\\ada\\.agent-workbench\\orchestrator");
    localStorage.setItem("workbench.tokens", '{"s1":"token-1"}');
    localStorage.setItem("workbench.theme", "dark");
    localStorage.setItem("workbench.other", "/home/ada/.agent-workbench-old/x");
    localStorage.setItem("chord.theme", "light");
    localStorage.setItem("other", "kept");

    await migrateStorage(localStorage, ON_CHORD);

    expect(localStorage.getItem("chord.layout")).toBe('{"sessions":240}');
    expect(JSON.parse(localStorage.getItem("chord.open")!)).toEqual([
      "/home/ada/dev/demo",
      "/home/ada/.chord/orchestrator",
      "ssh://ada@lab/home/ada/.chord/orchestrator",
    ]);
    expect(localStorage.getItem("chord.orchestratorFolder")).toBe("C:\\Users\\ada\\.chord\\orchestrator");
    expect(localStorage.getItem("chord.tokens")).toBe('{"s1":"token-1"}');
    expect(localStorage.getItem("chord.theme")).toBe("light");
    expect(localStorage.getItem("chord.other")).toBe("/home/ada/.agent-workbench-old/x");
    expect(localStorage.getItem("other")).toBe("kept");
    expect(storedUnder("workbench.")).toEqual([]);

    const after = { ...localStorage };
    let asked = false;
    await migrateStorage(localStorage, async () => {
      asked = true;
      return "/home/ada/.chord/orchestrator";
    });
    expect({ ...localStorage }).toEqual(after);
    expect(asked).toBe(false);
  });

  it("keeps the old folder's paths and keys while the core is on that folder", async () => {
    localStorage.clear();
    const open = JSON.stringify(["/home/ada/.agent-workbench/orchestrator"]);
    localStorage.setItem("workbench.open", open);
    localStorage.setItem("workbench.theme", "dark");

    await migrateStorage(localStorage, ON_OLD);
    expect(localStorage.getItem("chord.open")).toBe(open);
    expect(localStorage.getItem("chord.theme")).toBe("dark");
    expect(storedUnder("workbench.").sort()).toEqual(["workbench.open", "workbench.theme"]);

    // That run's own writes say the old folder too.
    localStorage.setItem("chord.orchestratorFolder", "/home/ada/.agent-workbench/orchestrator");
    await migrateStorage(localStorage, ON_OLD);
    expect(localStorage.getItem("chord.orchestratorFolder")).toBe("/home/ada/.agent-workbench/orchestrator");

    await migrateStorage(localStorage, ON_CHORD);
    expect(JSON.parse(localStorage.getItem("chord.open")!)).toEqual(["/home/ada/.chord/orchestrator"]);
    expect(localStorage.getItem("chord.orchestratorFolder")).toBe("/home/ada/.chord/orchestrator");
    expect(storedUnder("workbench.")).toEqual([]);
  });

  it("keeps the old keys when the core cannot say where it is", async () => {
    localStorage.clear();
    localStorage.setItem("workbench.theme", "dark");
    await migrateStorage(localStorage, async () => {
      throw new Error("no core");
    });
    expect(localStorage.getItem("chord.theme")).toBe("dark");
    expect(localStorage.getItem("workbench.theme")).toBe("dark");
  });
});
