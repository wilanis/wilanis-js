/**
 * A run said as spans. `traceOf` is pure: it walks what one fire or one startup step left behind -- the gate's
 * record and the engine's reports -- and answers the `Trace` an exporter reads and the printers below write.
 * Nothing is instrumented by an author; the graph is the instrumentation, and this is the reading of it.
 *
 * Two levels, and the difference is what may leave the process. `summary` carries status, timing and the
 * attributes that say what ran -- never a value. `full` adds the report's already-redacted `in`/`out` and the
 * node's message, because a message is prose an author interpolated values into and only they can say it is
 * safe to export. A refusal's `detail` never enters a trace at either level.
 */
import type { Scope, Trace, TraceAttributes, TraceLevel } from '@wilanis/core';
import type { NodeReport, Report } from '@wilanis/engine';
import { type Decided, type Fired, type Identified, isStarted, type Ran, statusOf } from './fired.js';
import {
  addressOf,
  caughtAt,
  nodeAttributes,
  nodeStatus,
  operationAddressOf,
  span,
  valued,
  type Walk,
} from './trace-span.js';

/**
 * How much a span carries, and the narrowing of an already-built trace to it. Both are core's, beside the
 * `Trace` they describe, so the runtime that builds a trace and an exporter that sends one read one list of
 * what counts as a value; they are re-exported here because this is the module a reader of traces opens.
 */
export { atLevel } from '@wilanis/core';
export { traceJson, traceText } from './trace-print.js';
export type Level = TraceLevel;

/**
 * A `switch`: what it routed to, and whose fault where it routed one. Which of its rules fired is not on the
 * span, because no report carries it -- `NodeReport` keeps the node selected and not the rule that chose it,
 * and reading it back from the graph would be the trace guessing rather than saying.
 */
function switchSpan(id: string, node: NodeReport, walk: Walk, within?: Report): Trace {
  return span({
    name: `${id} switch → ${node.selected ?? 'nothing'}`,
    status: nodeStatus(node),
    at: node,
    attributes: {
      ...nodeAttributes(id, node, walk),
      ...(node.selected ? { 'wilanis.selected': node.selected } : {}),
      ...caughtAt(id, within, walk.scope),
    },
  });
}

/** A `map`: the node itself, with one child span per element, named `<id>.<index>`. */
function mapSpan(id: string, node: NodeReport, walk: Walk): Trace {
  const items = node.items ?? [];
  return span({
    name: `${id} map ×${items.length}`,
    status: nodeStatus(node),
    at: node,
    attributes: nodeAttributes(id, node, walk),
    children: items.map((item, at) => nodeSpan(`${id}.${at}`, item, walk)),
  });
}

/**
 * A `run` node or a map element: what it ran, how it ended, and what ran inside it. A node that was tried
 * again says how often on its own span and carries each try that did not stand as a child, in order, before
 * what ran inside the try that did; a node tried once is exactly what it was before anything retried.
 */
function callSpan(id: string, node: NodeReport, walk: Walk): Trace {
  const handler = node.handler ?? '';
  const graph = handler.startsWith('graph:') ? handler.slice('graph:'.length) : undefined;
  return span({
    name: graph ? `${id} (${graph})` : `${id} ${handler}`.trimEnd(),
    status: nodeStatus(node),
    at: node,
    attributes: { ...nodeAttributes(id, node, walk), ...triedAgain(node) },
    children: [
      ...triesOf(node, { name: id, attributes: addressOf(id) }, walk),
      ...(node.sub ? nestedSpans(node.sub, walk) : []),
    ],
  });
}

/** How many tries a node took before the one that stood, where it took any: `wilanis.attempts`. */
const triedAgain = (node: NodeReport): TraceAttributes =>
  node.attempts?.length ? { 'wilanis.attempts': node.attempts.length } : {};

/** Where the tries of one site are said to be: the name each is called by, and the address each carries. */
interface TriedAt {
  name: string;
  attributes: TraceAttributes;
}

/**
 * Each try of a node that did not stand, in order, as `<name> try <n>` with its own stamps. Its error is a
 * message like a node's, so it is carried at `full` only; a try that ran a graph has that graph beneath it.
 */
