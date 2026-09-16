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
import type { Scope, Trace, TraceAttributes } from '@wilanis/core';
import type { NodeReport, Report } from '@wilanis/engine';
import { type Decided, type Fired, type Identified, isStarted, type Ran, statusOf } from './fired.js';

export { traceJson, traceText } from './trace-print.js';

/** How much a span carries: `summary` never a value, `full` the report's redacted in/out and the message. */
export type Level = 'summary' | 'full';

/** What a walk of one run carries down: the tree it reads contracts from, and how much a span may say. */
interface Walk {
  scope: Scope;
  level: Level;
}

/** A span built from its parts, so every one of them is made in one place and carries the same shape. */
function span(what: {
  name: string;
  status: string;
  at: { startedAt?: number; endedAt?: number };
  attributes: TraceAttributes;
  children?: Trace[];
}): Trace {
  return {
    name: what.name,
    startedAt: what.at.startedAt ?? 0,
    endedAt: what.at.endedAt ?? what.at.startedAt ?? 0,
    status: what.status,
    attributes: what.attributes,
    children: what.children ?? [],
  };
}

/** What `wilanis.in`, `wilanis.out` and `wilanis.error` a node may carry: all of them at `full`, none at `summary`. */
function valued(node: NodeReport, level: Level): TraceAttributes {
  if (level !== 'full') return {};
  const out: TraceAttributes = {};
  if (node.in !== undefined) out['wilanis.in'] = JSON.stringify(node.in);
  if (node.out !== undefined) out['wilanis.out'] = JSON.stringify(node.out);
  if (node.error !== undefined) out['wilanis.error'] = node.error;
  return out;
}

/**
 * The connection an effect used and the status an HTTP call answered, read off the node's own `in` and `out`.
 * It is a lookup and never a branch that spreads: the engine knows nothing of connections or of HTTP, so the
 * two names a reader searches on are read here, where the tree's words are already known.
 */
function looked(node: NodeReport): TraceAttributes {
  const out: TraceAttributes = {};
  const connection = node.in?.connection;
  if (typeof connection === 'string') out['wilanis.connection'] = connection;
  const answered = node.out as Record<string, unknown> | undefined;
  const status = answered && typeof answered === 'object' ? answered.status : undefined;
  if (node.handler === HTTP_REQUEST && typeof status === 'number') out['http.response.status_code'] = status;
  return out;
}

/** The one handler whose answer carries a status a reader of a trace expects to find under its own name. */
const HTTP_REQUEST = '@http/http.port.json#request';

/** How a node ended, in the words a span carries: a refusal says its reason, anything else says its status. */
function nodeStatus(node: NodeReport): string {
  if (node.status !== 'failed') return node.status === 'done' ? 'ok' : node.status;
  return node.reason ? `refused: ${node.reason}` : 'failed';
}

/** Whether the operation a node ran is an effect: not `pure`, as the port that declares it says. */
function isEffect(handler: string | undefined, scope: Scope): boolean {
  if (!handler || handler.startsWith('graph:')) return false;
  const hit = scope.op(handler);
  return typeof hit === 'string' ? false : hit.op.pure !== true;
}

/** What a node span says about itself whatever kind of node it is: where it is, and what it carried. */
function nodeAttributes(id: string, node: NodeReport, walk: Walk): TraceAttributes {
  return {
    'wilanis.node': id,
    'wilanis.at': `nodes/${id}`,
    ...(node.handler && !node.handler.startsWith('graph:')
      ? { 'wilanis.effect': isEffect(node.handler, walk.scope) }
      : {}),
    ...looked(node),
    ...valued(node, walk.level),
  };
}

/**
 * A `switch`: what it routed to. Which of its rules fired is not on the span, because no report carries it --
 * `NodeReport` keeps the node selected and not the rule that chose it, and reading it back from the graph
 * would be the trace guessing rather than saying. It is an engine's to record if it is ever wanted.
 */
function switchSpan(id: string, node: NodeReport, walk: Walk): Trace {
  return span({
    name: `${id} switch → ${node.selected ?? 'nothing'}`,
    status: nodeStatus(node),
    at: node,
    attributes: {
      ...nodeAttributes(id, node, walk),
      ...(node.selected ? { 'wilanis.selected': node.selected } : {}),
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

/** A `run` node: what it ran, how it ended, and what ran inside it where it called something nested. */
function callSpan(id: string, node: NodeReport, walk: Walk): Trace {
  const handler = node.handler ?? '';
  const graph = handler.startsWith('graph:') ? handler.slice('graph:'.length) : undefined;
  return span({
    name: graph ? `${id} (${graph})` : `${id} ${handler}`.trimEnd(),
    status: nodeStatus(node),
    at: node,
    attributes: nodeAttributes(id, node, walk),
    children: node.sub ? nestedSpans(node.sub, walk) : [],
  });
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
 * report is a status and nothing else.
 */
function nodeSpan(id: string, node: NodeReport, walk: Walk): Trace {
  if (node.selected !== undefined) return switchSpan(id, node, walk);
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
  return Object.entries(report.nodes).map(([id, node]) => nodeSpan(id, node, walk));
}

/**
 * What ran inside one port operation's report. A binding operation lowers to a single node called `op`, which
 * names nothing an author wrote: where it ran a graph, the graph beneath it is what a reader wants, and where
 * it delegated to a native operation the wrapper is the only node there is and stands for it.
 */
function insideOperation(report: Report, walk: Walk): Trace[] {
  const sub = report.nodes.op?.sub;
  return sub ? [graphSpan(sub, walk)] : nodesOf(report, walk);
}

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
    attributes: bound ? { 'wilanis.binding': path } : { 'wilanis.port': path },
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
    attributes: { 'wilanis.policy': decided.policy, 'wilanis.policy.outcome': outcome },
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

/** The attributes that carry what a run said rather than what it did; `summary` carries none of them. */
const VALUED = ['wilanis.in', 'wilanis.out', 'wilanis.error'];

/**
 * A trace already built, narrowed to what a level allows: the same spans and the same nesting, carrying only
 * what the level lets them. One trace is built per run and handed to every observer, so the narrowing is each
 * observer's and not the server's -- a printer asked for `summary` and an exporter asked for `full` are served
 * by the one walk. A cancelled node is kept at `full` and dropped at `summary`.
 */
export function atLevel(trace: Trace, level: Level): Trace {
  if (level === 'full') return trace;
  const attributes: TraceAttributes = {};
  for (const [name, value] of Object.entries(trace.attributes)) if (!VALUED.includes(name)) attributes[name] = value;
  return {
    ...trace,
    attributes,
    children: trace.children.filter(child => child.status !== 'cancelled').map(child => atLevel(child, level)),
  };
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
