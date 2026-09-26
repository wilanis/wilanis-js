/**
 * The reach of a profile: what a tree does where it runs (RFC 0013). A profile chooses which binding meets
 * each domain port, and from that choice follows everything effectful the tree runs there -- every native
 * operation that is not pure, the connections those name, the secrets those connections and the plugins read,
 * and what it holds open. `reachOf` derives it as one pure function over the loaded tree, so `wilanis start`,
 * `describe`, RFC 0016's rule and RFC 0026's manifest all read one answer.
 *
 * The walk below it is shared: `reachOf` is one reader of `Walk` and `opNeeds` (check/resolvers.ts) is
 * another -- one traversal, two payloads. Each step hands whoever listens the graph it entered, the delegation
 * a binding wrote, or the native site it ended at, and the reader keeps what it is after.
 */
import {
  type BindingDoc,
  type BindingOp,
  type GraphDoc,
  isSwitch,
  type Loaded,
  type Operation,
  policyPath,
  runsUnder,
  type Scope,
  splitRef,
  type TriggerDoc,
  type Values,
} from '@wilanis/core';
import { connectionOf } from './documents.js';

/**
 * One call the walk follows: what it names, what it gives, where it is written, and what it descended from.
 * `R` is whatever a reader wants carried from the root down to every site below it: `reachOf` carries the
 * `Root` it started at, and a reader of one operation alone carries nothing.
 */
export interface Call<R> {
  run: string;
  given: Values | undefined;
  /** The document the call is written in: a graph, a binding, a trigger, a policy, the project or a manifest. */
  file: string;
  /** The node, binding operation or field that makes the call. */
  node: string;
  /** The canonical path of the binding the walk last passed through; nothing above the first. */
  binding: string | undefined;
  root: R;
}

/** One native call site the walk ends at: the call, the canonical `path#operation` it names, and the contract. */
export interface NativeSite<R> extends Call<R> {
  key: string;
  op: Operation;
}

/**
 * Whoever reads the walk: told each domain operation followed (its canonical `path#operation`), each graph
 * entered, each delegation a binding writes, and each native site.
 */
export interface Listener<R> {
  operation?(key: string): void;
  graph?(graph: Loaded<GraphDoc>): void;
  delegation?(binding: Loaded<BindingDoc>, opName: string, bound: BindingOp): void;
  native?(site: NativeSite<R>): void;
}

/**
 * One traversal under one profile: from a call through the binding `bindingFor` chooses, into the graph it
 * runs or the operation it delegates to, and on through every domain call. `seen` is over graphs, so a graph
 * reached twice is walked once and a cycle ends rather than recurring; what a listener learns of a graph is
 * one way in and not every one.
 */
export class Walk<R> {
  private readonly seen = new Set<string>();

  constructor(
    private readonly scope: Scope,
    private readonly profile: string | undefined,
    private readonly listener: Listener<R>,
  ) {}

  /**
   * Follow an operation named for its own sake -- what a trigger fires, a policy decides through, a plugin
   * requires or a step runs -- with nothing given: it is written at its port, since no site of the tree calls it.
   */
  operation(opRef: string, root: R): void {
    const { path, op } = splitRef(opRef);
    this.follow({ run: opRef, given: undefined, file: path || opRef, node: op || opRef, binding: undefined, root });
  }

  /** Follow one call: a native operation ends here, a domain one goes on through whatever meets it. */
  follow(call: Call<R>): void {
    const hit = this.scope.op(call.run);
    if (typeof hit === 'string') return;
    if (hit.port.native) {
      this.listener.native?.({ ...call, key: `${hit.path}#${hit.opName}`, op: hit.op });
      return;
    }
    this.listener.operation?.(`${hit.path}#${hit.opName}`);
    const binding = this.scope.bindingFor(hit.path, this.profile);
    if (typeof binding === 'string') return;
    const bound = binding.doc.operations[hit.opName];
    if (!bound) return;
    if (bound.graph) this.graph(this.scope.canon(bound.graph), binding.path, call.root);
    else if (bound.run) {
      this.listener.delegation?.(binding, hit.opName, bound);
      const { run, in: given } = bound;
      this.follow({ run, given, file: binding.path, node: hit.opName, binding: binding.path, root: call.root });
    }
  }

