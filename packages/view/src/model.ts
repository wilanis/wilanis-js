/**
 * The view model: what a page needs to draw one document. For a graph, nodes with typed input and output
 * ports, a data edge for every {{node.field}} read from the field to the input that reads it, one rule node per
 * switch rule with a route from it, the out node's fields, and for each run or map node where its operation leads (a
 * native port, or a binding and the graph behind it). A deep read ({{asked.body.id}}) opens the field it
 * reads as an attribute port under its parent, so the edge leaves the attribute. The request a data graph
 * reads through its resolvers is a node of its own, its ports the paths the resolvers name.
 *
 * For every kind, the references the document makes and the documents that make references to it, so a
 * reader can walk the tree in both directions, and for a few the thing the document cannot say about itself:
 * which triggers an invariant binds, which engine keeps a store's records. Nothing here draws; it answers JSON
 * a page lays out.
 */

import { checkTree } from '@wilanis/compiler';
import type { GraphDoc, Kind, Loaded, LoadResult, PolicyDoc, Refusal, TriggerDoc } from '@wilanis/core';
import { policyPath, SCHEMA_BASE, Scope, WILANIS } from '@wilanis/core';
import { attemptsOf } from './attempts.js';
import { graphView } from './graphs.js';
import { invariantView } from './invariants.js';
import { stemOf, targetOf } from './ports.js';
import { callersOf, type IndexedRef, referenceIndex } from './references.js';
import { answersOf } from './refusals.js';
import { viewsRequiredBy } from './scopes.js';
import { storeView } from './stores.js';
import type { DocView, VAttachedPolicy } from './types.js';
import { labelOf, readable } from './types.js';

export * from './types.js';

// ---- schemas --------------------------------------------------------------------------------------

/** A schema's path inside core's schemas directory: a kind's, or a node type's under node/. */
const SCHEMA_REL = /^(?:node\/)?[a-z-]+\.schema\.json$/;

/**
 * The schema a reference names, relative to core's schemas directory, in either form a document may write
 * it: the alias (@wilanis/node/run.schema.json) or the published URL. Undefined for anything else.
 */
export function schemaRelOf(ref: unknown): string | undefined {
  if (typeof ref !== 'string') return undefined;
  for (const prefix of [`${WILANIS}/`, `${SCHEMA_BASE}/`]) {
    if (ref.startsWith(prefix) && SCHEMA_REL.test(ref.slice(prefix.length))) return ref.slice(prefix.length);
  }
  return undefined;
}

/** One schema as a page: what it judges, where it is published, and the schema itself. */
export interface SchemaView {
  kind: 'schema';
  /** The alias a document writes: @wilanis/graph.schema.json. */
  path: string;
  /** The path inside core's schemas directory: node/run.schema.json. */
  rel: string;
  /** The document kind this schema judges, when it is a kind's schema and not a node type's or a shared one. */
  judges?: Kind;
  label: string;
  description: string;
  /** Where the schema is published. */
  url: string;
  /** The file it was read from, when known. */
  file?: string;
  schema: unknown;
}

/** The view of one schema, read from core's schemas directory. */
export function schemaViewOf(rel: string, schema: unknown, file?: string): SchemaView {
  const doc = (schema ?? {}) as { title?: string; description?: string };
  const kind =
    rel.includes('/') || rel === 'common.schema.json' ? undefined : (rel.replace(/\.schema\.json$/, '') as Kind);
  return {
    kind: 'schema',
    path: `${WILANIS}/${rel}`,
    rel,
    judges: kind,
    label: doc.title ?? rel,
    description: doc.description ?? '',
    url: `${SCHEMA_BASE}/${rel}`,
    file,
    schema,
  };
}

/** What a port's bindings meet it with: the graph or the native operation behind each of its operations. */
function implementationsOf(scope: Scope, path: string) {
  return scope.bindingsFor(path).map(binding => ({
    path: binding.path,
    label: labelOf(binding),
    operations: Object.fromEntries(
      Object.entries(binding.doc.operations).map(([name, operation]) => {
        const graph = operation.graph ? scope.get('graph', operation.graph) : undefined;
        const met = { graph: graph?.path, graphLabel: graph ? labelOf(graph) : undefined, run: operation.run };
        return [name, { ...met, ...attemptsOf(operation) }];
      }),
    ),
  }));
}

/**
 * The policies a trigger attaches, in order, what each is given, and which of them a view it reaches requires:
 * a view is the one way across a scope, so the attachment that is its `behind` is the one the author could not
 * have dropped, and the page says so rather than leaving a reader to find A008 by removing it.
 */
