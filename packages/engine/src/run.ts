/**
 * One run of a spec. The scheduler fires every node the instant its sources have settled, all of them
 * concurrently, and answers a report at quiescence. A switch routes and cancels the branches it did not
 * choose; a call runs its handler; a map runs its handler once per element (`map.ts`). A node a switch catches
 * that breaks does not end the run: that switch routes its fault. When the run's signal fires, nothing more
 * starts: what had not started is cancelled, what was in flight settles as it settles.
 */
import { type MapHost, runMap, shownAnswer } from './map.js';
import { type Plan, planOf, targetsOf } from './plan.js';
import { redactAttempt, redactReport, redactValue, shownOut } from './redact.js';
import { answered, type Ending, initialReport, noteRefusal, reportOf } from './report.js';
import { nodeRefs, PSEUDO, readAll } from './sources.js';
import {
  type Handlers,
  isRefusal,
  type KCall,
  type KernelSpec,
  type KMap,
  type KNode,
  type KSwitch,
  type NodeReport,
  type Report,
  type RunContext,
  type RunOptions,
} from './spec.js';

/**
 * One run of one spec: it fires every node the instant its sources have settled, all of them concurrently,
 * routes and cancels the branches a switch did not choose, routes a caught node's fault through the switch that
 * catches it, and answers at quiescence -- failed with the node that broke or refused, cancelled when its signal fired first, done with the first output candidate that
 * settled, or blocked on what was never supplied.
 */
export class Run {
  private readonly values = new Map<string, unknown>();
  /** What a report shows of each value: a node's `out`, secrets as the marker; a root as the run was told to show it. */
  private readonly shown = new Map<string, unknown>();
  private readonly reports: Record<string, NodeReport> = {};
  private readonly plan: Plan;
  private readonly root: string[];
  /** What every stamp of this run is read from: the clock given, or `Date.now`. */
  private readonly clock: () => number;
  private readonly startedAt: number;
  /** How the run ended before quiescence, once it has; the first ending stands. */
  private ending: Ending | undefined;
  private running = 0;
  private wake: (() => void) | undefined;
  /** What a map of this run reads and calls through. */
  private readonly mapHost: MapHost;

  constructor(
    private readonly handlers: Handlers,
    private readonly spec: KernelSpec,
    private readonly opts: RunOptions,
  ) {
    this.plan = planOf(spec);
    this.root = opts.nodePath ?? [];
    this.clock = opts.clock ?? Date.now;
    this.startedAt = this.clock();
    for (const [key, value] of Object.entries(opts.initial ?? {})) this.values.set(key, value);
    for (const [key, value] of Object.entries({ ...opts.initial, ...opts.shown })) this.shown.set(key, value);
    for (const id of Object.keys(spec.nodes)) this.reports[id] = initialReport(this.values, id);
    this.mapHost = {
      values: this.values,
      shown: this.shown,
      clock: this.clock,
      ended: () => this.ending !== undefined,
      call: (node, path, inputs, report) =>
        this.invoke(node.handler, inputs, this.contextFor(node, [...this.root, ...path], report)),
    };
  }

  /** Fire everything ready, wait for any settle, repeat until quiescence; then answer. An abort ends the run cancelled. */
  async execute(): Promise<Report> {
    const signal = this.opts.signal;
    const aborted = () => {
      this.cancelRun();
      this.wake?.();
    };
    signal?.addEventListener('abort', aborted, { once: true });
    try {
      await this.schedule();
    } finally {
      signal?.removeEventListener('abort', aborted);
    }
    const { spec, reports: nodes, values, ending } = this;
    return reportOf({ spec, nodes, values, ending, startedAt: this.startedAt, endedAt: this.clock() });
  }

