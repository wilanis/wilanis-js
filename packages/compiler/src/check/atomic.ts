/**
 * What an atomic graph reaches. A graph that says `atomic` declares that its effects commit or roll back
 * together, and every rule about one is a rule about the set of effects below it: whether each can take part
 * in a transaction (L009), whether they fall on one connection (L010), whether there is any at all (L011),
 * and whether a map among them collects failures the transaction has already ended (G014).
 *
 * "Reaches" is the walk `refusalsReachable` makes for reasons, asked for effects instead: an effect node of
 * the graph itself, or -- for a domain graph -- an effect node of the graph its operations are bound to under
 * the profile being judged, followed through nested domain operations. It is made per profile, since which
 * binding meets an operation is what a profile chooses.
 */
import { type GraphDoc, isMap, isSwitch, type Loaded, type Operation, type Scope, type Values } from '@wilanis/core';
import { type Judge, underProfiles } from './judge.js';

/**
 * The canonical connection a transactional call goes to, or nothing where the call does not say. It is read
 * from one of the two static fields such an operation accepts (C009): `connection`, a connection document's
 * path, or `store`, the path of a store document that names one.
 *
 * It stays quiet throughout. A field that is absent, or names a document that is not there, is the business
 * of the rules that judge the call site and the store itself (R001 from `checkStore`), so a tree with one
 * fault answers one refusal rather than the same fault told twice.
 */
export function connectionOf(scope: Scope, op: Operation, given: Values | undefined): string | undefined {
  const named = (field: string): string | undefined => {
    const value = given?.[field];
    return op.accepts?.[field]?.static && typeof value === 'string' ? value : undefined;
  };
  const direct = named('connection');
  if (direct) return scope.get('connection', direct) ? scope.canon(direct) : undefined;
  const store = named('store');
  const doc = store ? scope.get('store', store) : undefined;
  return doc ? scope.canon(doc.doc.connection) : undefined;
}

/** One effect an atomic graph reaches: what it runs, where that call is written, and whether it may take part. */
export interface Reached {
  /** The canonical `path#operation` the call names. */
  key: string;
  /** The operation as the port declares it, for the flags a rule reads. */
  transactional: boolean;
  /** The connection it goes to, where the call says statically; nothing where it says none. */
  connection: string | undefined;
  /** The document the call is written in, and the node of it that makes the call. */
  file: string;
  node: string;
  /**
   * The node of the atomic graph itself that this effect descended from: the node a reader can point at.
   * For a data graph's own effect it is `node` again; for a domain graph it is the run or map node whose
   * operation the profile's binding met with the graph the effect is written in.
   */
  from: string;
}

/** A map an atomic graph reaches, and what it does with an element that fails: what G014 judges. */
export interface ReachedMap {
  onItemFailure: string | undefined;
  file: string;
  node: string;
}

/** Everything the walk found below one atomic graph: the effects it reaches, and the maps among them. */
export interface Reach {
  effects: Reached[];
  maps: ReachedMap[];
}

/** One call the walk follows: what it names, what it gives, and where it is written. */
interface Call {
  run: string;
  given: Values | undefined;
  file: string;
  node: string;
  /** The node of the atomic graph this call descended from; a node of the graph itself is its own. */
  from: string;
}

/**
 * Everything one atomic graph reaches under one profile. The walk carries what every step of it needs -- the
 * judge, the profile it is made under, the graphs already walked and what has been found -- so that no step
 * has to be handed them one by one.
 */
export function reachOf(scope: Scope, graph: Loaded<GraphDoc>, profile: string | undefined): Reach {
  const walk = new Walk(scope, profile);
  walk.graph(graph, undefined);
  return walk.found;
}

/**
 * One walk below one atomic graph. `seen` is over graphs, so a graph reached twice is walked once and a cycle
 * ends rather than recurring -- the same guard `refusalsReachable` keeps.
 */
