// The build of the driver tier's second plugin: it writes the script the
// manifest's `run` names, which is in no checkout until this has run. Node
// does the writing, so the build is the same on every platform the tier
// covers.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = `// @ts-nocheck
// Written by the build. A plugin as small as one can be: it greets, and it
// goes when the app asks it to or when its input ends.

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

send({ type: "hello", name: "driverbuilt", version: "0.4.0" });

let rest = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  rest += chunk;
  let at;
  while ((at = rest.indexOf("\\n")) !== -1) {
    const line = rest.slice(0, at).trim();
    rest = rest.slice(at + 1);
    if (line.includes('"stop"')) process.exit(0);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

writeFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "main.js"),
  plugin,
  "utf8",
);