  /** Every node of a graph, each call followed on through whatever meets it. */
  private graph(graphPath: string, binding: string, root: R): void {
    if (this.seen.has(graphPath)) return;
    this.seen.add(graphPath);
    const graph = this.scope.registry.get('graph', graphPath);
    if (!graph) return;
    this.listener.graph?.(graph);
    for (const node of graph.doc.nodes) {
      if (isSwitch(node)) continue;
      this.follow({ run: node.run, given: node.in, file: graph.path, node: node.id, binding, root });
    }
  }
}

/** Where a walk of the reach began: what fires, decides through, requires or runs the operation, and which. */
export interface Root {
  kind: 'trigger' | 'policy' | 'required' | 'startup';
  /** The trigger, the policy, the requiring plugin's manifest, or the project. */
  file: string;
  /** The `path#operation` the root names, as it writes it. */
  run: string;
}

/** One native operation that is not pure the profile runs: what, from which root, through which binding. */
export interface ReachedNative {
  /** The canonical `path#operation`. */
  key: string;
  root: Root;
  /** The canonical path of the binding it was reached through, or nothing where the root names it directly. */
  binding: string | undefined;
  /** The canonical connection its `in` names, directly or through a store; nothing where it names none. */
  connection: string | undefined;
  /** Running it starts something that outlives the run. */
  holds: boolean;
  /** The graph, binding or project the site is written in, and the node, operation or step that names it. */
  file: string;
  node: string;
}

/** One `{{secrets.<key>}}` the profile reads: the key, the variable the project maps it to, and who reads it. */
export interface ReachedSecret {
  key: string;
  /** The variable `project.json → secrets` names for the key; nothing where the key is undeclared (C001, B007). */
  variable: string | undefined;
  /** The connection document that reads it, `<plugin> settings`, or `<the project document> → startup/<index>`. */
  readBy: string;
}

/** Everything a profile reaches: the effectful operations, the connections they name, what holds, what is read. */
export interface Reach {
  /** Every native operation that is not pure, one entry per site reached, in the order the walk found them. */
  operations: ReachedNative[];
  /** The canonical connections those sites name, each once, in order of first reach. */
  connections: string[];
  /** The `holds` operations among them, by canonical key, each once. */
  holds: string[];
  /** Every secret read by a reached connection's settings, by any plugin's settings, or by a startup step's `in`. */
  secrets: ReachedSecret[];
}

/**
 * The reach of one profile, pure over the loaded tree. Its roots are the `fire` of every trigger the profile
 * walks (`walkedUnder`: its startup serves the trigger, or no profile's does), every policy such a trigger
 * attaches, every operation of a port a plugin requires (RFC 0005), and every startup step that runs under the
 * profile (`startup[].profiles`); a route under a profile that never listens, and a policy only such routes
 * attach, run nowhere there and are not walked. A connection a site names is the one `connectionFor` reaches
 * under the profile: a stand-in replaces what it stands in for, and its settings are the ones whose secrets the
 * reach reads.
 */
export function reachOf(scope: Scope, profile: string | undefined): Reach {
  return rooted(new Reaching(scope, profile)).done();
}

/**
 * Whether a profile walks a trigger: the profile serves it (`servedUnder`), or no profile the project declares
 * does, so a tree that listens nowhere -- a library checked alone, a route whose step is not written yet -- is
 * walked whole rather than not at all. `reachOf` starts at the triggers this answers yes for, the checker judges
 * a trigger under the profiles it answers yes for (`Judge.profilesServing`), and `rehearse`, `fuzz`, `regress`
 * and `run` fire a trigger under a profile only where it does. A project that declares no profile walks every
 * trigger under its one unnamed profile.
 */
export function walkedUnder(scope: Scope, trigger: TriggerDoc, profile: string | undefined): boolean {
  if (servedUnder(scope, trigger, profile)) return true;
  return !scope.profiles().some(one => servedUnder(scope, trigger, one));
}

/**
 * The profiles that walk a trigger, in the project's order: each declared one `walkedUnder` answers yes for, or
 * the one unnamed profile of a project that declares none. The checker judges a trigger under these
 * (`Judge.profilesServing`), and whatever explains a rule made per trigger -- `describe`, `map`, the viewer --
 * walks the same list, so a reader is never shown what a profile that does not serve the trigger would reach.
 */
export function profilesWalking(scope: Scope, trigger: TriggerDoc): (string | undefined)[] {
  const declared = scope.profiles();
  return declared.length ? declared.filter(profile => walkedUnder(scope, trigger, profile)) : [undefined];
}