  /** The scheduler's loop: start what is ready, else wait for a node to settle, until nothing is running. */
  private async schedule(): Promise<void> {
    for (;;) {
      if (this.opts.signal?.aborted) this.cancelRun();
      const ready = Object.keys(this.spec.nodes).filter(id => this.isReady(id));
      if (ready.length) {
        for (const id of ready) this.start(id);
        continue;
      }
      if (this.running === 0) break;
      await new Promise<void>(resolve => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }

  // ---- readiness ----------------------------------------------------------------------------------

  private status(id: string) {
    return this.reports[id].status;
  }

  private settled(id: string): boolean {
    return answered(this.reports[id]);
  }

  /** A pending node runs once every dependency settled, its router chose it, and every root it reads is supplied. */
  private isReady(id: string): boolean {
    return (
      !this.ending &&
      this.status(id) === 'pending' &&
      this.dependenciesSettled(id) &&
      this.routedTo(id) &&
      this.rootsSupplied(id)
    );
  }

  /** Every dependency answered, or -- for a switch -- broke with a fault this switch catches. */
  private dependenciesSettled(id: string): boolean {
    return [...(this.plan.dependencies.get(id) ?? [])].every(
      dependency => this.settled(dependency) || this.reports[dependency].caught === id,
    );
  }

  /** A routed node waits for its switch to select it. */
  private routedTo(id: string): boolean {
    const router = this.plan.routedBy.get(id);
    return router === undefined || this.reports[router].selected === id;
  }

  private rootsSupplied(id: string): boolean {
    return [...nodeRefs(this.spec.nodes[id])].every(ref => !PSEUDO.has(ref) || this.values.has(ref));
  }

  // ---- running a node -----------------------------------------------------------------------------

  private start(id: string): void {
    const node = this.spec.nodes[id];
    const report = this.reports[id];
    report.status = 'running';
    report.startedAt = this.clock();
    if (node.kind !== 'switch') report.handler = node.handler;
    this.running++;
    this.runNode(id, node, report)
      .catch(error => this.fail(id, report, error))
      .finally(() => {
        report.endedAt = this.clock();
        this.running--;
        this.wake?.();
      });
  }

  private runNode(id: string, node: KNode, report: NodeReport): Promise<void> {
    if (node.kind === 'switch') return this.runSwitch(id, node, report);
    if (node.kind === 'call') return this.runCall(id, node, report);
    return this.runMap(id, node, report);
  }

  /** The node answered: its value is what others read; the report shows it with secrets removed, and so does every read of it. */
  private finish(id: string, report: NodeReport, out: unknown, shown: unknown = out): void {
    report.out = shown;
    this.values.set(id, out);
    this.shown.set(id, shown);
    report.status = 'done';
  }

  /**
   * A node broke or refused: the run is over, and nothing still pending starts -- unless a switch catches this
   * node's fault, when the node is marked and the run goes on for that switch to route it.
   */
  private fail(id: string, report: NodeReport, error: unknown): void {
    report.status = 'failed';
    report.error = (error as Error).message;
    noteRefusal(report, error);
    const catcher = this.catcherOf(id, error);
    if (catcher !== undefined) {
      report.caught = catcher;
      return;
    }
    this.end();
  }

  /** The run is over: nothing still pending starts. */
  private end(): void {
    this.ending ??= 'failed';
    for (const id of Object.keys(this.spec.nodes))
      if (this.status(id) === 'pending') this.reports[id].status = 'cancelled';
  }

  /**
   * The switch that catches this node's fault: never a refusal's, and only a switch still to route, or one the
   * run's cancellation stopped (the fault is marked; nothing routes it). A catcher whose branch was not chosen
   * routes nothing, so the fault ends the run as it would with no catch.
   */
  private catcherOf(id: string, error: unknown): string | undefined {
    const catcher = this.plan.catchers.get(id);
    if (catcher === undefined || isRefusal(error)) return undefined;
    return this.status(catcher) === 'pending' || this.ending === 'cancelled' ? catcher : undefined;
  }

  /**
   * The run's signal fired: the run is cancelled unless it had already ended, and nothing that had not started
   * ever will -- every pending node, and every pending element of a map in flight. What is running is left alone.
   */
  private cancelRun(): void {
    this.ending ??= 'cancelled';
    for (const report of Object.values(this.reports)) {
      if (report.status === 'pending') report.status = 'cancelled';
      for (const item of report.items ?? []) if (item.status === 'pending') item.status = 'cancelled';
    }
  }

  /**
   * Cancel a pending node and, transitively, whatever waits for it. A switch holding a caught fault it will now
   * never route ends the run with that fault.
   */
  private cancel(id: string): void {
    if (this.status(id) !== 'pending') return;
    this.reports[id].status = 'cancelled';
    for (const dependent of this.plan.dependents.get(id) ?? []) this.cancel(dependent);
    for (const report of Object.values(this.reports))
      if (report.caught === id) {
        delete report.caught;
        this.end();
      }
  }

  /** A switch routes where a caught fault goes, else to the first rule that holds, else to its fallback. */
  private async runSwitch(id: string, node: KSwitch, report: NodeReport): Promise<void> {
    const inputs = readAll(node.in, this.values);
    report.in = readAll(node.in, this.shown);
    const selected = this.caughtRoute(id, node) ?? node.rules.find(rule => rule.when(inputs))?.to ?? node.else;
    report.selected = selected;
    this.finish(id, report, selected);
    for (const target of new Set(targetsOf(node))) if (target !== selected) this.cancel(target);
  }

  /** Where a switch sends the first node in its `catch` whose fault it caught; the rules are then never tried. */
  private caughtRoute(id: string, node: KSwitch): string | undefined {
    const broke = Object.entries(node.catch ?? {}).find(([caught]) => this.reports[caught]?.caught === id);
    return broke?.[1];
  }

  /** A call's report shows its inputs as their sources' reports show them and marked by its own operation; its answer likewise. */
  private async runCall(id: string, node: KCall, report: NodeReport): Promise<void> {
    const inputs = readAll(node.in, this.values);
    report.in = redactValue(readAll(node.in, this.shown), node.redact?.in) as Record<string, unknown>;
    const out = await this.invoke(node.handler, inputs, this.contextFor(node, [...this.root, id], report));
    this.finish(id, report, out, shownOut(report, out, node.redact?.out));
  }

  private async runMap(id: string, node: KMap, report: NodeReport): Promise<void> {
    const out = await runMap(this.mapHost, id, node, report);
    this.finish(id, report, out, shownAnswer(node, out, report.items ?? []));
  }

  /**
   * What a handler sees: where it runs and the site it was tagged with, the request, the embedder's env, and the
   * two doors into its own report -- where to hang a nested run, and where to record a try that did not stand.
   */
  private contextFor(node: KCall | KMap, nodePath: string[], report: NodeReport): RunContext {
    return {
      nodePath,
      ...(node.site !== undefined ? { site: node.site } : {}),
      attach: sub => {
        report.sub = redactReport(sub, node.redact?.out);
      },
      attempted: attempt => {
        report.attempts = [...(report.attempts ?? []), redactAttempt(attempt, node.redact?.out)];
      },
      stubs: this.opts.stubs,
      request: this.values.get('request'),
      shownIn: report.in,
      signal: this.opts.signal,
      clock: this.clock,
      env: this.opts.env ?? {},
    };
  }

  /** Call a handler, unless a result is pre-recorded for this node path. */
  private async invoke(handler: string, inputs: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const key = ctx.nodePath.join('.');
    if (this.opts.stubs && key in this.opts.stubs) return this.opts.stubs[key];
    const fn = this.handlers[handler];
    if (!fn) throw new Error(`no handler '${handler}'`);
    return fn({ in: inputs, ctx });
  }
}