function policiesOf(scope: Scope, trigger: TriggerDoc): VAttachedPolicy[] {
  const required = viewsRequiredBy(scope, trigger);
  return (trigger.policies ?? []).map(use => {
    const ref = policyPath(use);
    const policy = scope.get('policy', ref);
    const path = policy?.path ?? scope.canon(ref);
    const views = required.get(path);
    return {
      path,
      label: policy ? labelOf(policy) : readable(stemOf(ref)),
      decide: policy?.doc.decide.run ?? '',
      ...(typeof use !== 'string' && use.in ? { gives: use.in } : {}),
      ...(views?.length ? { required: views } : {}),
    };
  });
}

/** What a trigger adds to its view: where it fires, what it answers, and the policies that gate it. */
function triggerView(scope: Scope, doc: Loaded, view: DocView) {
  const trigger = doc.doc as TriggerDoc;
  view.fires = targetOf(scope, trigger.fire.run).target;
  view.answers = answersOf(scope, doc as Loaded<TriggerDoc>);
  if (trigger.policies?.length) view.policies = policiesOf(scope, trigger);
}

/** What a policy adds to its view: what decides it, what it can answer, and the triggers it gates. */
function policyView(scope: Scope, doc: Loaded, view: DocView) {
  const policy = doc.doc as PolicyDoc;
  view.decides = targetOf(scope, policy.decide.run).target;
  view.outcomes = policy.outcomes;
  if (policy.proves?.length) view.proves = policy.proves;
  view.gates = scope.registry
    .all('trigger')
    .filter(trigger => (trigger.doc.policies ?? []).some(ref => scope.canon(policyPath(ref)) === doc.path))
    .map(trigger => ({ path: trigger.path, label: labelOf(trigger) }));
}

/**
 * What every view of one tree reads and no document owns: the scope, every reference in the tree, and every
 * refusal the checker made. Made once and handed to each `viewOf`, so a site of many pages checks the tree once.
 */
export interface TreeReads {
  scope: Scope;
  index: IndexedRef[];
  refusals: Refusal[];
}

/** The reads every view of a loaded tree shares: its scope, the reference index over it, and the checker's refusals. */
export function treeReadsOf(load: LoadResult): TreeReads {
  const scope = new Scope(load.registry, load.resolve);
  return { scope, index: referenceIndex(load, scope), refusals: checkTree(load).items };
}

/** What every kind carries: where it sits, what it says, and the references it makes and receives. */
function baseView(reads: TreeReads, doc: Loaded): DocView {
  const { scope, index, refusals } = reads;
  return {
    path: doc.path,
    kind: doc.kind,
    name: doc.name,
    label: labelOf(doc),
    feature: doc.feature,
    layer: doc.layer,
    native: doc.native,
    included: doc.included,
    from: doc.native ? scope.project?.plugins.find(plugin => plugin.use === doc.native)?.from : undefined,
    file: doc.file,
    description: doc.doc.description,
    doc: doc.doc,
    refs: index
      .filter(reference => reference.from === doc.path)
      .map(reference => ({
        path: reference.to,
        label: labelOf(scope.registry.any(reference.to)),
        kind: reference.kind,
        at: reference.at,
      })),
    callers: callersOf(doc.path, index, scope),
    refusals: refusals.filter(refusal => refusal.file === doc.path || `@${refusal.file}` === doc.path),
  };
}

/**
 * The view of one document by path (an alias is accepted); undefined when there is no such document. A caller
 * drawing many documents of one tree hands in its `treeReadsOf` once, rather than checking the tree per view.
 */
export function viewOf(load: LoadResult, ref: string, reads: TreeReads = treeReadsOf(load)): DocView | undefined {
  const { scope } = reads;
  const doc = scope.any(ref);
  if (!doc) return undefined;
  const view = baseView(reads, doc);
  if (doc.kind === 'graph') view.graph = graphView(scope, doc as Loaded<GraphDoc>);
  if (doc.kind === 'port') view.implementations = implementationsOf(scope, doc.path);
  if (doc.kind === 'trigger') triggerView(scope, doc, view);
  if (doc.kind === 'policy') policyView(scope, doc, view);
  if (doc.kind === 'store') view.store = storeView(scope, load, doc);
  if (doc.kind === 'invariant') view.invariant = invariantView(scope, doc);
  return view;
}