class Walk {
  readonly found: Reach = { effects: [], maps: [] };
  private readonly seen = new Set<string>();

  constructor(
    private readonly scope: Scope,
    private readonly profile: string | undefined,
  ) {}

  /**
   * Every node of a graph, each call followed on through whatever meets it. `from` is the node of the atomic
   * graph the walk descended from, and is nothing at the top: there each node stands for itself.
   */
  graph(graph: Loaded<GraphDoc>, from: string | undefined): void {
    if (this.seen.has(graph.path)) return;
    this.seen.add(graph.path);
    for (const node of graph.doc.nodes) {
      if (isSwitch(node)) continue;
      if (isMap(node)) this.found.maps.push({ onItemFailure: node.onItemFailure, file: graph.path, node: node.id });
      this.call({ run: node.run, given: node.in, file: graph.path, node: node.id, from: from ?? node.id });
    }
  }

  /**
   * One call site: a native operation is an effect the set keeps (a pure one is no effect at all), and a
   * domain operation is followed into whatever the profile's binding meets it with.
   */
  private call(call: Call): void {
    const hit = this.scope.op(call.run);
    if (typeof hit === 'string') return;
    if (!hit.port.native) {
      this.bound(call.run, call.from);
      return;
    }
    if (hit.op.pure === true) return;
    this.found.effects.push({
      key: `${hit.path}#${hit.opName}`,
      transactional: hit.op.transactional === true,
      connection: connectionOf(this.scope, hit.op, call.given),
      file: call.file,
      node: call.node,
      from: call.from,
    });
  }

  /** What a domain operation is met by under this profile: a graph to walk, or another operation to follow. */
  private bound(opRef: string, from: string): void {
    const hit = this.scope.op(opRef);
    if (typeof hit === 'string') return;
    const binding = this.scope.bindingFor(hit.path, this.profile);
    if (typeof binding === 'string') return;
    const bound = binding.doc.operations[hit.opName];
    if (!bound) return;
    if (bound.graph) {
      const graph = this.scope.registry.get('graph', this.scope.canon(bound.graph));
      if (graph) this.graph(graph, from);
      return;
    }
    if (bound.run) this.call({ run: bound.run, given: bound.in, file: binding.path, node: hit.opName, from });
  }
}

/** The graphs of a tree that declare their effects move together: what every rule here is about. */
const atomicGraphs = (scope: Scope): Loaded<GraphDoc>[] =>
  scope.registry.all('graph').filter(graph => graph.doc.atomic === true);

/** One fault found by the per-profile walk: where it is, what it says, and the profiles that reached it. */
interface Fault {
  file: string;
  at: string;
  message: (profiles: string) => string;
  hint: string;
  profiles: (string | undefined)[];
}

/**
 * The faults one rule found across the profiles, each answered once. The walk is made per profile because
 * which binding meets an operation is a profile's choice, but a fault the walk finds is a fault of one
 * document at one node: keying it by where it is collapses the profiles that agree into the one refusal
 * `connectionOf` promises, and keeps the profiles that found it so the message can name them.
 */
class Faults {
  private readonly byPlace = new Map<string, Fault>();

  /** Remember a fault at one place, adding the profile to the one already there. */
  found(key: string, fault: Omit<Fault, 'profiles'>, profile: string | undefined): void {
    const already = this.byPlace.get(key);
    if (already) {
      already.profiles.push(profile);
      return;
    }
    this.byPlace.set(key, { ...fault, profiles: [profile] });
  }

  /** Refuse once per place, the message naming every profile that found it. */
  refuse(judge: Judge, code: string): void {
    for (const fault of this.byPlace.values()) {
      judge.refuser(fault.file)(code, fault.message(underProfiles(fault.profiles)), fault.at, fault.hint);
    }
  }
}

