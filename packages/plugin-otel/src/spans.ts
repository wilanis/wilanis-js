/**
 * A trace, said as OpenTelemetry spans. Pure: a `Trace` in, a flat list of spans out, so what this plugin
 * sends can be read off a test without a collector, a clock or a socket.
 *
 * A `Trace` arrives finished -- it already has its nesting, its own start and end stamps, and, where the
 * caller sent one, the correlation that says which trace it belongs to. So nothing here opens or closes a
 * span: the tree has already said what happened, and this only puts it in the words OTLP uses. That is why
 * the SDK's `Tracer` is not used and its exporter is: a tracer stamps spans as code runs, which is the one
 * thing that has already happened by the time an observer is handed a trace.
 */
import { randomBytes } from 'node:crypto';
import type { Trace, TraceAttributes } from '@wilanis/core';

/** The caller's own trace, as a W3C `traceparent` gives it: which trace this run belongs under, and to whom. */
export interface Parent {
  traceId: string;
  spanId: string;
}

/** What the exporter is handed per span: the fields an OTLP/HTTP exporter reads, and nothing it does not. */
export interface Span {
  name: string;
  kind: number;
  spanContext: () => { traceId: string; spanId: string; traceFlags: number };
  parentSpanContext?: { traceId: string; spanId: string; traceFlags: number };
  startTime: [number, number];
  endTime: [number, number];
  status: { code: number; message?: string };
  attributes: TraceAttributes;
  links: never[];
  events: never[];
  duration: [number, number];
  ended: true;
  resource: { attributes: TraceAttributes };
  instrumentationScope: { name: string; version: string };
  droppedAttributesCount: 0;
  droppedEventsCount: 0;
  droppedLinksCount: 0;
}

/** What every span of one export carries in common: who sent it and what this tree is called. */
export interface Scope {
  service: string;
  name: string;
  version: string;
}

/** A W3C traceparent: version, trace id, span id, flags. Only the two ids are read; the rest is the caller's. */
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * The caller's trace, where the correlation is a traceparent this exporter understands. A correlation the
 * runtime copied opaquely may be anything at all -- an x-request-id, a word -- so one that does not parse is
 * not an error: the run simply starts a trace of its own, and the string stays on the root span as an
 * attribute for whoever can read it.
 */
export function parentOf(correlation: unknown): Parent | undefined {
  if (typeof correlation !== 'string') return undefined;
  const found = TRACEPARENT.exec(correlation.trim());
  return found ? { traceId: found[1], spanId: found[2] } : undefined;
}

/** A new id of `bytes` bytes, as OTLP spells one: lower-case hex. */
const id = (bytes: number) => randomBytes(bytes).toString('hex');

/** Milliseconds as OTLP counts time: whole seconds, and the nanoseconds left over. */
function at(ms: number): [number, number] {
  const whole = Math.floor(ms / 1000);
  return [whole, Math.round((ms - whole * 1000) * 1e6)];
}

/** How long a span lasted, in the same pair of numbers, never negative. */
const lasted = (trace: Trace): [number, number] => at(Math.max(0, trace.endedAt - trace.startedAt));

/**
 * A status as OTLP grades it: 2 (error) for anything that did not end well, 1 (ok) otherwise. A refusal is an
 * error here even though it is a graph doing exactly what it says: to a collector, `refused: upstream` is
 * what one wants to find when searching for what went wrong, and the word itself rides along as the message.
 */
function statusOf(status: string): { code: number; message?: string } {
  const ok = status === 'ok' || status === 'allowed';
  if (ok) return { code: 1 };
  if (status === 'cancelled' || status === 'seeded') return { code: 0, message: status };
  return { code: 2, message: status };
}

/** Where one span sits: the trace it belongs to, its own id, and the span it hangs from. */
interface Place {
  traceId: string;
  spanId: string;
  parent?: string;
}

/** One span of a trace, under the parent it hangs from, in the trace it belongs to. */
function spanOf(trace: Trace, place: Place, scope: Scope): Span {
  const { traceId, spanId, parent } = place;
  const context = { traceId, spanId, traceFlags: 1 };
  return {
    name: trace.name,
    kind: 1,
    spanContext: () => context,
    parentSpanContext: parent ? { traceId, spanId: parent, traceFlags: 1 } : undefined,
    startTime: at(trace.startedAt),
    endTime: at(trace.endedAt),
    status: statusOf(trace.status),
    attributes: trace.attributes,
    links: [],
    events: [],
    duration: lasted(trace),
    ended: true,
    resource: { attributes: { 'service.name': scope.service } },
    instrumentationScope: { name: scope.name, version: scope.version },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/**
 * Every span of one trace, root first, each child hanging from the span above it. The trace id is the
 * caller's where the correlation gave one, so a request that crossed two services is one trace on the
 * collector; a new one otherwise.
 */
export function spansOf(trace: Trace, scope: Scope): Span[] {
  const from = parentOf(trace.attributes['wilanis.correlation']);
  const traceId = from?.traceId ?? id(16);
  const out: Span[] = [];
  const walk = (one: Trace, parent: string | undefined) => {
    const spanId = id(8);
    out.push(spanOf(one, { traceId, spanId, parent }, scope));
    for (const child of one.children) walk(child, spanId);
  };
  walk(trace, from?.spanId);
  return out;
}
