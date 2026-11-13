const DEFAULT = 1420;

/**
 * The dev server's port and whether WORKBENCH_DEV_PORT chose it. Unset or
 * empty is the default port. Anything that is not a whole number a second
 * checkout can listen on, with room for the HMR port after it, is an error
 * rather than a quiet fall back to the default.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ port: number, custom: boolean }}
 */
export function devPort(env = process.env) {
  const raw = env.WORKBENCH_DEV_PORT;
  if (raw === undefined || raw === "") return { port: DEFAULT, custom: false };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65534)
    throw new Error(
      `WORKBENCH_DEV_PORT must be a whole number from 1024 to 65534, got "${raw}"`,
    );
  return { port, custom: true };
}
