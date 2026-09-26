/**
 * What a reader is told about an atomic graph: that it is atomic, the one connection its transaction falls
 * on, which of its nodes take part, and the reasons that roll it back. `wilanis describe`, `wilanis map` and
 * the viewer all ask this, so all three say the same thing and none of them re-derives it.
 *
 * Nothing here judges. The checker has already refused a graph whose effects could not be one transaction
 * (L009, L010, L011, G014); this reads the same per-profile walk to say what the surviving graph does. Where
 * the profiles disagree about the connection -- a port bound to one store under `local` and another under
 * `production` -- every one they reach is named, since a reader chooses a profile before running.
 *
 * It reads the same profiles L009 and L010 are judged under -- those whose bindings name the graph behind an
 * operation the profile runs (`profilesReaching`) -- so what a reader is told is what the tree was held to. A
 * profile that never runs the graph, a worker that opens no route among them, would otherwise add a connection no
 * run of it can fall on.
 *
 * Where no profile reaches the graph it falls back to all of them, which is the one place it parts from the
 * checker and on purpose: the checker is deciding what to refuse and says nothing of an unreached graph,
 * while a reader has opened the document and is owed what it says. L011 has already refused such a graph
 * where it reaches nothing transactional, so what is described here is a graph waiting to be bound.
 */
import type { GraphDoc, Loaded, Scope } from '@wilanis/core';
import { atomicReachOf, profilesReaching } from './check/atomic-reach.js';
import { Serving } from './check/served.js';
import { refusalsOfGraph } from './refusals.js';

/** What one atomic graph commits, where, and what undoes it. */
export interface AtomicSaid {
  /** The connections the transaction may fall on: one, where every profile agrees, and never none in a checked tree. */
  connections: string[];
  /**
   * The ids of this graph's own nodes that take part, in the order the document writes them. A data graph's
   * are the nodes that run a transactional operation; a domain graph's are the nodes whose operations lead to
   * one through the profile's binding, since the effect itself is written in the data graph below.
   */
  participants: string[];
  /** The reasons a declared refusal below it rolls the transaction back on, sorted, without repeats. */
  rollsBackOn: string[];
}

/** What the transaction falls on and which nodes take part, gathered over every profile's walk. */
function transactionOf(scope: Scope, graph: Loaded<GraphDoc>, profiles: (string | undefined)[]) {
  const connections = new Set<string>();
  const participants = new Set<string>();
  for (const profile of profiles) {
    for (const effect of atomicReachOf(scope, graph, profile).effects) {
      if (!effect.transactional) continue;
      if (effect.connection) connections.add(effect.connection);
      participants.add(effect.from);
    }
  }
  return { connections, participants };
}

/** Every reason a declared refusal below the graph can give, over every profile: what rolls the transaction back. */
function reasonsOf(scope: Scope, graph: Loaded<GraphDoc>, profiles: (string | undefined)[]): Set<string> {
  const reasons = new Set<string>();
  for (const profile of profiles)
    for (const refusal of refusalsOfGraph(scope, graph.path, profile)) reasons.add(refusal.reason);
  return reasons;
}

/**
 * What one graph's `atomic` means, or nothing where the graph does not declare it. The walk is made once per
 * profile, since which binding meets an operation is a profile's choice, and the answers are gathered: a node
 * takes part where any profile's walk reaches a transactional effect at it.
 */
export function atomicOf(scope: Scope, graph: Loaded<GraphDoc>): AtomicSaid | undefined {
  if (graph.doc.atomic !== true) return undefined;
  const declared = scope.profiles();
  const all: (string | undefined)[] = declared.length ? declared : [undefined];
  // a graph no profile reaches is still described by its own contents, rather than by nothing at all
  const reaching = profilesReaching(scope, graph, all, new Serving(scope));
  const profiles = reaching.length ? reaching : all;
  const { connections, participants } = transactionOf(scope, graph, profiles);
  return {
    connections: [...connections].sort(),
    participants: graph.doc.nodes.map(node => node.id).filter(id => participants.has(id)),
    rollsBackOn: [...reasonsOf(scope, graph, profiles)].sort(),
  };
}
