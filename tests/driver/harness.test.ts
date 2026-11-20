import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  end,
  endUnder,
  freePorts,
  processesUnder,
  waitForDriver,
  waitForHeartbeat,
} from "./harness";

/**
 * The harness's own footing, with no app: how it waits for a driver to be
 * there before asking it for a session, and how it makes sure the app it
 * started is the one the tool calls of its run reach.
 */

/** A process standing in for tauri-driver, which ends after `ms` or not
    at all. */
function bridge(ms?: number): ChildProcess {
  const script =
    ms === undefined
      ? "setInterval(() => {}, 1000)"
      : `setTimeout(() => process.exit(3), ${ms})`;
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

let children: ChildProcess[] = [];
let servers: Server[] = [];
let homes: string[] = [];

afterEach(async () => {
  await Promise.all(children.map(end));
  await Promise.all(
    servers.map((server) => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    }),
  );
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  children = [];
  servers = [];
  homes = [];
});

describe("the driver harness", () => {
  it("asks for no session until the driver behind the bridge answers", async () => {
    // The bridge drops the connection while the driver behind it is not
    // listening yet, which is what tauri-driver does.
    let asked = 0;
    const server = createServer((request, response) => {
      asked += 1;
      if (asked <= 3) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"value":{"ready":true}}');
    });
    servers.push(server);
    await new Promise<void>((done) =>
      server.listen(0, "127.0.0.1", () => done()),
    );
    const { port } = server.address() as AddressInfo;
    const running = bridge();
    children.push(running);

    await waitForDriver(running, port, 15_000);
    expect(asked).toBe(4);
  });

  it("says at once that the bridge ended, rather than waiting it out", async () => {
    const [port] = await freePorts(1);
    const ending = bridge(300);
    children.push(ending);
    const started = Date.now();

    await expect(waitForDriver(ending, port, 15_000)).rejects.toThrow(
      `tauri-driver on ${port} ended before its driver answered, with code 3`,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("ends a bridge and waits until it has gone", async () => {
    const running = bridge();
    children.push(running);
    await end(running);
    expect(running.exitCode !== null || running.signalCode !== null).toBe(true);
  });

  it("finds the app's heartbeat in the run's own home", async () => {
    const home = mkdtempSync(join(tmpdir(), "workbench-harness-"));
    homes.push(home);
    const waiting = waitForHeartbeat(home, 10_000);
    mkdirSync(join(home, ".chord"));
    writeFileSync(join(home, ".chord", "answering"), "0.0.0");
    await expect(waiting).resolves.toBeUndefined();
  });

  it("names the home an app writes no heartbeat in", async () => {
    const home = mkdtempSync(join(tmpdir(), "workbench-harness-"));
    homes.push(home);
    await expect(waitForHeartbeat(home, 500)).rejects.toThrow(
      `the app wrote no heartbeat at ${join(home, ".chord", "answering")}`,
    );
  });

  it.skipIf(process.platform !== "linux")(
    "ends what still runs under a launch's home, and nothing else",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "workbench-harness-"));
      const elsewhere = mkdtempSync(join(tmpdir(), "workbench-harness-"));
      homes.push(home, elsewhere);
      // Stand-ins for what an app leaves behind: one that ignores a polite
      // end, started apart from this process the way an orphan is.
      const started = (at: string) =>
        new Promise<ChildProcess>((done) => {
          const child = spawn(
            process.execPath,
            [
              "-e",
              'process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 1000)',
            ],
            {
              env: { ...process.env, HOME: at },
              detached: true,
              stdio: ["ignore", "pipe", "ignore"],
            },
          );
          child.stdout!.once("data", () => {
            child.stdout!.destroy();
            child.unref();
            done(child);
          });
        });
      const stubborn = await started(home);
      const other = await started(elsewhere);
      children.push(other);
      expect(processesUnder(home)).toEqual([stubborn.pid]);

      await endUnder(home);

      expect(processesUnder(home)).toEqual([]);
      expect(processesUnder(elsewhere)).toEqual([other.pid]);
      process.kill(other.pid!, "SIGKILL");
    },
    20_000,
  );

  it("hands out ports that differ", async () => {
    const ports = await freePorts(3);
    expect(new Set(ports).size).toBe(3);
  });
});
