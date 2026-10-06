/**
 * What the plugin is configured with, as `plugin.json` describes it. Both settings are engine-wide knobs, as
 * postgres has them; the URL and the pool are facts about one database and live on its connection.
 */

/** The plugin's own settings, from `project.json → plugins[].settings`. */
export interface Settings {
  /** Seconds a read may run before the server stops it; MySQL applies the limit to reads alone. */
  statementTimeout?: number;
  keyType?: 'uuidv7' | 'identity';
}

/** Whether `newKey` answers one past the highest for a number key, rather than a uuidv7 for a string one. */
export const isIdentity = (settings: Settings): boolean => settings.keyType === 'identity';

/** The read deadline these settings ask for, in whole milliseconds, or nothing where they ask for none. */
export function timeoutMsOf(settings: Settings): number | undefined {
  const given = settings.statementTimeout;
  return typeof given === 'number' && Number.isFinite(given) && given > 0 ? Math.round(given * 1000) : undefined;
}
