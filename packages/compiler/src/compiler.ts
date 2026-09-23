/**
 * The compiler: a checked tree in, kernel specs out. Every path#operation becomes a handler -- a plugin's
 * native function, or a nested spec for a domain port's binding (delegation or data graph). A node's `in`
 * lowers to kernel sources (lower.ts). Secret paths are marked.
 *
 * Only run this on a tree `checkTree` accepted; the compiler assumes every rule held.
 */
import {
  type BindingDoc,
  type BindingOp,
  expr,
  type GraphDoc,
  isRun,
  isSwitch,
  type Loaded,
  type Node,
  type Operation,
  type OpHit,
  type PluginModule,
  type Scope,
  splitPath,
  splitRef,
  type Type,
  type TypeSpec,
} from '@wilanis/core';
import {
  type Handler,
  type Handlers,
  type KCall,
  Kernel,
  type KernelSpec,
  type KNode,
  type KSource,
} from '@wilanis/engine';
import { inScope } from './atomic.js';
import { attempting, type Sites, tagSite } from './attempts.js';
import { type Compiled, type CompileOptions, nestedFailure } from './compiled.js';
import { type CallSite, outputCandidates, passedInputs } from './documents.js';
import { type GuardHandlers, guardsOf, MAKE, REFUSE, TAKEN_IDS } from './guard.js';
import { lowerGuards } from './guard-lowering.js';
import { bindPaths, inputsByName, lowerScope, lowerValue, lowerValues, type Roots, redactOf, SCOPE } from './lower.js';

/**
 * Lowers a checked tree to what the kernel runs: the spec of a graph, or of the binding that meets a domain
 * port operation under the chosen profile, with every path#operation resolved to a handler. Handlers
 * accumulate across calls, so one Kernel runs any spec it compiled. It assumes `checkTree` already accepted.
 */
export class Compiler {
  private readonly handlers: Handlers = {};
  private readonly bindingSpecs = new Map<string, KernelSpec>();
  /** the nested spec of each list site's guard, by the name `guardSpecName` gave it and its `map` calls it by */
  private readonly guardSpecs = new Map<string, KernelSpec>();
  /** what each call tagged with a site says about retrying and bounding it; every handler reads it (attempts.ts) */
  private readonly sites: Sites = new Map();

  constructor(
    readonly scope: Scope,
    private readonly plugins: PluginModule[],
    private readonly opts: CompileOptions = {},
  ) {}

  /** Compile a graph by path. Handlers accumulate across calls so one Kernel can run any compiled spec. */
  graph(ref: string): Compiled {
    const graph = this.scope.get('graph', ref);
    if (!graph) throw new Error(`unknown graph '${ref}'`);
    return { spec: this.lowerGraph(graph), handlers: this.handlers };
  }

  /**
   * Compile a domain port operation by path#operation: the spec of the binding that meets it under the
   * chosen profile. This is what a trigger fires -- it names what it wants done, never how.
   */
  operation(opRef: string): Compiled {
    const hit = this.scope.op(opRef);
    if (typeof hit === 'string') throw new Error(hit);
    if (hit.port.native && hit.op.holds) return { spec: this.holdsSpec(hit), handlers: this.handlers };
    if (hit.port.native) throw new Error(`'${opRef}' is a native operation; a trigger fires a domain port`);
    const binding = this.scope.bindingFor(hit.path, this.opts.profile);
    if (typeof binding === 'string') throw new Error(binding);
    return { spec: this.lowerBindingOp(binding, hit), handlers: this.handlers };
  }

  /**
   * A `holds` operation starts something that outlives the run: it is a plugin's own, has no binding to choose
   * between, and only a project's startup list names it. It compiles to the one call it is.
   */
  private holdsSpec(hit: OpHit): KernelSpec {
    const op: KCall = {
      kind: 'call',
      handler: this.nativeHandler(hit),
      in: inputsByName(Object.keys(hit.op.accepts ?? {})),
    };
    return { name: `${hit.path}#${hit.opName}`, nodes: { op }, output: hit.op.returns ? ['op'] : undefined };
  }

  // ---- handlers -----------------------------------------------------------------------------------

  /** The handler of a native operation: the plugin's function, or the effect stub when one is set and the operation is effectful. */
  private nativeHandler(hit: OpHit): string {
    const key = `${hit.path}#${hit.opName}`;
    if (this.handlers[key]) return key;
    const stub = hit.op.pure !== true ? this.opts.stubEffects : undefined;
    if (stub) {
      this.handlers[key] = this.attempting(
        stub({
          path: hit.path,
          opName: hit.opName,
          op: hit.op,
          returns: this.quietType(hit.op.returns),
        }),
      );
      return key;
    }
    const plugin = this.plugins.find(candidate => candidate.handlers[key]);
    if (!plugin) throw new Error(`no plugin implements '${key}'`);
    this.handlers[key] = this.attempting(plugin.handlers[key]);
    return key;
  }

