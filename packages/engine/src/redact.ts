/**
 * Secrets never appear in a report: a redacted copy of a value replaces every marked path with a marker. Only
 * what is written into a report is redacted; the values the run hands from node to node, and the answer it
 * hands its caller, are the values themselves.
 */
import { readPath } from './sources.js';
import type { Attempt, NodeReport, Report } from './spec.js';

const SECRET = '«secret»';

/**
 * A read as a report shows it: nothing where the value holds nothing there, the marker where the path walks into
 * a value its report shows as the marker -- a header of a map marked whole -- and else what the report shows.
 */
export function shownRead(value: unknown, shown: unknown, path: string[]): unknown {
  if (readPath(value, path) === undefined) return undefined;
  for (let depth = 0; depth < path.length; depth++) if (readPath(shown, path.slice(0, depth)) === SECRET) return SECRET;
  return readPath(shown, path);
}

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
 * A nested run as the report it hangs in shows it: its answer as the node that answered it shows it, redacted
 * again by the paths of the node that ran it, so a mark either one carries holds -- and the node that ran it
 * shows its own answer the same way.
 */
export function redactReport(report: Report, paths: string[][] | undefined): Report {
  const answered = report.answeredBy === undefined ? undefined : report.nodes[report.answeredBy];
  const shown = answered ? answered.out : report.output;
  if (shown === undefined) return report;
  return { ...report, output: redactValue(shown, paths) };
}

/**
 * What a node's report shows of its answer: the nested run hung on it, where one answered for it, already shows it
 * with every mark below and the node's own; otherwise the answer redacted by the node's own paths.
 */
export function shownOut(report: NodeReport, out: unknown, paths: string[][] | undefined): unknown {
  return report.sub?.status === 'done' ? report.sub.output : redactValue(out, paths);
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
