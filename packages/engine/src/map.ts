/**
 * A map node: its handler once per element of a list, every element at once, the node settling only when every
 * element has, so a failed map still says what each element did. The run decides when the map starts and what
 * its answer is taken for; this module runs the elements and says what came of each.
 */
import { redactValue } from './redact.js';
import { initialReport, noteRefusal } from './report.js';
import { readAll, readPath, readSource } from './sources.js';
import type { KMap, NodeReport } from './spec.js';
import { Refusal } from './spec.js';

/** What one element of a map came to: its value, or the error (and the reason, when it refused). */
type ElementResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; reason?: string; detail?: Record<string, unknown> };

/** What a map needs of the run it is in: the values it reads, its clock, and how one element's handler is called. */
export interface MapHost {
  readonly values: Map<string, unknown>;
  readonly clock: () => number;
  /** Call the map's handler for one element, at the path under the map, with that element's report as its doors. */
  call(node: KMap, path: string[], inputs: Record<string, unknown>, report: NodeReport): Promise<unknown>;
}

/** A running map: what every element shares. */
interface MapSite {
  id: string;
  node: KMap;
  broadcast: Record<string, unknown>;
  items: NodeReport[];
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

/** A map's answer: every element's outcome when failures are collected; else the values, unless an element failed. */
function collectMap(id: string, node: KMap, results: ElementResult[]): unknown[] {
  if (node.onItemFailure === 'collect') return results;
  const index = results.findIndex(result => !result.ok);
  if (index < 0) return results.map(result => (result as { value: unknown }).value);
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
  report.in = { ...broadcast, over };
  // one report per element; an element supplied in initial as '<id>.<index>' is seeded and never runs
  const items = over.map((_, index) => initialReport(host.values, `${id}.${index}`));
  report.items = items;
  const site: MapSite = { id, node, broadcast, items };
  // every element settles before the node does, whatever happened to the others
  const results = await Promise.all(over.map((item, index) => runElement(host, site, index, item)));
  return collectMap(id, node, results);
}

/** One element of a map: a seeded element answers at once; the rest run the handler with the element bound in. */
async function runElement(host: MapHost, site: MapSite, index: number, item: unknown): Promise<ElementResult> {
  const element = site.items[index];
  if (element.status === 'seeded') return { ok: true, value: element.out };
  const inputs = elementInputs(site.node, site.broadcast, item);
  element.status = 'running';
  element.startedAt = host.clock();
  element.handler = site.node.handler;
  element.in = redactValue(inputs, site.node.redact?.in) as Record<string, unknown>;
  try {
    const value = await host.call(site.node, [site.id, String(index)], inputs, element);
    element.out = redactValue(value, site.node.redact?.out);
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
