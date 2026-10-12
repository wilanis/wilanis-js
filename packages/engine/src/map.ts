/**
 * A map node: its handler once per element of a list, at most `concurrency` at once (absent: every element at
 * once), taken in index order from one cursor, the node settling only when every element has, so a failed map
 * still says what each element did. A list longer than `limit` fails the node before any element starts. Once
 * an element has broken under `fail`, or the run has ended, no further element starts: it is `cancelled`. A map
 * with a `where` tries its rule as each element starts: an element it does not hold for is dropped, never runs,
 * and is left out of the answer; with no handler, a kept element answers itself. The run decides when the map
 * starts and what its answer is taken for; this module runs the elements and says what came of each.
 */
import { carried, readAsSecret, redactEach, redactValue, shownOut, shownRead } from './redact.js';
import { initialReport, noteRefusal } from './report.js';
import { type Reader, readAll, readPath, readSource } from './sources.js';
import type { KMap, NodeReport } from './spec.js';
import { Refusal } from './spec.js';

/** What one element of a map that ran came to: its value, or the error (and the reason, when it refused). */
type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string; reason?: string; detail?: Record<string, unknown>; cancelled?: true };

/** What one element came to: an outcome, or dropped by the map's `where`, which is neither an answer nor a failure. */
type ElementResult = Outcome | { dropped: true };

/** A map that runs an operation for each kept element. */
type Calling = KMap & { handler: string };

/** Whether a map runs an operation, rather than answering each kept element as it is. */
const calls = (node: KMap): node is Calling => node.handler !== undefined;

/** Whether an element's outcome is a failure: it ran and broke or refused, or it never started. */
const failedOutcome = (result: ElementResult): result is Extract<Outcome, { ok: false }> =>
  'ok' in result && !result.ok;