  private quietType(spec: TypeSpec | undefined): Type | undefined {
    try {
      return spec ? this.scope.types.spec(spec) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The handler behind path#operation. Domain ports become nested specs through their binding. */
  private handlerFor(opRef: string): { handler: string; op: Operation } {
    const hit = this.scope.op(opRef);
    if (typeof hit === 'string') throw new Error(hit);
    if (hit.port.native) return { handler: this.nativeHandler(hit), op: hit.op };
    const binding = this.scope.bindingFor(hit.path, this.opts.profile);
    if (typeof binding === 'string') throw new Error(binding);
    const key = `${binding.path}#${hit.opName}`;
    this.handlers[key] ??= this.attempting(this.nestedRunner(this.lowerBindingOp(binding, hit)));
    return { handler: key, op: hit.op };
  }

  /** A handler the compiler registers, tried as the site of each call says (RFC 0011); at no site, once. */
  private attempting(base: Handler): Handler {
    return attempting(base, this.sites);
  }

  /**
   * A handler that runs a nested spec with the caller's `in` and forwards request, stubs, clock and env. A graph that
   * takes its input whole (an `in` that is not a shape) is handed it under the one key `in`, and unwraps it.
   */
  private nestedRunner(spec: KernelSpec, whole = false, atomic = false): Handler {
    return async ({ in: input, ctx }) => {
      const initial = { in: whole ? input.in : input, ...(ctx.request !== undefined ? { request: ctx.request } : {}) };
      const once = (env: Record<string, unknown>) =>
        new Kernel(this.handlers).run(spec, {
          initial,
          stubs: ctx.stubs,
          signal: ctx.signal,
          clock: ctx.clock,
          env,
          nodePath: ctx.nodePath,
        });
      const report = atomic ? await inScope(ctx.env, once) : await once(ctx.env);
      ctx.attach(report);
      if (report.status !== 'done') throw nestedFailure(spec, report);
      return report.output;
    };
  }

  // ---- lowering -----------------------------------------------------------------------------------

  /**
   * A graph as the kernel runs it. Its nodes are lowered exactly as written, and then each site a field
   * invariant could not be proved at is guarded: the rule becomes a switch, the value it lets through keeps
   * the id the node had, and the branch it refuses on is the reason `invariant` (RFC 0007).
   */
  private lowerGraph(graph: Loaded<GraphDoc>): KernelSpec {
    const doc = graph.doc;
    const consts = Object.fromEntries(
      Object.entries(doc.constants ?? {}).map(([name, constant]) => [name, constant.value]),
    );
    const guards = guardsOf(this.scope, graph);
    const roots: Roots = { resolvers: this.resolverRoots(doc.reads), consts, nodes: true };
    // a guarded taken site puts the judged value at `in:ok`, so every authored {{in}} reads it instead
    if (guards.some(guard => guard.site.kind === 'taken')) roots.aliases = { in: TAKEN_IDS.ok };
    const nodes: Record<string, KNode> = {};
    for (const node of doc.nodes) nodes[node.id] = this.lowerNode(node, roots, graph.path);
    const spec: KernelSpec = { name: graph.path, nodes, output: outputCandidates(doc) };
    return guards.length ? lowerGuards(spec, guards, this.guardHandlers()) : spec;
  }

  /** What a guard's three nodes run: the two std operations it is built from, and the nested spec a list needs. */
  private guardHandlers(): GuardHandlers {
    return {
      make: this.handlerFor(MAKE).handler,
      refuse: this.handlerFor(REFUSE).handler,
      nested: spec => {
        this.guardSpecs.set(spec.name, spec);
        this.handlers[spec.name] ??= this.nestedRunner(spec, true);
      },
    };
  }

  /**
   * The nested spec a list site's guard runs, by the name its `map` calls it under. A guard of arity `list` is
   * the one spec a reader cannot reach from a document -- it is neither a graph nor a binding -- so a walk over
   * what a run does (the rehearsal) must be able to ask for it, the way it asks for a graph. It is held here
   * as the lowering registered it rather than rebuilt, so what is walked is exactly what runs.
   */
  guardSpec(name: string): KernelSpec | undefined {
    return this.guardSpecs.get(name);
  }

  /** One node as the kernel runs it; a call or map that says `retry` or `timeoutMs` is tagged `<graph>#<id>`. */
  private lowerNode(node: Node, roots: Roots, graphPath: string): KNode {
    if (isSwitch(node)) {
      const rules = node.rules.map(rule => ({ when: expr.compilePredicate(rule.when), to: rule.to, label: rule.when }));
      const caught = node.catch ? { catch: { ...node.catch } } : {};
      return { kind: 'switch', in: lowerValues(node.in, roots), rules, else: node.else, ...caught };
    }
    const { handler, op } = this.handlerFor(node.run);
    const inputs = this.withScope(lowerValues(node.in, roots), { key: node.run, given: node.in });
    const redact = redactOf(this.scope, op, node.in);
    const site = tagSite(this.sites, `${graphPath}#${node.id}`, node);
    if (isRun(node)) return { kind: 'call', handler, in: inputs, redact, ...site };
    const over = lowerValue(node.over, roots);
    return {
      kind: 'map',
      handler,
      over,
      in: inputs,
      onItemFailure: node.onItemFailure ?? 'fail',
      redact,
      bind: bindPaths(node.bind),
      ...site,
    };
  }

  /** A binding operation as a nested spec: one call, of the bound graph or of the delegate, tagged `<binding>#<op>` when it retries or is bounded. */
  private lowerBindingOp(binding: Loaded<BindingDoc>, hit: OpHit): KernelSpec {
    const key = `${binding.path}#${hit.opName}`;
    const cached = this.bindingSpecs.get(key);
    if (cached) return cached;
    const bound = binding.doc.operations[hit.opName];
    const call = bound.graph ? this.graphCall(bound.graph, hit.op) : this.delegateCall(binding, bound, hit.op);
    const op: KCall = { ...call, ...tagSite(this.sites, key, bound) };
    const spec: KernelSpec = { name: key, nodes: { op }, output: hit.op.returns ? ['op'] : undefined };
    this.bindingSpecs.set(key, spec);
    return spec;
  }

  /**
   * The bound graph as one call. A graph whose in is a shape gets the operation's fields by name; one that
   * takes a value whole gets the one field the operation accepts.
   */
  private graphCall(graphRef: string, op: Operation): KCall {
    const graph = this.scope.get('graph', graphRef);
    if (!graph) throw new Error(`unknown graph '${graphRef}'`);
    const handler = `graph:${graph.path}`;
    const whole = this.takesWhole(graph);
    this.handlers[handler] ??= this.attempting(
      this.nestedRunner(this.lowerGraph(graph), whole, graph.doc.atomic === true),
    );
    const names = Object.keys(op.accepts ?? {});
    const passIn = whole ? { in: { ref: 'in', path: [names[0]] } } : inputsByName(names);
    return { kind: 'call', handler, in: passIn };
  }

  /** A delegation as one call: the statement's own values, the caller's by name for the rest, reads taken below request. */
  private delegateCall(binding: Loaded<BindingDoc>, bound: BindingOp, op: Operation): KCall {
    if (!bound.run) throw new Error(`${binding.path}: an operation binds a graph or a run`);
    const { handler, op: target } = this.handlerFor(bound.run);
    const given = passedInputs(target, op, bound.in);
    const roots: Roots = { resolvers: this.resolverRoots(binding.doc.reads) };
    const inputs = this.withScope(lowerValues(given, roots), { key: bound.run, given: bound.in });
    return { kind: 'call', handler, in: inputs, redact: redactOf(this.scope, target, given) };
  }

  /**
   * The scope a site over a scoped collection carries, put on its inputs. It is the one input no document
   * writes: the store says which columns it keeps and the read that fills each, and the compiler carries them
   * to every site over the collection, so no graph can forget one (RFC 0015). Nothing is added where the site
   * is over no scoped collection, so a tree that scopes nothing lowers exactly as it did.
   */
  private withScope(inputs: Record<string, KSource>, site: CallSite): Record<string, KSource> {
    const scope = lowerScope(this.scope, site);
    return scope ? { ...inputs, [SCOPE]: scope } : inputs;
  }

  /** Whether a graph takes its input whole: it declares an `in` that is not a shape (a list, a scalar), read as {{in}}. */
  private takesWhole(graph: Loaded<GraphDoc>): boolean {
    if (!graph.doc.in) return false;
    try {
      return this.scope.types.ref(graph.doc.in).kind !== 'object';
    } catch {
      return false;
    }
  }

  /** A document's `reads`: local name -> the segments read below request. A resolver is a read, so it lowers to no node. */
  private resolverRoots(reads: Record<string, string> | undefined): Record<string, string[]> {
    return Object.fromEntries(Object.entries(reads ?? {}).map(([name, ref]) => [name, this.resolverPath(ref)]));
  }

  /** The segments one `@path#name` reads below request; the checker refused every reference that names nothing. */
  private resolverPath(ref: string): string[] {
    const { path, op } = splitRef(ref);
    const doc = this.scope.get('resolvers', path);
    const resolver = doc?.doc.resolvers[op];
    if (!resolver) throw new Error(`unknown resolver '${ref}'`);
    return splitPath(resolver.read).slice(1);
  }
}
