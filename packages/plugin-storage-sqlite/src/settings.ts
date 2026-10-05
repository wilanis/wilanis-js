/**
 * What the plugin is configured with, as `plugin.json` describes it, and the one default it has to pick.
 *
 * `busyTimeoutMs` defaults to 5000, which is the figure RFC 0022 wrote beside the setting and the default
 * better-sqlite3 itself opens a database with: long enough that a writer waiting on a short transaction
 * elsewhere gets its turn, short enough that a lock nobody is going to release fails the node while the
 * person who caused it is still looking. The wait blocks the process, because the driver is synchronous, so
 * a longer default would be a longer freeze rather than a more patient writer.
 */

/** The plugin's own settings, from `project.json → plugins[].settings`. */
export interface Settings {
  keyType?: 'uuidv7' | 'identity';
  busyTimeoutMs?: number;
}

/** How long a writer waits for the file's lock when the plugin says nothing. */
export const BUSY_TIMEOUT_MS = 5000;

/** How long a writer waits for the file's lock under these settings, in whole milliseconds. */
export function busyTimeoutOf(settings: Settings): number {
  const given = settings.busyTimeoutMs;
  return typeof given === 'number' && Number.isFinite(given) && given >= 0 ? Math.round(given) : BUSY_TIMEOUT_MS;
}

/** Whether `newKey` answers one past the highest for a number key, rather than a uuidv7 for a string one. */
export const isIdentity = (settings: Settings): boolean => settings.keyType === 'identity';
