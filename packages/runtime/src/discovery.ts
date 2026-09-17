/**
 * `wilanis ls`, `wilanis describe` and `wilanis map`: what one tree holds, what one document says, and how the tree hangs
 * together, each answered as lines one terminal prints.
 */
import type { LoadResult } from '@wilanis/core';
import {
  type Kind,
  type Loaded,
  type PolicyDoc,
  policyPath,
  Scope,
  splitOp,
  type TriggerDoc,
  type TriggerKindDoc,
} from '@wilanis/core';
import { graphLines } from './graph-said.js';
import { holdsLines, invariantLines, overShape } from './invariant-said.js';
import { fieldLine, portLines, shower, storeLines } from './lines.js';
import { storeTail } from './stores.js';

// ---- discovery --------------------------------------------------------------------------------------

/** Every document one tree holds, one line each, sorted by kind then path, and saying which are not the tree's own. */
export function ls(load: LoadResult, kind?: Kind): string[] {
  return load.registry.files
    .filter(file => !kind || file.kind === kind)
    .sort((one, other) => one.kind.localeCompare(other.kind) || one.path.localeCompare(other.path))
    .map(file => `${file.kind.padEnd(16)} ${file.path}${whereFrom(file)}`);
}

/** Where one document came from, when it is not the tree's own. */
function whereFrom(file: { native?: string; included?: string }): string {
  if (file.native) return '  (native)';
  return file.included ? `  (included from ${file.included})` : '';
}

/** A trigger kind, one connection kind or one plugin: its settings, the context it hands, and its guard. */
function kindLines(doc: Loaded, showType: (spec: unknown) => string): string[] {
  const lines: string[] = [];
  const declared = doc.doc as TriggerKindDoc;
  if (declared.settings) {
    lines.push('settings:');
    for (const [name, field] of Object.entries(declared.settings.fields)) lines.push(fieldLine(name, field, showType));
  }
  if ('context' in declared) {
    lines.push('context (request.*):');
    for (const [name, field] of Object.entries(declared.context.fields)) lines.push(fieldLine(name, field, showType));
  }
  if (declared.refusals)
    lines.push(
      `refusals: settings.${declared.refusals} maps each reason one trigger can reach to how it is answered (T005, T006)`,
    );
  if (declared.correlation)
    lines.push(
      `correlation: request.${declared.correlation} correlates a run with the caller's trace, copied opaquely (T007)`,
    );
  if ('grants' in (declared as unknown as { grants?: unknown }))
    lines.push(`grants: ${JSON.stringify((declared as unknown as { grants: unknown }).grants)}`);
  lines.push(...guardLines(declared, showType));
  return lines;
}

/** What one guard declares: the context it adds, the reasons it refuses with, and the credentials it takes. */
function guardLines(declared: TriggerKindDoc, showType: (spec: unknown) => string): string[] {
  const guard = (
    declared as unknown as {
      guard?: {
        context: { fields: Record<string, { type: unknown; required?: boolean; description?: string }> };
        refuses?: Record<string, string>;
        credentials?: Record<string, { type: unknown; yields: string[]; description?: string }>;
      };
    }
  ).guard;
  if (!guard) return [];
  const lines = ['guard: identifies callers before any policy runs', '  adds to request.*:'];
  for (const [name, field] of Object.entries(guard.context.fields)) lines.push(fieldLine(name, field, showType));
  for (const [reason, why] of Object.entries(guard.refuses ?? {})) lines.push(`  refuses '${reason}': ${why}`);
  lines.push('  takes, where one trigger attaches one policy ("in"):');
  for (const [name, credential] of Object.entries(guard.credentials ?? {}))
    lines.push(
      `    ${name}: ${typeof credential.type === 'string' ? credential.type : showType(credential.type)}  yields request.${credential.yields.join(', request.')}${credential.description ? `  -- ${credential.description}` : ''}`,
    );
  return lines;
}

/** A shape: the document, who makes or writes values of it, and the invariants its values are held to. */
function shapeLines(doc: Loaded, scope: Scope, load: LoadResult): string[] {
  const lines = [JSON.stringify(doc.doc, null, 2)];
  const writers = [...graphWriters(load, doc.path, scope), ...bindingWriters(load, doc.path, scope)];
  if (writers.length) lines.push('made or written by (the attributes each gives):', ...writers);
  lines.push(...heldBy(load, doc.path, scope));
  lines.push(...overShape(doc.path, scope));
  return lines;
}

/** Every node of every graph that makes or writes values of this shape. */
function graphWriters(load: LoadResult, shape: string, scope: Scope): string[] {
  const out: string[] = [];
  for (const graph of load.registry.all('graph'))
    for (const node of graph.doc.nodes) {
      if (!('run' in node)) continue;
      const said = writerLine({ file: graph.path, where: node.id, run: node.run, given: node.in }, shape, scope);
      if (said) out.push(said);
    }
  return out;
}

