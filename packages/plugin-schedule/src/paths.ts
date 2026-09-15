/** The documents this plugin ships, by the paths a tree names them at: one alias root and the files under docs/. */

export const ROOT = '@schedule';
/** The path of a document this plugin ships. */
export const doc = (name: string) => `${ROOT}/${name}`;

export const PORT = doc('scheduler.port.json');
export const KIND = doc('schedule.trigger-kind.json');
/** The operation a project's startup list names to keep the schedule. */
export const RUN = `${PORT}#run`;
