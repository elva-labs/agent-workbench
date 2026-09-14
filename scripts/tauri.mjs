// The Tauri CLI, with the development configuration laid over the app's
// own when the command is dev: a development build wears an icon of its
// own, on the accent, so it is told from the installed app in the dock.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dev = args[0] === "dev" && !args.includes("--config");
const merged = dev ? [...args, "--config", "src-tauri/tauri.dev.conf.json"] : args;
const result = spawnSync("tauri", merged, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
