/**
 * Retry and timeout, where the data layer names an effect (RFC 0011). The compiler tags a call whose document
 * says `retry` or `timeoutMs` with a site, records what the document said against it, and wraps every handler it
 * registers once: at call time the wrapper looks the site up and, finding nothing, calls the handler and does
 * nothing else. The engine learns nothing: it hands the tag through as `ctx.site`, and a try that did not stand
 * reaches the node's report through `ctx.attempted`.
 */
import { expr, type Retry, type Values } from '@wilanis/core';
import { type Handler, type HandlerArgs, isRefusal, type Report } from '@wilanis/engine';

/** What one site says about its call: how many more tries, the wait before them, what answer is tried again, the bound. */
export interface Attempts {
  times: number;
  backoffMs: number;
  /** the retry's `when`, as written and compiled; absent: only a fault or a timeout is tried again */
  when?: { text: string; holds: (answer: Values) => boolean };
  timeoutMs?: number;
}

/** Every site the compiler tagged, by the tag its call carries. */
export type Sites = Map<string, Attempts>;

/** What a document says at a site: a data graph's `run` or `map` node, or a binding's operation. */
export interface Said {
  retry?: Retry;
  timeoutMs?: number;
}

/**
 * The tag a call carries, spread into its kernel node, after recording what `said` asks at `name`. A call that
 * says neither word carries no tag, so it lowers exactly as it did.
 */
export function tagSite(sites: Sites, name: string, said: Said): { site?: string } {
  if (!said.retry && said.timeoutMs === undefined) return {};
  const when = said.retry?.when;
  sites.set(name, {
    times: said.retry?.times ?? 0,
    backoffMs: said.retry?.backoffMs ?? 0,
    ...(when ? { when: { text: when, holds: expr.compilePredicate(when) } } : {}),
    ...(said.timeoutMs !== undefined ? { timeoutMs: said.timeoutMs } : {}),
  });
  return { site: name };
}

/** A handler that tries `base` as its call's site says; a call at no site, or at an untagged one, is `base` once. */
export function attempting(base: Handler, sites: Sites): Handler {
  return args => {
    const policy = args.ctx.site === undefined ? undefined : sites.get(args.ctx.site);
    return policy ? tried(base, args, policy) : base(args);
  };
}

/**
 * Runs `work` with a signal that aborts when `outer` does or when `timeoutMs` has passed, and rejects with
 * `timed out after <n>ms` when the timer strikes first. The handler was told through the signal; what it answers
 * after that is dropped.
 */
export async function bounded<T>(
  work: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs: number | undefined,
  outer: AbortSignal | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return work(outer);
  const timer = new AbortController();
  const signal = outer ? AbortSignal.any([outer, timer.signal]) : timer.signal;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const struck = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      const error = new Error(`timed out after ${timeoutMs}ms`);
      timer.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(signal), struck]);
  } finally {
    clearTimeout(handle);
  }
}

/** One try's ending: what it answered, or what it threw, and the nested run it attached when it ran a graph. */
type Ending = { ok: true; out: unknown; sub?: Report } | { ok: false; error: unknown; sub?: Report };

/**
 * The loop: try, and while the ending is one to try again, tries remain and the run's signal has not aborted,
 * wait, record it, and try once more. A try that ended after the run was cancelled stands, and so does one whose
 * wait the cancellation cut short, so a cancelled node's attempts are what was tried before the cancellation and it
 * settles as soon as the signal fires (RFC 0012).
 */
async function tried(base: Handler, args: HandlerArgs, policy: Attempts): Promise<unknown> {
  const { ctx } = args;
  for (let attempt = 0; ; attempt++) {
    const startedAt = ctx.clock();
    const ending = await once(base, args, policy.timeoutMs);
    const why = attempt < policy.times && !ctx.signal?.aborted ? againBecause(ending, policy) : undefined;
    if (why === undefined) return stand(ending, args);
    const endedAt = ctx.clock();
    if (!(await pause(policy.backoffMs * 2 ** attempt, ctx.signal))) return stand(ending, args);
    ctx.attempted({ startedAt, endedAt, error: why, ...(ending.sub ? { sub: ending.sub } : {}) });
  }
}

/**
 * One try, bounded. The nested run it attaches is kept rather than handed on, since only the try that stands
 * hangs its run on the node; an attach that arrives after the try has settled (a timed-out graph still running)
 * is dropped.
 */
async function once(base: Handler, args: HandlerArgs, timeoutMs: number | undefined): Promise<Ending> {
  let sub: Report | undefined;
  let open = true;
  const attach = (report: Report) => {
    if (open) sub = report;
  };
  try {
    const out = await bounded(
      signal => base({ in: args.in, ctx: { ...args.ctx, signal, attach } }),
      timeoutMs,
      args.ctx.signal,
    );
    return { ok: true, out, sub };
  } catch (error) {
    return { ok: false, error, sub };
  } finally {
    open = false;
  }
}

/**
 * Why an ending is tried again, or nothing when it stands. A refusal is the graph deciding and is never tried
 * again; any other throw, a timeout among them, is a fault and is; an answer is only when `when` accepts it.
 */
function againBecause(ending: Ending, policy: Attempts): string | undefined {
  if (!ending.ok) return isRefusal(ending.error) ? undefined : messageOf(ending.error);
  const answer = ending.out;
  if (!policy.when || typeof answer !== 'object' || answer === null) return undefined;
  return policy.when.holds(answer as Values) ? `answer retried: ${policy.when.text}` : undefined;
}

/** The try that stands becomes the node's: its nested run is attached, and its answer answered or its error thrown. */
function stand(ending: Ending, args: HandlerArgs): unknown {
  if (ending.sub) args.ctx.attach(ending.sub);
  if (ending.ok) return ending.out;
  throw ending.error;
}

/** What a thrown thing says, as a report writes it. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the wait of `ms` before the next try ran out, or false when the run's `signal` aborted first; nothing is
 * waited when it is 0. It is the run's own signal, not the one a site's timer joins, so a timeout never cuts a wait.
 */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const aborted = () => {
      clearTimeout(handle);
      resolve(false);
    };
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
