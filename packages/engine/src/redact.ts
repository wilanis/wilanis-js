/**
 * Secrets never appear in a report: a redacted copy of a value replaces every marked path with a marker. Only
 * what is written into a report is redacted; the values the run hands from node to node, and the answer it
 * hands its caller, are the values themselves. A value made from a marked read carries the mark: text that
 * interpolates one is the marker whole, and an answer is the marker wherever it holds what its node read as one.
 */
import { type Reader, readPath } from './sources.js';
import type { Attempt, Report } from './spec.js';

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

/**
 * How a report reads its sources: each read over what the report of its source shows, and text that interpolates a
 * marked read as the marker whole, since the text holds the secret -- `Bearer {{token}}` is a credential.
 */
export function showingOf(values: Map<string, unknown>, shown: Map<string, unknown>): Reader {
  return {
    at: (ref, path) => shownRead(values.get(ref), shown.get(ref), path),
    text: joined => (joined.includes(SECRET) ? SECRET : joined),
  };
}

/**
 * What a node read as a secret: each value it was handed where its report shows the marker, and every part of
 * such a value. Read before the handler runs, so nothing the handler does to what it was handed changes it.
 */
export function readAsSecret(given: unknown, shown: unknown, into = new Set<unknown>()): Set<unknown> {
  if (given === shown || given === undefined) return into;
  if (shown === SECRET) return wholly(given, into);
  if (walked(given) && walked(shown))
    for (const [key, part] of Object.entries(given)) readAsSecret(part, (shown as Record<string, unknown>)[key], into);
  return into;
}

/** A secret and each of its parts, every one a value an answer may hand back. */
function wholly(value: unknown, into: Set<unknown>): Set<unknown> {
  if (value === undefined) return into;
  into.add(value);
  if (walked(value)) for (const part of Object.values(value)) wholly(part, into);
  return into;
}

/**
 * An answer as its report shows it, with the marker wherever the answer holds a value its node read as a secret:
 * what an operation hands back of what it read carries the mark, whatever type it answers under. Each object and
 * list on the way to such a marker is a copy; the rest of `shown` is shared.
 */
export function carried(value: unknown, shown: unknown, secrets: Set<unknown>): unknown {
  if (!secrets.size || shown === SECRET) return shown;
  if (value !== undefined && secrets.has(value)) return SECRET;
  if (!walked(value) || !walked(shown)) return shown;
  let copy: Record<string, unknown> | undefined;
  for (const [key, part] of Object.entries(value)) {
    const before = (shown as Record<string, unknown>)[key];
    const after = carried(part, before, secrets);
    if (after === before) continue;
    copy ??= copyOf(shown);
    copy[key] = after;
  }
  return copy ?? shown;
}

/** Whether a value is walked into: a list or a plain object, never an instance whose parts are its own business. */
function walked(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A shallow copy of a list or plain object, to write a marker into. */
const copyOf = (value: object): Record<string, unknown> =>
  (Array.isArray(value) ? [...value] : { ...value }) as Record<string, unknown>;

/**
 * `value` with every listed path replaced; a path of no segments redacts the whole value. Every object and list a
 * path walks through is a copy, where the path's last field is absent as much as where it is there, so nothing done
 * to the value later puts anything at a marked position; the rest is the value's own, shared.
 */
export function redactValue(value: unknown, paths: string[][] | undefined): unknown {
  if (!paths?.length || value === undefined) return value;
  let copy: unknown = value;
  for (const path of paths) {
    if (!path.length) return SECRET;
    copy = redactAt(copy, path);
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
 * with every mark below and the node's own; otherwise the answer redacted by the node's own paths. Either way the
 * answer carries the mark of what the node read as a secret.
 */
export function shownOut(
  sub: Report | undefined,
  out: unknown,
  paths: string[][] | undefined,
  secrets: Set<unknown>,
): unknown {
  return carried(out, sub?.status === 'done' ? sub.output : redactValue(out, paths), secrets);
}

/** A try that did not stand as the node's report records it: the nested run it ran, if any, redacted as above. */
export function redactAttempt(attempt: Attempt, paths: string[][] | undefined): Attempt {
  return attempt.sub ? { ...attempt, sub: redactReport(attempt.sub, paths) } : attempt;
}

/**
 * `value` with the value at `path` replaced where the path leads somewhere, each object and list on the way copied.
 * A path names fields only, a list adding no segment, so a list met on the way -- the value itself, for a list
 * result -- has the rest of the path walked in each of its elements; the last field is replaced only where an
 * object has it.
 */
function redactAt(value: unknown, path: string[]): unknown {
  if (Array.isArray(value)) return value.map(element => redactAt(element, path));
  if (value === null || typeof value !== 'object') return value;
  const record = { ...(value as Record<string, unknown>) };
  const [field, ...rest] = path;
  if (!(field in record)) return record;
  record[field] = rest.length ? redactAt(record[field], rest) : SECRET;
  return record;
}
