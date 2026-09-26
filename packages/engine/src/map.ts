/**
 * A map node: its handler once per element of a list, at most `concurrency` at once (absent: every element at
 * once), taken in index order from one cursor, the node settling only when every element has, so a failed map
 * still says what each element did. A list longer than `limit` fails the node before any element starts. Once
 * an element has broken under `fail`, or the run has ended, no further element starts: it is `cancelled`. The run
 * decides when the map starts and what its answer is taken for; this module runs the elements and says what came
 * of each.
 */
import { redactEach, redactValue, shownOut, shownRead } from './redact.js';
import { initialReport, noteRefusal } from './report.js';
import { type Reader, readAll, readPath, readSource } from './sources.js';
import type { KMap, NodeReport } from './spec.js';
import { Refusal } from './spec.js';

/** What one element of a map came to: its value, or the error (and the reason, when it refused). */
type ElementResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; reason?: string; detail?: Record<string, unknown>; cancelled?: true };

/** What a map needs of the run it is in: the values it reads and what reports show of them, its clock, whether it has ended, and how one element's handler is called. */
export interface MapHost {
  readonly values: Map<string, unknown>;
  /** How a report reads a source: over what earlier reports show. */
  readonly showing: Reader;
  readonly clock: () => number;
  /** Whether the run has ended (broken or cancelled), so no further element may start. */
  ended(): boolean;
  /** Call the map's handler for one element, at the path under the map, with that element's report as its doors. */
  call(node: KMap, path: string[], inputs: Record<string, unknown>, report: NodeReport): Promise<unknown>;
}

/** A running map: what every element shares, the cursor its workers take the next index from, and whether an element broke under `fail`. */
interface MapSite {
  id: string;
  node: KMap;
  broadcast: Record<string, unknown>;
  over: unknown[];
  /** The shared inputs and the list as the reports of their sources show them, which an element's report reads. */
  shown: { broadcast: Record<string, unknown>; over: unknown[] };
  items: NodeReport[];
  results: ElementResult[];
  cursor: number;
  broken: boolean;
}

/** What one element's handler takes: the broadcast inputs, and the element under `item` or through `bind`. */
function elementInputs(node: KMap, broadcast: Record<string, unknown>, item: unknown): Record<string, unknown> {
  const inputs: Record<string, unknown> = { ...broadcast };
  if (!node.bind) {
    inputs.item = item;
    return inputs;
  }
  for (const [key, path] of Object.entries(node.bind)) {
    const value = readPath(item, path);
    if (value !== undefined) inputs[key] = value;
  }
  return inputs;
}

/**
 * What a map's own report shows it was given: the shared inputs, redacted as the operation marks them, and the
 * list, each element redacted as the operation marks what it is handed of it.
 */
function shownIn(node: KMap, broadcast: Record<string, unknown>, over: unknown[]): Record<string, unknown> {
  const shared = redactValue(broadcast, node.redact?.in) as Record<string, unknown>;
  return { ...shared, over: redactValue(over, elementPaths(node)) };
}

/**
 * The secret paths inside one element of `over`, read back through how the element reaches the operation:
 * whole as `item`, or a field of it through `bind`. A field the operation is not handed, it marks nothing of.
 */
function elementPaths(node: KMap): string[][] {
  const handed: [string, string[]][] = node.bind ? Object.entries(node.bind) : [['item', []]];
  const paths = node.redact?.in ?? [];
  return handed.flatMap(([input, at]) =>
    paths.filter(path => path[0] === input).map(path => [...at, ...path.slice(1)]),
  );
}

/**
 * What a map's report shows of its answer: each element as its own report shows it, under its `value` where
 * failures are collected, and redacted by the map's paths again -- a seeded element's report shows it as given.
 */
export function shownAnswer(node: KMap, answer: unknown[], items: NodeReport[]): unknown[] {
  const paths = node.redact?.out;
  if (node.onItemFailure !== 'collect')
    return redactEach(
      items.map(item => item.out),
      paths,
    );
  const shown = answer.map((result, index) =>
    (result as ElementResult).ok ? { ...(result as object), value: items[index].out } : result,
  );
  return redactEach(
    shown,
    paths?.map(path => ['value', ...path]),
  );
}