/** What a map needs of the run it is in: the values it reads and what reports show of them, its clock, whether it has ended, and how one element's handler is called. */
export interface MapHost {
  readonly values: Map<string, unknown>;
  /** How a report reads a source: over what earlier reports show. */
  readonly showing: Reader;
  readonly clock: () => number;
  /** Whether the run has ended (broken or cancelled), so no further element may start. */
  ended(): boolean;
  /** Call the map's handler for one element, at the path under the map, with that element's report as its doors. */
  call(node: Calling, path: string[], inputs: Record<string, unknown>, report: NodeReport): Promise<unknown>;
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

/** The paths each element of a map's answer is redacted by: the operation's, under `value` where failures are collected. */
function answerPaths(node: KMap): string[][] | undefined {
  const paths = node.redact?.out;
  return node.onItemFailure === 'collect' ? paths?.map(path => ['value', ...path]) : paths;
}

/**
 * What a map's report shows of its answer: each element as its own report shows it, under its `value` where
 * failures are collected, and redacted by the map's paths again.
 */
export function shownAnswer(node: KMap, answer: unknown[], items: NodeReport[]): unknown[] {
  // the answer holds the kept elements alone, so its n-th is the n-th element not dropped
  const kept = items.filter(item => item.kept !== false);
  if (node.onItemFailure !== 'collect')
    return redactEach(
      kept.map(item => item.out),
      answerPaths(node),
    );
  const shown = answer.map((result, index) =>
    (result as Outcome).ok ? { ...(result as object), value: kept[index].out } : result,
  );
  return redactEach(shown, answerPaths(node));
}

/**
 * What a seeded map's report shows of the answer it was given: each element redacted as the map's own answer is,
 * and carrying the mark of what the map reads as a secret, where what it reads was supplied. A pure map's elements
 * are each shown as that element's report would have shown it, since each answers its own reads alone -- unless
 * the map has a `where`: which element of the list each answer stands for is then not known.
 */
export function seededAnswer(node: KMap, answer: unknown[], host: Pick<MapHost, 'values' | 'showing'>): unknown[] {
  const reads = readsOf(node, host);
  if (node.pure && !node.where) return answer.map((result, index) => seededElement(node, reads, result, index));
  const given = { ...reads.broadcast, over: reads.over };
  const secrets = readAsSecret(given, shownIn(node, reads.shown.broadcast, reads.shown.over));
  return carried(answer, redactEach(answer, answerPaths(node)), secrets) as unknown[];
}

/**
 * One element of a seeded pure map's answer, as its report would have shown it had it run: over what that element
 * would have read, and under its `value` where failures are collected.
 */
function seededElement(node: KMap, reads: Reads, result: unknown, index: number): unknown {
  const list = Array.isArray(reads.over) ? reads.over : [];
  const { given, shown } = elementReads({ node, broadcast: reads.broadcast, over: list, shown: reads.shown }, index);
  const secrets = readAsSecret(given, shown);
  if (node.onItemFailure !== 'collect') return shownOut(undefined, result, node, secrets);
  const outcome = result as Outcome;
  return outcome.ok ? { ...outcome, value: shownOut(undefined, outcome.value, node, secrets) } : outcome;
}

/** What a map reads, as `readsOf` answers it. */
type Reads = ReturnType<typeof readsOf>;

/**
 * What a map reads: the list and the shared inputs, as the values it is handed and as its report shows them, each
 * element shown as the list's report shows it -- the marker, where the list is shown as the marker whole.
 */
function readsOf(node: KMap, host: Pick<MapHost, 'values' | 'showing'>) {
  const over = readSource(node.over, host.values);
  const list = Array.isArray(over) ? over : [];
  const shownOver = readSource(node.over, host.showing);
  const shown = {
    broadcast: readAll(node.in, host.showing),
    over: list.map((_, at) => shownRead(list, shownOver, [String(at)])),
  };
  return { over, broadcast: readAll(node.in, host.values), shown };
}

/** What one element's handler is handed, and what its report shows it was handed, as the operation marks it. */
function elementReads(
  site: Pick<MapSite, 'node' | 'broadcast' | 'over' | 'shown'>,
  index: number,
): { given: Record<string, unknown>; shown: Record<string, unknown> } {
  const { node, broadcast, over, shown } = site;
  const given = elementInputs(node, broadcast, over[index]);
  const seen = elementInputs(node, shown.broadcast, shown.over[index]);
  return { given, shown: redactValue(seen, node.redact?.in) as Record<string, unknown> };
}

/**
 * One element's report before any element runs: seeded where `<id>.<index>` was pre-supplied, shown as the
 * operation marks what it answers and carrying the mark of what the element would have read as a secret. A seeded
 * element has an answer, so a `where` keeps it.
 */
function elementReport(host: MapHost, site: MapSite, index: number): NodeReport {
  const report = initialReport(host.values, `${site.id}.${index}`);
  if (report.status !== 'seeded') return report;
  if (site.node.where) report.kept = true;
  const reads = elementReads(site, index);
  report.out = shownOut(undefined, report.out, site.node, readAsSecret(reads.given, reads.shown));
  return report;
}

/**
 * A map's answer: every kept element's outcome when failures are collected; else the kept values, unless an element
 * failed. A dropped element is left out and fails nothing. An element that never started leaves the answer
 * undecided, whichever way failures are taken: the node fails.
 */
function collectMap(id: string, node: KMap, results: ElementResult[]): unknown[] {
  const collect = node.onItemFailure === 'collect';
  const index = results.findIndex(result => failedOutcome(result) && (!collect || result.cancelled));
  const outcomes = results.filter((result): result is Outcome => 'ok' in result);
  if (index < 0) return collect ? outcomes : outcomes.map(result => (result as { value: unknown }).value);
  const failed = results[index] as Extract<Outcome, { ok: false }>;
  // an element that refused refuses the map, with its reason; an element that broke is a fault of the map
  if (failed.reason !== undefined) throw new Refusal(failed.reason, failed.error, failed.detail);
  throw new Error(`map '${id}' element ${index}: ${failed.error}`);
}

/** What a map answers: every element run, its report under `items`; throws as the node's failure when one failed under `fail`. */
export async function runMap(host: MapHost, id: string, node: KMap, report: NodeReport): Promise<unknown[]> {
  const { over, broadcast, shown } = readsOf(node, host);
  if (!Array.isArray(over)) throw new Error(`map '${id}': over is not a list`);
  report.in = shownIn(node, shown.broadcast, shown.over);
  if (node.limit !== undefined && over.length > node.limit)
    throw new Error(`map '${id}': ${over.length} elements, limit ${node.limit}`);
  const site: MapSite = { id, node, broadcast, over, shown, items: [], results: [], cursor: 0, broken: false };
  // one report per element; an element supplied in initial as '<id>.<index>' is seeded and never runs
  site.items = over.map((_, index) => elementReport(host, site, index));
  report.items = site.items;
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
    if (failedOutcome(result) && site.node.onItemFailure === 'fail') site.broken = true;
  }
}

