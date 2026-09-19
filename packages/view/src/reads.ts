/**
 * What a graph or a binding reads from the request, and the one node that stands for it. A document names each read
 * under `reads` -- a local name bound to a resolver of a resolvers document (RFC 0029) -- so the request node draws
 * one port per name, labelled as the document reads it and opening the document that declares it. Two features'
 * resolvers are two `opens` on one node, which is why the document sits on the port and not on the node.
 */
import type { GraphDoc, Scope } from '@wilanis/core';
import { splitPath, splitRef } from '@wilanis/core';
import type { VEdge, VNode } from './types.js';
import { labelOf } from './types.js';

/** One name under a document's `reads`: where it lands in the request, and the resolvers document that declares it. */
export interface Read {
  /** The segments below `request` the resolver reads, which name the port the edge leaves. */
  path: string[];
  /** The local name the document reads it by, which the port shows. */
  label: string;
  /** The resolvers document that declares it, canonical, which the port opens. */
  opens: string;
  description?: string;
}

/**
 * What a reader sees under the port: the resolver's own label and what it says it reads, in that order. The port's
 * label is the name the document reads by, so a resolver that declares a label has nowhere else to say it -- and a
 * resolver may declare either, both or neither, so the two are joined and nothing is dropped.
 */
function saying(resolver: { label?: string; description?: string }): string | undefined {
  return [resolver.label, resolver.description].filter(Boolean).join('. ') || undefined;
}

/** Every name under a `reads` map, resolved: where it lands in the request, and which document declares it. */
export function readsOf(scope: Scope, reads: GraphDoc['reads']): Map<string, Read> {
  const out = new Map<string, Read>();
  for (const [name, ref] of Object.entries(reads ?? {})) {
    const { path, op } = splitRef(ref);
    const doc = scope.get('resolvers', path);
    const resolver = doc?.doc.resolvers[op];
    if (!doc || !resolver) continue;
    out.set(name, {
      path: splitPath(resolver.read).slice(1),
      label: name,
      opens: doc.path,
      description: saying(resolver),
    });
  }
  return out;
}

/** The resolvers documents a graph reads through, labelled, each named once however many reads came from it. */
function through(scope: Scope, reads: Map<string, Read>): string {
  const labels = new Set<string>();
  for (const read of reads.values()) labels.add(labelOf(scope.get('resolvers', read.opens)));
  return [...labels].join(', ');
}

/**
 * The request node, when a read goes through a resolver and something reads it. Its ports are opened later, by the
 * deep reads that leave it; `markRequestPorts` then says what each one is.
 */
export function requestNode(scope: Scope, reads: Map<string, Read>, edges: VEdge[]): VNode | undefined {
  if (!reads.size || !edges.some(edge => edge.from === 'request')) return undefined;
  return {
    id: 'request',
    kind: 'request',
    label: 'Request',
    description: `what the trigger kind hands, read through ${through(scope, reads)}`,
    inputs: [],
    outputs: [],
  };
}

/**
 * The request node's ports carry the name the document reads them by, and open the document that declares it:
 * `{{agent}}` is labelled `agent` and opens the resolvers document its `reads` entry pointed at.
 */
export function markRequestPorts(request: VNode | undefined, reads: Map<string, Read>) {
  if (!request) return;
  for (const read of reads.values()) {
    const port = request.outputs.find(one => one.name === read.path.join('.'));
    if (!port) continue;
    port.label = read.label;
    port.opens = read.opens;
    // only when the resolver says something: an absent description is no key, never a key holding nothing
    if (read.description) port.description = read.description;
  }
}