function triesOf(node: NodeReport, site: TriedAt, walk: Walk): Trace[] {
  return (node.attempts ?? []).map((attempt, at) =>
    span({
      name: `${site.name} try ${at + 1}`,
      status: 'failed',
      at: attempt,
      attributes: { ...site.attributes, ...valued(attempt, walk.level) },
      children: attempt.sub ? nestedSpans(attempt.sub, walk) : [],
    }),
  );
}

/**
 * What one node's nested run adds to the trace. A node that ran a graph adds that graph; a node that called
 * another port operation adds the binding that met it, and never the wrapper node in between -- which is the
 * same `op` node `insideOperation` steps over, reached this time from a node rather than from a fire.
 */
function nestedSpans(sub: Report, walk: Walk): Trace[] {
  return sub.graph.includes('#') ? [bindingSpan(sub, walk)] : [graphSpan(sub, walk)];
}

/**
 * One node of a graph, as the kind of node it is. What tells them apart is what the report kept: only a switch
 * routes, only a map has elements. A node that did neither is a call -- including one that never ran, whose
 * report is a status and nothing else. `within` is the report it sits in, where a switch finds whose fault it routed.
 */
function nodeSpan(id: string, node: NodeReport, walk: Walk, within?: Report): Trace {
  if (node.selected !== undefined) return switchSpan(id, node, walk, within);
  return node.items ? mapSpan(id, node, walk) : callSpan(id, node, walk);
}

/** One nested run: the graph it is, how it ended, and one span per node that ran in it. */
function graphSpan(report: Report, walk: Walk): Trace {
  return span({
    name: report.graph,
    status: statusOf(report),
    at: report,
    attributes: { 'wilanis.graph': report.graph },
    children: nodesOf(report, walk),
  });
}

/** Every node of one report, in the order the report holds them. */
function nodesOf(report: Report, walk: Walk): Trace[] {
  return Object.entries(report.nodes).map(([id, node]) => nodeSpan(id, node, walk, report));
}

/**
 * What ran inside one port operation's report. A binding operation lowers to a single node called `op`, which
 * names nothing an author wrote: where it ran a graph, the graph beneath it is what a reader wants, and where
 * it delegated to a native operation the wrapper is the only node there is and stands for it. A binding
 * operation that retried its graph keeps each try that did not stand, named by the operation, before the one
 * that did.
 */
function insideOperation(report: Report, walk: Walk): Trace[] {
  const op = report.nodes.op;
  if (!op?.sub) return nodesOf(report, walk);
  const opName = report.graph.split('#')[1] ?? 'op';
  const site = { name: opName, attributes: operationAddressOf(opName) };
  return [...triesOf(op, site, walk), graphSpan(op.sub, walk)];
}

/**
 * How often a binding operation that runs a graph was tried: the binding's or the policy's span says it, since
 * the `op` node that carries the tries has no span of its own there. A delegation keeps its `op` span, which
 * says it itself.
 */
const ranAGraphAgain = (report: Report): TraceAttributes => (report.nodes.op?.sub ? triedAgain(report.nodes.op) : {});

/**
 * What met one port operation, and what ran inside it: the binding a profile chose, or the port itself where
 * the operation is native and no binding met it -- a startup step naming `@http/server.port.json#listen` runs
 * one such, and calling it a binding would name a document that is not there.
 */
function bindingSpan(report: Report, walk: Walk): Trace {
  const path = report.graph.split('#')[0];
  const bound = walk.scope.get('binding', path) !== undefined;
  return span({
    name: bound ? `binding ${report.graph}` : report.graph,
    status: statusOf(report),
    at: report,
    attributes: { ...(bound ? { 'wilanis.binding': path } : { 'wilanis.port': path }), ...ranAGraphAgain(report) },
    children: insideOperation(report, walk),
  });
}

/** The port operation a trigger fires, canonical, or nothing where the tree no longer holds the trigger. */
function operationOf(fired: Fired, scope: Scope): { port: string; opName: string } | undefined {
  const trigger = scope.get('trigger', fired.trigger);
  if (!trigger) return undefined;
  const hit = scope.op(trigger.doc.fire.run);
  return typeof hit === 'string' ? undefined : { port: hit.path, opName: hit.opName };
}