/**
 * One element of a map: a seeded element answers at once with the value it was given (its report shows it
 * redacted), a cancelled one never runs; the rest are judged by the map's `where`, and a kept element runs the
 * handler with the element bound in, or answers itself where the map has no handler.
 */
async function runElement(host: MapHost, site: MapSite, index: number): Promise<ElementResult> {
  const element = site.items[index];
  if (element.status === 'seeded') return { ok: true, value: host.values.get(`${site.id}.${index}`) };
  if (element.status === 'cancelled') return { ok: false, error: 'cancelled', cancelled: true };
  const judged = judge(host, site, index);
  if (judged) return judged;
  const { node } = site;
  return calls(node) ? runCall(host, site, node, index) : keptAsIs(host, site, index);
}

/**
 * What the map's `where` makes of an element as it starts: dropped, `cancelled` and never run; a fault of the
 * element where the rule threw; or nothing, where it is kept and runs on. The rule reads the element as `item`,
 * whatever `bind` hands the operation, beside the map's shared inputs.
 */
function judge(host: MapHost, site: MapSite, index: number): ElementResult | undefined {
  const rule = site.node.where;
  if (!rule) return undefined;
  const element = site.items[index];
  try {
    element.kept = rule.when({ ...site.broadcast, item: site.over[index] });
  } catch (error) {
    element.startedAt = host.clock();
    return broke(host, element, error);
  }
  if (element.kept) return undefined;
  element.status = 'cancelled';
  return { dropped: true };
}

/** A kept element of a map with no handler: it answers itself, shown as the list's report shows it. */
function keptAsIs(host: MapHost, site: MapSite, index: number): ElementResult {
  const element = site.items[index];
  element.startedAt = host.clock();
  element.out = site.shown.over[index];
  element.status = 'done';
  element.endedAt = host.clock();
  return { ok: true, value: site.over[index] };
}

/** An element that broke or refused: its report says so, and when it ended. */
function broke(host: MapHost, element: NodeReport, error: unknown): ElementResult {
  element.status = 'failed';
  element.error = (error as Error).message;
  noteRefusal(element, error);
  element.endedAt = host.clock();
  return { ok: false, error: element.error, reason: element.reason, detail: element.detail };
}

/** A kept element of a map that calls: the handler run with the element bound in, its answer shown as the operation marks it. */
async function runCall(host: MapHost, site: MapSite, node: Calling, index: number): Promise<ElementResult> {
  const element = site.items[index];
  const reads = elementReads(site, index);
  element.status = 'running';
  element.startedAt = host.clock();
  element.handler = node.handler;
  element.in = reads.shown;
  const secrets = readAsSecret(reads.given, reads.shown);
  try {
    const value = await host.call(node, [site.id, String(index)], reads.given, element);
    element.out = shownOut(element.sub, value, node, secrets);
    element.status = 'done';
    element.endedAt = host.clock();
    return { ok: true, value };
  } catch (error) {
    return broke(host, element, error);
  }
}
