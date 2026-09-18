/**
 * What a run can reach, found statically. One walk answers every question asked of it: from an operation
 * through the binding that meets it, into the graph it runs or the operation it delegates to, and on through
 * every domain call. `refusalsReachable` reads the literal reasons off that walk -- the checker holds triggers
 * and policies to them (T005, T006, A002, A003) and the viewer shows them -- `operationsReachable` reads
 * the domain operations, which is what an invariant over a port is judged against (RFC 0007), and
 * `effectsReachable` reads the native sites the walk ends at, with what each was given.
 *
 * A guarded site is a reason of the graph it sits in, the same as a `refuse` node an author wrote: the compiler
 * lowers a refusal there, so `invariant` is a word every trigger reaching it must map (T005) and none reaching
 * no guard may map (T006). A proved site adds nothing, which is what makes proving a rule worth the trouble.
 */
import { isSwitch, policyPath, type Scope, type TriggerDoc, type Values } from '@wilanis/core';
import { guardsOf, INVARIANT } from './guard.js';

/** One refusal a port operation can end in: the literal reason, the graph (or binding) that calls refuse, and the node (or binding operation) that does. */
export interface ReachableRefusal {
  reason: string;
  file: string;
  node: string;
}

/** One domain operation a run reaches: the canonical `path#operation`, and the operation that called it. */
export interface ReachedOperation {
  /** The canonical `path#operation` the run names. */
  key: string;
  /**
   * The canonical operation whose binding led here, or nothing for the one the walk started at. A refusal
   * about an operation a trigger did not fire says which one it was reached through, rather than leaving a
   * reader to walk the bindings themselves. It is one way in and not every one: a graph reached twice is
   * walked once, so what is answered is that the operation is reachable and a path by which it is.
   */
  through: string | undefined;
}

/**
 * One native call site a run reaches: what it names, what it was given there, and where it is written. A rule
 * about an effect is judged over these -- whether a retried call is idempotent (RFC 0011), or which collection
 * a storage site is over (RFC 0015) -- so the values given at the site travel with it, unlowered: `store` and
 * `collection` are read here the way `idempotent` reads a key, off what the document says.
 */
export interface ReachedEffect {
  /** The canonical `path#operation` of the native operation the site names. */
  key: string;
  /** What the site gives, as the document writes it: a literal where one was written, a template where one was. */
  given: Values | undefined;
  /** The graph or binding the site is written in. */
  file: string;
  /** The node, or the binding's operation name, that names it. */
  node: string;
  /**
   * The canonical domain operation whose binding led here, or nothing where the walk started in the graph
   * that holds the site. A rule that names the profile names this too, so a reader is not left to walk the
   * bindings by hand.
   */
  through: string | undefined;
}

/** One call the walk follows: what it names, what it gives, where it is written, and what it is called from. */
interface Call {
  run: string;
  given: Values | undefined;
  file: string;
  node: string;
  /** The canonical domain operation whose binding this call is written under; nothing at the top of a graph walk. */
  through: string | undefined;
}

/**
 * Every reason a run of `opRef` can refuse with under a profile: the walk goes through the binding that meets
 * the operation, into the graph it runs or the operation it delegates to, and on through every domain call.
 */
export function refusalsReachable(scope: Scope, opRef: string, profile?: string): ReachableRefusal[] {
  return new Walk(scope, profile).fromOperation(opRef).refusals;
}

/**
 * Every domain operation a run of `opRef` can reach under a profile, `opRef` itself among them: the same walk
 * the reasons are found by, asked what it called rather than what it can say. A trigger reaches what its
 * `fire.run` reaches; a policy's `decide.run` is a gate rather than a way in, so nothing walks it here.
 */
export function operationsReachable(scope: Scope, opRef: string, profile?: string): ReachedOperation[] {
  return new Walk(scope, profile).fromOperation(opRef).operations;
}

/**
 * Every native call site a run of `opRef` can reach under a profile, with what each was given: the same walk
 * the reasons and the operations are found by, asked what it ends at rather than what it passed through. A
 * domain operation is a way on and never an effect itself; what does the work is the native site its bindings
 * reach, which is what a rule about an effect is judged over.
 */
export function effectsReachable(scope: Scope, opRef: string, profile?: string): ReachedEffect[] {
  return new Walk(scope, profile).fromOperation(opRef).effects;
}

/**
 * Every native call site one graph can reach, for a reader who has the graph rather than the operation it
 * answers -- a trigger's `fire.run` is walked as an operation, but a rule over a data graph starts here.
 */
export function effectsOfGraph(scope: Scope, graphPath: string, profile?: string): ReachedEffect[] {
  return new Walk(scope, profile).fromGraph(graphPath).effects;
}