/**
 * A map's answer: every element's outcome when failures are collected; else the values, unless an element failed.
 * An element that never started leaves the answer undecided, whichever way failures are taken: the node fails.
 */
function collectMap(id: string, node: KMap, results: ElementResult[]): unknown[] {
  const collect = node.onItemFailure === 'collect';
  const index = results.findIndex(result => !result.ok && (!collect || result.cancelled));
  if (index < 0) return collect ? results : results.map(result => (result as { value: unknown }).value);
  const failed = results[index] as Extract<ElementResult, { ok: false }>;
  // an element that refused refuses the map, with its reason; an element that broke is a fault of the map
  if (failed.reason !== undefined) throw new Refusal(failed.reason, failed.error, failed.detail);
  throw new Error(`map '${id}' element ${index}: ${failed.error}`);
}

/** What a map answers: every element run, its report under `items`; throws as the node's failure when one failed under `fail`. */
export async function runMap(host: MapHost, id: string, node: KMap, report: NodeReport): Promise<unknown[]> {
  const over = readSource(node.over, host.values);
  if (!Array.isArray(over)) throw new Error(`map '${id}': over is not a list`);
  const broadcast = readAll(node.in, host.values);
  // each element as the list's report shows it: the marker, where the list is shown as the marker whole
  const shownOver = readSource(node.over, host.showing);
  const shown = {
    broadcast: readAll(node.in, host.showing),
    over: over.map((_, at) => shownRead(over, shownOver, [String(at)])),
  };
  report.in = shownIn(node, shown.broadcast, shown.over);
  if (node.limit !== undefined && over.length > node.limit)
    throw new Error(`map '${id}': ${over.length} elements, limit ${node.limit}`);
  // one report per element; an element supplied in initial as '<id>.<index>' is seeded and never runs
  const items = over.map((_, index) => initialReport(host.values, `${id}.${index}`));
  report.items = items;
  const site: MapSite = { id, node, broadcast, over, shown, items, results: [], cursor: 0, broken: false };
  // every element settles before the node does, whatever happened to the others
  const workers = Math.min(node.concurrency ?? over.length, over.length);
  await Promise.all(Array.from({ length: workers }, () => work(host, site)));
  return collectMap(id, node, site.results);
}

/**
 * One worker of a map: take the next index from the cursor and run that element, until none is left. An element
 * reached once the map's answer is decided (an element broke under `fail`) or the run has ended never starts.
 */
async function work(host: MapHost, site: MapSite): Promise<void> {
  while (site.cursor < site.over.length) {
    const index = site.cursor++;
    const element = site.items[index];
    if (element.status === 'pending' && (site.broken || host.ended())) element.status = 'cancelled';
    const result = await runElement(host, site, index);
    site.results[index] = result;
    if (!result.ok && site.node.onItemFailure === 'fail') site.broken = true;
  }
}

/** One element of a map: a seeded element answers at once, a cancelled one never runs; the rest run the handler with the element bound in. */
async function runElement(host: MapHost, site: MapSite, index: number): Promise<ElementResult> {
  const element = site.items[index];
  if (element.status === 'seeded') return { ok: true, value: element.out };
  if (element.status === 'cancelled') return { ok: false, error: 'cancelled', cancelled: true };
  const inputs = elementInputs(site.node, site.broadcast, site.over[index]);
  element.status = 'running';
  element.startedAt = host.clock();
  element.handler = site.node.handler;
  const shownInputs = elementInputs(site.node, site.shown.broadcast, site.shown.over[index]);
  element.in = redactValue(shownInputs, site.node.redact?.in) as Record<string, unknown>;
  try {
    const value = await host.call(site.node, [site.id, String(index)], inputs, element);
    element.out = shownOut(element, value, site.node.redact?.out);
    element.status = 'done';
    return { ok: true, value };
  } catch (error) {
    element.status = 'failed';
    element.error = (error as Error).message;
    noteRefusal(element, error);
    return { ok: false, error: element.error, reason: element.reason, detail: element.detail };
  } finally {
    element.endedAt = host.clock();
  }
}
