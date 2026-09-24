/**
 * `wilanis map`: how the tree hangs together -- trigger → graph → ports → bindings → graphs, as one tree of lines a
 * terminal prints. Under a profile the map draws what that profile runs; what the other profiles run is named
 * after it, and only a graph the tree reaches under no profile at all is an orphan.
 */
import { graphsReachedBy, profilesOf } from '@wilanis/compiler';
import type { LoadResult } from '@wilanis/core';
import { type BindingDoc, type Loaded, policyPath, Scope, type TriggerDoc } from '@wilanis/core';
import { holdsLines } from './invariant-lines.js';
import { scopeTail } from './scope-said.js';
import { storeTail } from './stores.js';
import { settingsSaid } from './trigger-said.js';

// ---- the walk ----------------------------------------------------------------------------------------

/** Every graph a walk reached, and the bindings each was reached through: the binding is who implements it. */
type Reach = Map<string, Set<string>>;

/**
 * What one walk of the map carries: the scope it reads, the profile that chooses a binding where a port has
 * several, the graphs it has written, every graph it reached, and the binding it is walking under.
 */
interface Walk {
  scope: Scope;
  /** Chooses each domain port's binding as `rehearse` does; without one, a port with several is said to need it. */
  profile?: string;
  /** Written once per trigger, so a graph two triggers reach is drawn under each. */
  seen: Set<string>;
  /** Shared across the whole map: what is left over is the orphans. */
  reach: Reach;
  /** The binding whose graph is being walked, so a graph reached is said to be bound by it. */
  via?: string;
}

/** Where one node leads next: the graph a binding's operation runs, and the binding it runs it for. */
interface Into {
  graph: string;
  binding: string;
}

/** Where one node of one graph leads: one switch's routes, one native operation, or the binding that meets it. */
function nodeLines(node: Record<string, unknown>, indent: string, walk: Walk): { lines: string[]; into?: Into } {
  const { scope } = walk;
  const id = String(node.id);
  if (!('run' in node)) {
    const rules = node.rules as { to: string }[];
    return { lines: [`${indent}  ${id} [switch → ${[...rules.map(rule => rule.to), node.else].join(' | ')}]`] };
  }
  const run = String(node.run);
  const found = scope.op(run);
  if (typeof found === 'string') return { lines: [`${indent}  ${id} ?? ${run}`] };
  if (found.port.native) {
    const effect = found.op.pure ? '' : '  (effect)';
    const given = node.in as Record<string, unknown>;
    const tail = `${storeTail(run, given, scope)}${scopeTail(run, given, scope)}`;
    return { lines: [`${indent}  ${id} ${run}${effect}${tail}`] };
  }
  const binding = scope.bindingFor(found.path, walk.profile);
  const lines = [`${indent}  ${id} ${run}`];
  if (typeof binding === 'string') return { lines: [...lines, `${indent}    ?? ${binding}`] };
  const op = binding.doc.operations[found.opName];
  lines.push(`${indent}    ${binding.path}#${found.opName}${op?.run ? ` → ${op.run}` : ''}`);
  return { lines, into: op?.graph ? { graph: op.graph, binding: binding.path } : undefined };
}

/** Record that a walk reached one graph, and through which binding. */
function reached(walk: Walk, graphPath: string): void {
  const through = walk.reach.get(graphPath) ?? new Set<string>();
  if (walk.via) through.add(walk.via);
  walk.reach.set(graphPath, through);
}

/**
 * One graph and everything it reaches, indented; one graph already seen is named but not walked again. A graph
 * whose effects move together is marked where the map names it, so a reader of the tree sees the transaction
 * without opening the document.
 */
function mappedGraph(ref: string, indent: string, walk: Walk): string[] {
  const graph = walk.scope.get('graph', ref);
  if (!graph) return [`${indent}?? ${ref}`];
  reached(walk, graph.path);
  const lines = [`${indent}${graph.path}${graph.doc.atomic ? '  [atomic]' : ''}`];
  if (walk.seen.has(graph.path)) return lines;
  walk.seen.add(graph.path);
  for (const node of graph.doc.nodes) {
    const said = nodeLines(node as unknown as Record<string, unknown>, indent, walk);
    lines.push(...said.lines);
    if (said.into) lines.push(...mappedGraph(said.into.graph, `${indent}      `, { ...walk, via: said.into.binding }));
  }
  return lines;
}

/** The policies one trigger is gated by, in order. */
function gateLines(trigger: Loaded<TriggerDoc>, scope: Scope): string[] {
  const lines: string[] = [];
  for (const use of trigger.doc.policies ?? []) {
    const ref = policyPath(use);
    const policy = scope.get('policy', ref);
    const decides = policy ? ` → ${policy.doc.decide.run}` : '';
    const given = typeof use !== 'string' && use.in ? `  given ${Object.keys(use.in).join(', ')}` : '';
    lines.push(`  gated by ${policy?.path ?? `?? ${ref}`}${decides}${given}`);
  }
  return lines;
}