/**
 * Every reason a trigger can be answered with: what it fires, what each of its policies decides through,
 * and -- when an attachment gives the guard a credential -- the guard's own reasons, a credential that does not
 * verify among them.
 */
export function refusalsOfTrigger(scope: Scope, trigger: TriggerDoc, profile?: string): ReachableRefusal[] {
  const out = refusalsReachable(scope, trigger.fire.run, profile);
  for (const ref of trigger.policies ?? []) {
    const policy = scope.get('policy', policyPath(ref));
    if (policy) out.push(...refusalsReachable(scope, policy.doc.decide.run, profile));
  }
  const guard = scope.guard();
  const gives = (trigger.policies ?? []).some(use => typeof use !== 'string' && Object.keys(use.in ?? {}).length);
  if (gives && guard) {
    for (const reason of Object.keys(guard.doc.guard?.refuses ?? {}))
      out.push({ reason, file: guard.path, node: 'identify' });
  }
  return out;
}

/**
 * Every reason a run of one graph can refuse with: its own refusing nodes' literal reasons, and whatever the
 * domain operations it calls reach under the profile. `describe` says them of an atomic graph, since they are
 * exactly what rolls its transaction back.
 */
export function refusalsOfGraph(scope: Scope, graphPath: string, profile?: string): ReachableRefusal[] {
  return new Walk(scope, profile).fromGraph(graphPath).refusals;
}

/**
 * One walk below one operation or graph, under one profile. It gathers both of the things a reader asks of it
 * at once, since both are read off the same steps: the literal reasons its refusing calls give, and the domain
 * operations it passed through. `seen` is over graphs, so a graph reached twice is walked once and a cycle ends
 * rather than recurring.
 */
class Walk {
  readonly refusals: ReachableRefusal[] = [];
  readonly operations: ReachedOperation[] = [];
  readonly effects: ReachedEffect[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly scope: Scope,
    private readonly profile: string | undefined,
  ) {}

  /** Walk from a domain operation: itself reached, then whatever the profile's binding meets it with. */
  fromOperation(opRef: string): this {
    this.operation(opRef, undefined);
    return this;
  }

  /** Walk from one graph, for a reader who has the graph rather than the operation it answers. */
  fromGraph(graphPath: string): this {
    this.graph(graphPath, undefined);
    return this;
  }

  /**
   * One domain operation: recorded as reached, then followed into the graph its binding runs or the operation
   * it delegates to. A native operation is not a way in and is not recorded.
   */
  private operation(opRef: string, through: string | undefined): void {
    const hit = this.scope.op(opRef);
    if (typeof hit === 'string' || hit.port.native) return;
    const key = `${hit.path}#${hit.opName}`;
    this.operations.push({ key, through });
    const binding = this.scope.bindingFor(hit.path, this.profile);
    if (typeof binding === 'string') return;
    const bound = binding.doc.operations[hit.opName];
    if (!bound) return;
    if (bound.graph) {
      this.graph(this.scope.canon(bound.graph), key);
      return;
    }
    if (bound.run) this.call({ run: bound.run, given: bound.in, file: binding.path, node: hit.opName, through: key });
  }

  /**
   * Every node of a graph, each call followed on through whatever meets it. `through` is the operation the
   * binding met with this graph: what a call of it was reached through.
   */
  private graph(graphPath: string, through: string | undefined): void {
    if (this.seen.has(graphPath)) return;
    this.seen.add(graphPath);
    const graph = this.scope.registry.get('graph', graphPath);
    if (!graph) return;
    for (const guard of guardsOf(this.scope, graph))
      this.refusals.push({ reason: INVARIANT, file: graph.path, node: guard.id });
    for (const node of graph.doc.nodes) {
      if (isSwitch(node)) continue;
      this.call({ run: node.run, given: node.in, file: graph.path, node: node.id, through });
    }
  }

  /**
   * One call site: the literal reason where the operation refuses, the site itself where what it names is
   * native, else the operation followed on. A native site is recorded here rather than in `operation`, because
   * what a rule about an effect asks of it -- what was given at the site, and where it is written -- is known
   * to the caller and not to the operation it names.
   */
  private call(call: Call): void {
    const hit = this.scope.op(call.run);
    if (typeof hit === 'string') return;
    if (hit.op.refuses) {
      const reason = call.given?.reason;
      if (typeof reason === 'string' && this.scope.literal(reason))
        this.refusals.push({ reason, file: call.file, node: call.node });
      return;
    }
    if (hit.port.native) {
      const key = `${hit.path}#${hit.opName}`;
      this.effects.push({ key, given: call.given, file: call.file, node: call.node, through: call.through });
      return;
    }
    this.operation(call.run, call.through);
  }
}