/** The domain operations one profile's walk reaches, canonical `path#operation`s, split by what reached them. */
export interface OperationsReached {
  /** Those `reachOf`'s roots reach: the triggers the profile walks, their policies, the required ports, the steps. */
  walked: Set<string>;
  /** Those only the triggers the profile does not walk reach, with the policies they attach. */
  beyond: Set<string>;
}

/**
 * Every domain operation a profile's walk reaches, split by whether one of `reachOf`'s roots reaches it or only
 * a trigger the profile does not walk does. It is one walk: from `reachOf`'s roots, then on from the triggers
 * left out, and a graph the roots entered is not entered again, so what the second leg finds is what only those
 * triggers reach. B011 reads it (`check/served.ts`): an operation only `beyond` reaches is not held to its
 * promise under the profile, since nothing the profile runs calls it.
 */
export function operationsReachedBy(scope: Scope, profile: string | undefined): OperationsReached {
  const reaching = rooted(new Reaching(scope, profile));
  const walked = new Set(reaching.domain);
  reaching.triggers(false);
  return { walked, beyond: new Set([...reaching.domain].filter(key => !walked.has(key))) };
}

/**
 * Whether a profile serves a trigger: some startup step that runs under the profile names a `holds` operation of
 * the plugin that grants the trigger's kind. The link is the plugin's manifest, which grants both -- a route kind
 * beside the server that listens, a queue kind beside the worker that consumes -- so no kind is named here, and a
 * kind a new plugin grants beside its own `holds` operation follows the same rule. A kind whose plugin grants no
 * `holds` operation is served by no startup step (`wilanis run` fires a command-line trigger), so it is served
 * under every profile. What the step is given is not read: a step that consumes some queues serves, as far as
 * this says, every queue trigger.
 */
export function servedUnder(scope: Scope, trigger: TriggerDoc, profile: string | undefined): boolean {
  const servers = serversOf(scope, trigger.kind);
  if (!servers.length) return true;
  return (scope.project?.startup ?? []).some(
    step => runsUnder(step, profile) && servers.includes(canonical(scope, step.run)),
  );
}

/** A `path#operation` with the path made canonical, or the reference as written where it names nothing (B006). */
function canonical(scope: Scope, opRef: string): string {
  const hit = scope.op(opRef);
  return typeof hit === 'string' ? opRef : `${hit.path}#${hit.opName}`;
}

/** The `holds` operations that serve a trigger kind, canonical: those of the ports the plugin granting the kind grants. */
function serversOf(scope: Scope, kindRef: string): string[] {
  const kind = scope.get('trigger-kind', kindRef);
  const manifest = kind?.native ? scope.registry.get('plugin', `${kind.native}/plugin.json`) : undefined;
  const servers: string[] = [];
  for (const ref of manifest?.doc.grants.ports ?? []) {
    const port = scope.get('port', ref);
    if (!port) continue;
    for (const [name, op] of Object.entries(port.doc.operations)) if (op.holds) servers.push(`${port.path}#${name}`);
  }
  return servers;
}

/** The canonical path of every graph a profile's walk enters, from the roots `reachOf` starts at, each once. */
export function graphsReachedBy(scope: Scope, profile: string | undefined): string[] {
  const graphs: string[] = [];
  rooted(new Reaching(scope, profile, graphs));
  return graphs;
}

/** One reader walked from every root: the triggers it walks, their policies, the required ports, the startup steps. */
function rooted(reaching: Reaching): Reaching {
  reaching.triggers();
  reaching.required();
  reaching.startup();
  return reaching;
}

/** The reader of the walk that gathers a profile's reach: the roots it starts at, and what it keeps of each site. */
class Reaching implements Listener<Root> {
  /** Every domain operation the walk followed, canonical, for a reader after the ports rather than the effects. */
  readonly domain = new Set<string>();
  private readonly found: Reach = { operations: [], connections: [], holds: [], secrets: [] };
  private readonly secretIds = new Set<string>();
  /** Each policy whose `decide` was walked, so none is walked twice whichever trigger attached it. */
  private readonly attached = new Set<string>();
  private readonly walk: Walk<Root>;
  private readonly projectPath: string;

  constructor(
    private readonly scope: Scope,
    private readonly profile: string | undefined,
    /** Where each graph entered is written, for a reader after the graphs rather than the effects. */
    private readonly graphs?: string[],
  ) {
    this.walk = new Walk(scope, profile, this);
    this.projectPath = scope.registry.project?.path ?? 'project.json';
  }