/**
 * The refusals over every atomic graph of a tree: an effect that cannot take part (L009), effects on more
 * than one connection (L010), no transactional effect at all (L011), and a map that collects what a failed
 * element has already ended (G014).
 *
 * Every rule reads the same per-profile walks, since which binding meets an operation is what a profile
 * chooses. One fault still answers one refusal: L009 and L010 gather what the profiles found by where it is
 * and name the profiles that reached it, so a fault under one profile alone names that profile and a fault
 * every profile shares is said once. L011 and G014 are judged over the union of the walks: a graph that
 * reaches a write under one profile and none under another is not one with nothing to roll back.
 */
export function checkAtomic(judge: Judge): void {
  for (const graph of atomicGraphs(judge.scope)) {
    const walks = judge.profiles().map(profile => ({ profile, reach: reachOf(judge.scope, graph, profile) }));
    const participants = new Faults();
    const connections = new Faults();
    for (const { profile, reach } of walks) {
      checkParticipants(participants, graph, reach, profile);
      checkOneConnection(connections, graph, reach, profile);
    }
    participants.refuse(judge, 'L009');
    connections.refuse(judge, 'L010');
    const reaches = walks.map(walk => walk.reach);
    checkSomethingToRollBack(judge, graph, reaches);
    checkCollectingMaps(judge, graph, reaches);
  }
}

/** L009: every effect an atomic graph reaches can take part in a transaction. */
function checkParticipants(found: Faults, graph: Loaded<GraphDoc>, reach: Reach, profile: string | undefined): void {
  for (const effect of reach.effects) {
    if (effect.transactional) continue;
    found.found(
      `${effect.file}#${effect.node}`,
      {
        file: effect.file,
        at: `nodes/${effect.node}`,
        message: profiles =>
          `atomic graph '${graph.path}' reaches '${effect.key}', which cannot take part in a transaction${profiles}`,
        hint: 'read or send that outside the transaction: in the caller for a domain graph, in a graph of its own for a data graph',
      },
      profile,
    );
  }
}

/** L010: one transaction is one connection, so every transactional effect reached falls on the same one. */
function checkOneConnection(found: Faults, graph: Loaded<GraphDoc>, reach: Reach, profile: string | undefined): void {
  const connections = [...new Set(reach.effects.filter(effect => effect.transactional).map(one => one.connection))];
  const named = connections.filter((one): one is string => one !== undefined);
  if (named.length < 2) return;
  found.found(
    `${graph.path}#${named.join(', ')}`,
    {
      file: graph.path,
      at: 'atomic',
      message: profiles =>
        `atomic graph reaches effects on ${named.length} connections (${named.join(', ')})${profiles}`,
      hint: 'one transaction is one connection; split the graph, or move both stores to one connection',
    },
    profile,
  );
}

/** L011: a graph says atomic only where something it reaches could roll back. */
function checkSomethingToRollBack(judge: Judge, graph: Loaded<GraphDoc>, walks: Reach[]): void {
  if (walks.some(reach => reach.effects.some(effect => effect.transactional))) return;
  judge.refuser(graph.path)(
    'L011',
    'atomic graph reaches no effect that can take part in a transaction',
    'atomic',
    'nothing here can roll back; delete "atomic"',
  );
}

/** G014: a failed element ends the transaction, so a map below an atomic graph cannot collect its failure. */
function checkCollectingMaps(judge: Judge, graph: Loaded<GraphDoc>, walks: Reach[]): void {
  const seen = new Set<string>();
  for (const reach of walks) {
    for (const map of reach.maps) {
      if (map.onItemFailure !== 'collect' || seen.has(`${map.file}#${map.node}`)) continue;
      seen.add(`${map.file}#${map.node}`);
      judge.refuser(map.file)(
        'G014',
        `map '${map.node}' collects failures inside atomic graph '${graph.path}', whose transaction a failed element ends`,
        `nodes/${map.node}/onItemFailure`,
        'use "fail", or take the map out of the atomic graph',
      );
    }
  }
}
