/**
 * Secrets never appear in a report: a redacted copy of a value replaces every marked path with a marker. Only
 * what is written into a report is redacted; the values the run hands from node to node, and the answer it
 * hands its caller, are the values themselves.
 */
import type { Attempt, Report } from './spec.js';

const SECRET = '«secret»';

/** A copy of `value` with every listed path replaced; a path of no segments redacts the whole value. */
export function redactValue(value: unknown, paths: string[][] | undefined): unknown {
  if (!paths?.length || value === undefined) return value;
  const copy: unknown = JSON.parse(JSON.stringify(value));
  for (const path of paths) {
    if (!path.length) return SECRET;
    redactAt(copy, path);
  }
  return copy;
}

/** Each element of a list redacted on its own: what a map's report shows of its answer. */
export function redactEach(items: unknown[], paths: string[][] | undefined): unknown[] {
  return paths?.length ? items.map(item => redactValue(item, paths)) : items;
}

/**
 * A nested run as the report it hangs in shows it: its answer redacted by the paths of the node that ran it,
 * which are the ones that node's own `out` is redacted by, so the two say the answer alike.
 */
export function redactReport(report: Report, paths: string[][] | undefined): Report {
  if (report.output === undefined || !paths?.length) return report;
  return { ...report, output: redactValue(report.output, paths) };
}

/** A try that did not stand as the node's report records it: the nested run it ran, if any, redacted as above. */
export function redactAttempt(attempt: Attempt, paths: string[][] | undefined): Attempt {
  return attempt.sub ? { ...attempt, sub: redactReport(attempt.sub, paths) } : attempt;
}

/**
 * Replace the value at `path` inside `value` in place, where the path leads somewhere. A path names fields
 * only, a list adding no segment, so a list met on the way -- the value itself, for a list result -- has the
 * rest of the path walked in each of its elements; the last field is replaced only where an object has it.
 */
function redactAt(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    for (const element of value) redactAt(element, path);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const [field, ...rest] = path;
  if (!(field in record)) return;
  if (rest.length) redactAt(record[field], rest);
  else record[field] = SECRET;
}