  /** A domain operation followed: kept by its canonical `path#operation`. */
  operation(key: string): void {
    this.domain.add(key);
  }

  /** A graph entered: its path kept where a reader asked for the graphs; the walk enters each once. */
  graph(entered: Loaded<GraphDoc>): void {
    this.graphs?.push(entered.path);
  }

  /** A native site: kept where its operation is not pure, with the connection its inputs name. */
  native(site: NativeSite<Root>): void {
    if (site.op.pure === true) return;
    const connection = this.standingIn(connectionOf(this.scope, site.op, site.given));
    const holds = site.op.holds === true;
    const { key, root, binding, file, node } = site;
    this.found.operations.push({ key, root, binding, connection, holds, file, node });
    if (connection && !this.found.connections.includes(connection)) this.found.connections.push(connection);
    if (holds && !this.found.holds.includes(key)) this.found.holds.push(key);
  }

  /** The connection a named one reaches under the profile: its stand-in, else itself where the stand-in is unknown (R001). */
  private standingIn(named: string | undefined): string | undefined {
    if (!named) return undefined;
    const reached = this.scope.connectionFor(named, this.profile);
    return typeof reached === 'string' ? named : reached.path;
  }

  /**
   * The `fire` of every trigger the profile walks (`walkedUnder`) -- or, told `walked` false, of every one it does
   * not -- and the `decide` of every policy one of them attaches, each policy once.
   */
  triggers(walked = true): void {
    for (const trigger of this.scope.registry.all('trigger')) {
      if (walkedUnder(this.scope, trigger.doc, this.profile) !== walked) continue;
      const { fire, policies } = trigger.doc;
      const root: Root = { kind: 'trigger', file: trigger.path, run: fire.run };
      this.walk.follow({ run: fire.run, given: fire.in, file: trigger.path, node: 'fire', binding: undefined, root });
      for (const ref of policies ?? []) {
        const policy = this.scope.get('policy', policyPath(ref));
        if (!policy || this.attached.has(policy.path)) continue;
        this.attached.add(policy.path);
        this.decide(policy.path, policy.doc.decide);
      }
    }
  }

  /** One attached policy's `decide`, a root of its own: what it runs is walked whichever trigger attached it. */
  private decide(file: string, decide: { run: string; in?: Values }): void {
    const root: Root = { kind: 'policy', file, run: decide.run };
    this.walk.follow({ run: decide.run, given: decide.in, file, node: 'decide', binding: undefined, root });
  }

  /** Every operation of every port a plugin requires: the plugin fires them itself, through the profile's binding. */
  required(): void {
    for (const port of this.scope.registry.all('port')) {
      if (!port.requiredBy) continue;
      const file = `${port.requiredBy}/plugin.json`;
      for (const opName of Object.keys(port.doc.operations)) {
        const run = `${port.path}#${opName}`;
        const root: Root = { kind: 'required', file, run };
        this.walk.follow({ run, given: undefined, file, node: 'requires/ports', binding: undefined, root });
      }
    }
  }

  /** Every startup step that runs under the profile: what it runs, and the secrets its `in` reads. */
  startup(): void {
    for (const [index, step] of (this.scope.project?.startup ?? []).entries()) {
      if (!runsUnder(step, this.profile)) continue;
      const root: Root = { kind: 'startup', file: this.projectPath, run: step.run };
      const node = `startup/${index}`;
      this.walk.follow({ run: step.run, given: step.in, file: this.projectPath, node, binding: undefined, root });
      this.secretsIn(step.in, `${this.projectPath} → ${node}`);
    }
  }

  /** The reach once every root is walked: the secrets the reached connections and the plugins read join it. */
  done(): Reach {
    for (const path of this.found.connections) {
      const connection = this.scope.registry.get('connection', path);
      if (connection) this.secretsIn(connection.doc.settings, connection.path);
    }
    for (const use of this.scope.project?.plugins ?? []) this.secretsIn(use.settings, `${use.use} settings`);
    return this.found;
  }

  /** Every `{{secrets.<key>}}` a value reads, each once per reader, with the variable the project maps it to. */
  private secretsIn(value: unknown, readBy: string): void {
    for (const [root, key] of this.scope.templateReads(value)) {
      if (root !== 'secrets' || key === undefined || this.secretIds.has(`${key}|${readBy}`)) continue;
      this.secretIds.add(`${key}|${readBy}`);
      this.found.secrets.push({ key, variable: this.scope.project?.secrets?.[key], readBy });
    }
  }
}