/** Every binding operation that makes or writes values of this shape. */
function bindingWriters(load: LoadResult, shape: string, scope: Scope): string[] {
  const out: string[] = [];
  for (const binding of load.registry.all('binding'))
    for (const [name, op] of Object.entries(binding.doc.operations)) {
      if (!op.run) continue;
      const said = writerLine({ file: binding.path, where: name, run: op.run, given: op.in }, shape, scope);
      if (said) out.push(said);
    }
  return out;
}

/** The keys one literal value gives, when it is an object. */
const keysOf = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : [];

/** Which of one call's inputs the contract declares as this shape, and the keys each was given. */
function declaredAs(run: string, given: Record<string, unknown> | undefined, shape: string, scope: Scope) {
  const found = scope.op(run);
  if (typeof found === 'string') return [];
  const keys: string[] = [];
  for (const [name, field] of Object.entries(found.op.accepts ?? {}))
    if (typeof field.type === 'string' && scope.canon(field.type) === shape && given?.[name] !== undefined)
      keys.push(...keysOf(given[name]), '');
  return keys;
}

/**
 * Whether one call makes or writes values of this shape, and the keys it gives: one `type` field naming the shape
 * (object#make, session#set), or an input the contract declares as the shape (issue's attributes).
 */
function writerLine(
  call: { file: string; where: string; run: string; given: Record<string, unknown> | undefined },
  shape: string,
  scope: Scope,
): string | undefined {
  const byType = typeof call.given?.type === 'string' && scope.canon(call.given.type) === shape;
  const keys = byType ? [...keysOf(call.given?.values), ...keysOf(call.given?.value)] : [];
  const byContract = declaredAs(call.run, call.given, shape, scope);
  if (!byType && !byContract.length) return undefined;
  const named = [...keys, ...byContract].filter(Boolean);
  return `    ${call.file}#${call.where}  via ${call.run}${named.length ? `  (${named.join(', ')})` : ''}`;
}

/** Every collection of every store that keeps records of this shape, so a shape says where it is kept. */
function heldBy(load: LoadResult, shape: string, scope: Scope): string[] {
  const out: string[] = [];
  for (const store of load.registry.all('store'))
    for (const [name, collection] of Object.entries(store.doc.collections))
      if (scope.canon(collection.of) === shape) out.push(`held by  ${store.path}#${name}`);
  return out;
}

/** A policy: what decides it, what it can answer, and the triggers it gates. */
function policyLines(doc: Loaded, load: LoadResult): string[] {
  const lines: string[] = [];
  const declared = doc.doc as PolicyDoc;
  lines.push(`decides through  ${declared.decide.run}`);
  for (const [name, read] of Object.entries(declared.decide.in ?? {}))
    lines.push(`    ${name} ← ${typeof read === 'string' ? read : JSON.stringify(read)}`);
  lines.push('outcomes (allow is the decision answering):');
  for (const [reason, outcome] of Object.entries(declared.outcomes))
    lines.push(
      `    ${reason} → ${outcome.effect}${outcome.method ? ` (${outcome.method})` : ''}${outcome.description ? `  -- ${outcome.description}` : ''}`,
    );
  const gated = load.registry
    .all('trigger')
    .filter(trigger => (trigger.doc.policies ?? []).some(ref => load.resolve(policyPath(ref)) === doc.path));
  lines.push(
    gated.length
      ? `gates: ${gated.map(trigger => trigger.path).join(', ')}`
      : "gates: nothing yet -- name it under one trigger's policies",
  );
  return lines;
}

/**
 * A trigger: the document, the policies it attaches, what each gives the guard, and the invariants that hold
 * over it -- a rule stated once elsewhere is a rule about this trigger, and a reader of the trigger sees it.
 */
function triggerLines(doc: Loaded, scope: Scope): string[] {
  const declared = doc.doc as TriggerDoc;
  const lines = [JSON.stringify(doc.doc, null, 2)];
  if (declared.policies?.length) lines.push(`policies, in order: ${declared.policies.map(policyPath).join(', ')}`);
  for (const use of declared.policies ?? [])
    if (typeof use !== 'string' && use.in)
      for (const [name, read] of Object.entries(use.in))
        lines.push(`  gives the guard '${name}' read from ${JSON.stringify(read)}`);
  lines.push(...holdsLines(doc as Loaded<TriggerDoc>, scope));
  return lines;
}

/** The lines one document's kind adds, beyond what every kind says. */
function kindBody(doc: Loaded, load: LoadResult, scope: Scope, showType: (spec: unknown) => string): string[] {
  if (doc.kind === 'port') return portLines(doc, showType);
  if (doc.kind === 'trigger-kind' || doc.kind === 'connection-kind' || doc.kind === 'plugin')
    return kindLines(doc, showType);
  if (doc.kind === 'shape') return shapeLines(doc, scope, load);
  if (doc.kind === 'store') return storeLines(doc, load, scope);
  if (doc.kind === 'policy') return policyLines(doc, load);
  if (doc.kind === 'trigger') return triggerLines(doc, scope);
  if (doc.kind === 'invariant') return invariantLines(doc, scope);
  if (doc.kind === 'graph') return graphLines(doc, scope);
  return [JSON.stringify(doc.doc, null, 2)];
}

