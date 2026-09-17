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
import {
  bindingLines,
  codecLines,
  connectionLines,
  featureLines,
  projectLines,
  resolversLines,
  scenarioLines,
} from './doc-said.js';
import { graphLines } from './graph-said.js';
import { holdsLines, invariantLines } from './invariant-lines.js';
import { fieldLine, portLines, shower, storeLines } from './lines.js';
import { shapeLines } from './shape-said.js';
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
  return [
    `kind  ${declared.kind}`,
    ...settingLines(declared.settings),
    ...crossesLines(declared),
    ...fireLines(declared),
    ...gatedLines(declared),
    ...holdsLines(doc as Loaded<TriggerDoc>, scope),
  ];
}

/** What crosses the edge at this trigger: the shape it takes from the caller, and the one it answers in. */
function crossesLines(declared: TriggerDoc): string[] {
  return [...(declared.in ? [`takes   ${declared.in}`] : []), ...(declared.out ? [`answers ${declared.out}`] : [])];
}

/** The domain operation this trigger fires, and where each of its inputs is read from. */
function fireLines(declared: TriggerDoc): string[] {
  const reads = Object.entries(declared.fire.in ?? {});
  return [
    `fires   ${declared.fire.run}`,
    ...reads.map(([name, read]) => `    ${name} ← ${typeof read === 'string' ? read : JSON.stringify(read)}`),
  ];
}

/** The policies gating this trigger, in order, and the credentials each attachment gives the guard. */
function gatedLines(declared: TriggerDoc): string[] {
  if (!declared.policies?.length) return [];
  const lines = [`policies, in order: ${declared.policies.map(policyPath).join(', ')}`];
  for (const use of declared.policies)
    for (const [name, read] of Object.entries((typeof use === 'string' ? undefined : use.in) ?? {}))
      lines.push(`  gives the guard '${name}' read from ${JSON.stringify(read)}`);
  return lines;
}

/** Whether a setting's value has parts of its own worth their own lines, rather than fitting on one. */
const nested = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * What a trigger's kind is configured with, a setting to a line, and a setting with parts of its own opened
 * one level -- which is where a reader looks for the status a kind answers with and the refusals it maps.
 */
function settingLines(settings: Record<string, unknown> | undefined): string[] {
  const entries = Object.entries(settings ?? {});
  if (!entries.length) return [];
  const lines = ['settings:'];
  for (const [name, value] of entries) {
    if (!nested(value)) lines.push(`    ${name}: ${JSON.stringify(value)}`);
    else {
      lines.push(`    ${name}:`);
      for (const [part, held] of Object.entries(value)) lines.push(`        ${part}: ${JSON.stringify(held)}`);
    }
  }
  return lines;
}

/**
 * The lines one document's kind adds, beyond what every kind says. Every kind has a body: none falls back to
 * the raw JSON, since a reader who wanted the file has its path on the line above and what they asked
 * `describe` for is what the document means.
 */
function kindBody(doc: Loaded, load: LoadResult, scope: Scope, showType: (spec: unknown) => string): string[] {
  if (doc.kind === 'port') return portLines(doc, showType);
  if (doc.kind === 'trigger-kind' || doc.kind === 'connection-kind' || doc.kind === 'plugin')
    return kindLines(doc, showType);
  if (doc.kind === 'shape') return shapeLines(doc, scope, load, showType);
  if (doc.kind === 'store') return storeLines(doc, load, scope);
  if (doc.kind === 'policy') return policyLines(doc, load);
  if (doc.kind === 'trigger') return triggerLines(doc, scope);
  if (doc.kind === 'invariant') return invariantLines(doc, scope);
  if (doc.kind === 'graph') return graphLines(doc, scope);
  return plainBody(doc);
}

/** The kinds whose body is the document read back in words: each says what it means, none prints its JSON. */
function plainBody(doc: Loaded): string[] {
  if (doc.kind === 'binding') return bindingLines(doc);
  if (doc.kind === 'resolvers') return resolversLines(doc);
  if (doc.kind === 'feature') return featureLines(doc);
  if (doc.kind === 'connection') return connectionLines(doc);
  if (doc.kind === 'codec') return codecLines(doc);
  if (doc.kind === 'scenario') return scenarioLines(doc);
  if (doc.kind === 'project') return projectLines(doc);
  return [];
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
