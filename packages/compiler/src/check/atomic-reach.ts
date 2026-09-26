/**
 * The walk below an atomic graph: every effect, map and retry it reaches under one profile. An effect node of
 * the graph itself, or -- for a domain graph -- an effect node of the graph its operations are bound to under
 * the profile, followed through nested domain operations; it is the walk `refusalsReachable` makes for
 * reasons, asked for what a transaction holds instead. The rules over it live in `atomic.ts`, and a reader is
 * told what it found in `atomic-said.ts`; neither walks again.
 */
import { type GraphDoc, isMap, isSwitch, type Loaded, type Retry, type Scope, type Values } from '@wilanis/core';
import { connectionOf } from '../documents.js';

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

/**
 * A retry written below an atomic graph: a node of a graph the walk entered, or the operation of a binding
 * that met a domain operation called inside it. What G020 judges.
 */
export interface ReachedRetry {
  /** The graph or binding the word is written in. */
  file: string;
  /** `nodes/<id>` or `operations/<op>`: the word is at `<at>/retry`. */
  at: string;
}

/** Everything the walk found below one atomic graph: the effects it reaches, the maps and the retries among them. */
export interface AtomicReach {
  effects: Reached[];
  maps: ReachedMap[];
  retries: ReachedRetry[];
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
export function atomicReachOf(scope: Scope, graph: Loaded<GraphDoc>, profile: string | undefined): AtomicReach {
  const walk = new Walk(scope, profile);
  walk.graph(graph, undefined);
  return walk.found;
}

/**
 * One walk below one atomic graph. `seen` is over graphs, so a graph reached twice is walked once and a cycle
 * ends rather than recurring -- the same guard `refusalsReachable` keeps.
 */
class Walk {
  readonly found: AtomicReach = { effects: [], maps: [], retries: [] };
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
      // a domain graph writes no retry at all, which L012 says, so only a data graph's node is kept
      if (this.scope.roleOf(graph.path) === 'data') this.retried(node.retry, graph.path, `nodes/${node.id}`);
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
    this.retried(bound.retry, binding.path, `operations/${hit.opName}`);
    if (bound.graph) {
      const graph = this.scope.registry.get('graph', this.scope.canon(bound.graph));
      if (graph) this.graph(graph, from);
      return;
    }
    if (bound.run) this.call({ run: bound.run, given: bound.in, file: binding.path, node: hit.opName, from });
  }

  /** Keep a retry written at one place the walk passed through; a place that says none adds nothing. */
  private retried(retry: Retry | undefined, file: string, at: string): void {
    if (retry) this.found.retries.push({ file, at });
  }
}

/**
 * Whether a domain `path#operation` runs under a profile, as the profile's one walk answers it: unless only
 * triggers the profile does not serve reach it (`Judge.judgedUnder`, `Serving.judgedUnder`).
 */
export interface Running {
  judgedUnder(key: string, profile: string | undefined): boolean;
}

/**
 * The profiles that run one graph: those whose chosen binding lists it behind an operation the profile runs. A
 * profile chooses a binding by naming it, and a port met by exactly one binding is chosen by every profile, so
 * `bindingFor` answers the choice either way; whether the profile runs the operation is `running`'s answer,
 * read off the walk `reachOf` makes from the triggers the profile walks (`walkedUnder`), so a graph only routes
 * reach is not run under a profile that never listens. An operation nothing reaches at all is run wherever its
 * binding is chosen, so a graph waiting for its trigger is still judged.
 *
 * This is the set L009 and L010 are judged under. A profile that never runs a graph has nothing to be
 * refused for: the graph's effects are only reached through a binding, and a binding a profile does not
 * choose, or chooses for an operation nothing it serves calls, is a binding whose graph it never runs. The test
 * is over the bindings rather than over `atomicReachOf`, which walks the document's own nodes and so answers the
 * same under every profile.
 */
export function profilesReaching(
  scope: Scope,
  graph: Loaded<GraphDoc>,
  profiles: (string | undefined)[],
  running: Running,
): (string | undefined)[] {
  return profiles.filter(profile =>
    scope.registry.all('binding').some(binding => {
      const port = scope.canon(binding.doc.port);
      if (scope.bindingFor(port, profile) !== binding) return false;
      return Object.entries(binding.doc.operations).some(
        ([name, op]) =>
          op.graph && scope.canon(op.graph) === graph.path && running.judgedUnder(`${port}#${name}`, profile),
      );
    }),
  );
}