/** Who granted one document: the plugin that ships it, or the tree it was included from. */
function grantLine(doc: { native?: string; included?: string }, from: string | undefined): string[] {
  if (doc.native) return [`granted by  ${doc.native}${from ? `  (${from})` : '  (built into the runtime)'}`];
  return doc.included ? [`included from  ${doc.included}`] : [];
}

/** One document said in full: where it lives, who granted it, what it describes, and what its kind adds. */
export function describe(load: LoadResult, ref: string): string {
  const scope = new Scope(load.registry, load.resolve);
  const { path } = splitOp(ref.includes('#') ? ref : `${ref}#`);
  const doc = scope.any(path || ref);
  if (!doc) return `no document at '${ref}'`;
  // one native document is one plugin's: say which, and the package it came from, so who implements it is not one code detail
  const from = doc.native ? scope.project?.plugins.find(plugin => plugin.use === doc.native)?.from : undefined;
  const grantedBy = grantLine(doc, from);
  const lines = [
    `${doc.kind}  ${doc.path}`,
    ...(doc.file ? [`file  ${doc.file}`] : []),
    ...grantedBy,
    doc.doc.description,
    '',
  ];
  const showType = shower(scope);
  lines.push(...kindBody(doc, load, scope, showType));
  return lines.join('\n');
}

/** trigger → graph → ports → bindings → graphs, as one tree. */
/** Where one node of one graph leads: one switch's routes, one native operation, or the binding that meets it. */
function nodeLines(node: Record<string, unknown>, indent: string, scope: Scope): { lines: string[]; into?: string } {
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
    return { lines: [`${indent}  ${id} ${run}${effect}${storeTail(run, node.in as Record<string, unknown>, scope)}`] };
  }
  const binding = scope.bindingFor(found.path);
  const lines = [`${indent}  ${id} ${run}`];
  if (typeof binding === 'string') return { lines: [...lines, `${indent}    ?? ${binding}`] };
  const op = binding.doc.operations[found.opName];
  lines.push(`${indent}    ${binding.path}#${found.opName}${op?.run ? ` → ${op.run}` : ''}`);
  return { lines, into: op?.graph };
}

/** What one walk of the map carries: the scope it reads, the graphs it has written, and every graph it reached. */
interface Walk {
  scope: Scope;
  /** Written once per trigger, so a graph two triggers reach is drawn under each. */
  seen: Set<string>;
  /** Shared across the whole map: what is left over is the orphans. */
  reached: Set<string>;
}

/**
 * One graph and everything it reaches, indented; one graph already seen is named but not walked again. A graph
 * whose effects move together is marked where the map names it, so a reader of the tree sees the transaction
 * without opening the document.
 */
function mappedGraph(ref: string, indent: string, walk: Walk): string[] {
  const graph = walk.scope.get('graph', ref);
  if (!graph) return [`${indent}?? ${ref}`];
  walk.reached.add(graph.path);
  const lines = [`${indent}${graph.path}${graph.doc.atomic ? '  [atomic]' : ''}`];
  if (walk.seen.has(graph.path)) return lines;
  walk.seen.add(graph.path);
  for (const node of graph.doc.nodes) {
    const said = nodeLines(node as unknown as Record<string, unknown>, indent, walk.scope);
    lines.push(...said.lines);
    if (said.into) lines.push(...mappedGraph(said.into, `${indent}      `, walk));
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

/** What each binding of the port one trigger fires meets it with, and the graph behind it. */
function firesLines(trigger: Loaded<TriggerDoc>, load: LoadResult, reached: Set<string>, scope: Scope): string[] {
  const port = load.registry.get('port', load.resolve(trigger.doc.fire.run.split('#')[0]));
  const opName = trigger.doc.fire.run.split('#')[1];
  const lines = [`  ${trigger.doc.fire.run}`];
  if (!port) return lines;
  for (const binding of load.registry.all('binding').filter(one => load.resolve(one.doc.port) === port.path)) {
    const op = binding.doc.operations[opName];
    if (op?.graph) lines.push(...mappedGraph(op.graph, '    ', { scope, seen: new Set(), reached }));
    else if (op?.run) lines.push(`    ${binding.path}#${opName} → ${op.run}`);
  }
  return lines;
}

/**
 * Every trigger of the tree, everything each one reaches, and the graphs nothing reaches. The graphs reached
 * are gathered as the walk goes rather than read back off its lines: a line carries marks beside the path
 * (`[atomic]`), and a graph must not become an orphan because of how it is written down.
 */
export function map(load: LoadResult): string[] {
  const scope = new Scope(load.registry, load.resolve);
  const lines: string[] = [];
  const reached = new Set<string>();
  for (const trigger of load.registry.all('trigger')) {
    lines.push(`${trigger.path}  (${trigger.doc.kind})`);
    lines.push(...gateLines(trigger, scope));
    // under the gates, since an invariant is a rule about what those gates must be, not another gate
    lines.push(...holdsLines(trigger, scope));
    lines.push(...firesLines(trigger, load, reached, scope));
  }
  for (const graph of load.registry.all('graph')) if (!reached.has(graph.path)) lines.push(`orphan  ${graph.path}`);
  return lines;
}
