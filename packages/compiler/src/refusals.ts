/**
 * What a run can reach, found statically. One walk answers both questions asked of it: from an operation
 * through the binding that meets it, into the graph it runs or the operation it delegates to, and on through
 * every domain call. `refusalsReachable` reads the literal reasons off that walk -- the checker holds triggers
 * and policies to them (T005, T006, A002, A003) and the viewer shows them -- and `operationsReachable` reads
 * the domain operations, which is what an invariant over a port is judged against (RFC 0007).
 */
import { isSwitch, policyPath, type Scope, type TriggerDoc, type Values } from '@wilanis/core';

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
    for (const node of graph.doc.nodes) {
      if (isSwitch(node)) continue;
      this.call({ run: node.run, given: node.in, file: graph.path, node: node.id, through });
    }
  }

  /** One call site: the literal reason where the operation refuses, else the operation followed on. */
  private call(call: Call): void {
    const hit = this.scope.op(call.run);
    if (typeof hit === 'string') return;
    if (hit.op.refuses) {
      const reason = call.given?.reason;
      if (typeof reason === 'string' && this.scope.literal(reason))
        this.refusals.push({ reason, file: call.file, node: call.node });
      return;
    }
    this.operation(call.run, call.through);
  }
}