/**
 * The bindings drawn under the port one trigger fires: the one the profile chooses, or every binding of the port
 * when no profile was given -- and the reason, where a profile was given and still chooses none.
 */
function bindingsShown(portPath: string, walk: Omit<Walk, 'seen'>): { bindings: Loaded<BindingDoc>[]; why?: string } {
  if (walk.profile === undefined) return { bindings: walk.scope.bindingsFor(portPath) };
  const chosen = walk.scope.bindingFor(portPath, walk.profile);
  return typeof chosen === 'string' ? { bindings: [], why: chosen } : { bindings: [chosen] };
}

/** What each binding of the port one trigger fires meets it with, and the graph behind it. */
function firesLines(trigger: Loaded<TriggerDoc>, load: LoadResult, walk: Omit<Walk, 'seen'>): string[] {
  const port = load.registry.get('port', load.resolve(trigger.doc.fire.run.split('#')[0]));
  const opName = trigger.doc.fire.run.split('#')[1];
  const lines = [`  ${trigger.doc.fire.run}`];
  if (!port) return lines;
  const shown = bindingsShown(port.path, walk);
  if (shown.why) lines.push(`    ?? ${shown.why}`);
  for (const binding of shown.bindings) {
    const op = binding.doc.operations[opName];
    if (op?.graph) lines.push(...mappedGraph(op.graph, '    ', { ...walk, seen: new Set(), via: binding.path }));
    else if (op?.run) lines.push(`    ${binding.path}#${opName} → ${op.run}`);
  }
  return lines;
}

/**
 * Every trigger of the tree and everything each one reaches, with the graphs reached gathered as the walk goes
 * rather than read back off its lines: a line carries marks beside the path (`[atomic]`), and a graph must not
 * become an orphan because of how it is written down.
 */
function walked(load: LoadResult, scope: Scope, profile?: string): { lines: string[]; reach: Reach } {
  const lines: string[] = [];
  const reach: Reach = new Map();
  for (const trigger of load.registry.all('trigger')) {
    // what fires it, beside the kind, in the kind's own words: a route's path, a schedule's expression
    const said = settingsSaid(trigger, scope);
    lines.push(`${trigger.path}  (${trigger.doc.kind})${said ? `  ${said}` : ''}`);
    lines.push(...gateLines(trigger, scope));
    // under the gates, since an invariant is a rule about what those gates must be, not another gate
    lines.push(...holdsLines(trigger, scope));
    lines.push(...firesLines(trigger, load, { scope, profile, reach }));
  }
  return { lines, reach };
}

// ---- map ---------------------------------------------------------------------------------------------

/**
 * The graphs the tree enters under no profile at all: what `reachOf` walks -- every trigger's `fire`, every
 * policy a trigger attaches, every required port, every startup step -- taken over each declared profile, or the
 * unnamed one, and subtracted from the graphs the tree has. The drawing above follows a trigger into the graph
 * behind it and no further than its nodes; the checker's walk is what says whether a graph runs, so it is what
 * the word `orphan` reads.
 */
function orphans(load: LoadResult, scope: Scope): string[] {
  const entered = new Set<string>();
  for (const profile of profilesOf(scope)) for (const path of graphsReachedBy(scope, profile)) entered.add(path);
  return load.registry
    .all('graph')
    .filter(graph => !entered.has(graph.path))
    .map(graph => graph.path);
}

/**
 * Every trigger of the tree, everything each one reaches, and the graphs nothing reaches.
 *
 * Under a profile, each domain port is met by the binding the profile chooses, as `rehearse` chooses it; without
 * one, every binding is drawn, and a call on a port with several says so. A graph only another profile's binding
 * reaches is not dead -- it is the other half of what profiles are for -- so it is named after the triggers as
 * `unreached under <profile>`, with the binding that runs it, and a reader can follow it there. An orphan keeps
 * its meaning whatever the profile: a graph the tree reaches under none of them.
 */
export function map(load: LoadResult, profile?: string): string[] {
  const scope = new Scope(load.registry, load.resolve);
  const under = walked(load, scope, profile);
  const everywhere = profile === undefined ? under.reach : walked(load, scope).reach;
  const lines = [...under.lines];
  for (const graph of load.registry.all('graph')) {
    const bound = everywhere.get(graph.path);
    if (!bound || under.reach.has(graph.path)) continue;
    lines.push(`unreached under ${profile}  ${graph.path}  bound by ${[...bound].sort().join(', ')}`);
  }
  for (const path of orphans(load, scope)) lines.push(`orphan  ${path}`);
  return lines;
}