/**
 * What the trigger's operation did: the port operation an author named, with the binding that met it beneath.
 * Where the tree no longer holds the trigger -- a policy rehearsed as one, a trigger handed in -- the binding
 * is the whole of it, since there is no port document to name.
 */
function operationSpan(fired: Fired, run: Report, walk: Walk): Trace {
  const found = operationOf(fired, walk.scope);
  const binding = bindingSpan(run, walk);
  if (!found) return binding;
  return span({
    name: `${found.port}#${found.opName}`,
    status: statusOf(run),
    at: run,
    attributes: { 'wilanis.port': found.port, 'wilanis.operation': found.opName },
    children: [binding],
  });
}

/** The guard's identification: how long it took, and whether it named anyone. */
function identifySpan(identify: Identified, root: string): Trace {
  return span({
    name: `identify (${root})`,
    status: identify.refused ? `refused: ${identify.refused}` : 'ok',
    at: identify,
    attributes: {
      'wilanis.principal': identify.added.includes('principal') ? 'yes' : 'no',
      'wilanis.session': identify.added.includes('session') ? 'yes' : 'no',
    },
  });
}

/** What one policy decided: allowed, denied or challenged, with its own decision graph beneath it. */
function policySpan(decided: Decided, walk: Walk): Trace {
  const outcome = outcomeWord(decided);
  const refusal = decided.report.status === 'failed' ? statusOf(decided.report).replace(/^refused: /, '') : undefined;
  return span({
    name: `policy ${decided.policy}`,
    status: outcome === 'allowed' ? 'allowed' : `${outcome}: ${refusal ?? 'refused'}`,
    at: decided.report,
    attributes: {
      'wilanis.policy': decided.policy,
      'wilanis.policy.outcome': outcome,
      ...ranAGraphAgain(decided.report),
    },
    children: insideOperation(decided.report, walk),
  });
}

/** The word one decision ended on: what the policy's outcome made of a refusal, or that it allowed. */
function outcomeWord(decided: Decided): 'allowed' | 'denied' | 'challenged' {
  if (decided.report.status === 'done') return 'allowed';
  return decided.effect === 'challenge' ? 'challenged' : 'denied';
}

/** The alias of the plugin that identified the caller, so the span says which one did it. */
const guardRoot = (scope: Scope): string => scope.guard()?.native ?? 'guard';

/** Everything that happened under one fire: the gate in the order it ran, then the operation where it ran. */
function firedChildren(fired: Fired, walk: Walk): Trace[] {
  const children: Trace[] = [];
  if (fired.identify) children.push(identifySpan(fired.identify, guardRoot(walk.scope)));
  for (const decided of fired.decisions) children.push(policySpan(decided, walk));
  if (fired.run) children.push(operationSpan(fired, fired.run, walk));
  return children;
}

/** The root span of one fire, with everything the gate and the run did beneath it. */
function firedSpan(fired: Fired, walk: Walk): Trace {
  return span({
    name: `fire ${fired.trigger}`,
    status: statusOf(fired.answer),
    at: fired,
    attributes: {
      'wilanis.run.id': fired.id,
      'wilanis.trigger': fired.trigger,
      'wilanis.kind': fired.kind,
      ...(fired.correlation ? { 'wilanis.correlation': fired.correlation } : {}),
    },
    children: firedChildren(fired, walk),
  });
}

/**
 * One run said as spans: a fire of a trigger, or one of the project's startup steps. Pure -- it reads the
 * record and the tree's contracts and touches nothing -- so a printer, an exporter and a test all see the same
 * trace for the same run. The level says how much a span may carry, and `summary` is what is safe by default.
 */
export function traceOf(ran: Ran, scope: Scope, opts: { level?: Level } = {}): Trace {
  const walk: Walk = { scope, level: opts.level ?? 'summary' };
  if (!isStarted(ran)) return firedSpan(ran, walk);
  return span({
    name: `startup ${ran.label}`,
    status: statusOf(ran.answer),
    at: ran,
    attributes: { 'wilanis.run.id': ran.id, 'wilanis.startup.at': ran.at, 'wilanis.operation': ran.run },
    children: [bindingSpan(ran.answer, walk)],
  });
}
