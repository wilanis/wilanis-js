/** The documents this plugin ships, by the paths a tree names them at: one alias root and the files under docs/. */

export const ROOT = '@otel';
/** The path of a document this plugin ships. */
export const doc = (name: string) => `${ROOT}/${name}`;

export const PORT = doc('exporter.port.json');
/** The operation a project's startup list names to send this tree's runs to a collector. */
export const EXPORT = `${PORT}#export`;

/** How much a span carries. `summary` never carries a value; `full` adds the report's redacted in/out. */
export const LEVELS = ['summary', 'full'] as const;
export type Level = (typeof LEVELS)[number];

/** Whether a word is one of the two levels a span may be exported at. */
export const isLevel = (value: unknown): value is Level => LEVELS.includes(value as Level);
