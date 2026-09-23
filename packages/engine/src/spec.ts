/**
 * What the kernel executes. Nothing here knows about files, refs, shapes, ports, layers or triggers:
 * nodes, sources, handlers, and pre-supplied values. The compiler lowers a graph document to this.
 */

/** Where a node's value comes from at run time. `ref` may be a node id or a pseudo-node ('in', 'const', 'request'). */
export type KSource =
  | { ref: string; path: string[] }
  | { list: KSource[] }
  | { object: Record<string, KSource> }
  | { value: unknown }
  /** Text with scalar sources interpolated into it, in order. */
  | { concat: (string | KSource)[] };

/** Paths (relative to the node's in / out) whose values are secret and never appear in a report. */
export interface Redact {
  in?: string[][];
  out?: string[][];
}

export interface KCall {
  kind: 'call';
  handler: string;
  /** Every value the handler takes, literal or read; the compiler lowers a node's `in` to this. */
  in: Record<string, KSource>;
  redact?: Redact;
  /** An opaque tag the compiler gives this call, handed to the handler as `ctx.site`. The kernel never reads it. */
  site?: string;
}
export interface KSwitch {
  kind: 'switch';
  in: Record<string, KSource>;
  rules: { when: (values: Record<string, unknown>) => boolean; to: string; label: string }[];
  else: string;
  /**
   * node id -> the node this switch routes to when that node breaks. The rules and `else` are then not tried, and
   * the run goes on. A refusal is never caught: it ends the run as it would anywhere.
   */
  catch?: Record<string, string>;
}
export interface KMap {
  kind: 'map';
  handler: string;
  over: KSource;
  in: Record<string, KSource>;
  /** input name -> path within the element ([] = the whole element). Absent: the element arrives as `item`. */
  bind?: Record<string, string[]>;
  onItemFailure: 'fail' | 'collect';
  /** The most elements this map runs over; a longer list is a fault of the node before any element starts. Absent: any length. */
  limit?: number;
  /** How many elements run at once; the rest wait for a slot, in index order. Absent: every element at once. */
  concurrency?: number;
  redact?: Redact;
  /** An opaque tag the compiler gives this map, handed to every element's handler as `ctx.site`. The kernel never reads it. */
  site?: string;
}
export type KNode = KCall | KSwitch | KMap;

export interface KernelSpec {
  name: string;
  nodes: Record<string, KNode>;
  /** Ordered output candidates; the first that settled answers. Absent: the graph answers nothing. */
  output?: string[];
}

export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'seeded';

/**
 * A handler ending the run on purpose. `reason` is one word the caller acts on (which outcome), `message` is
 * what a reader is told. Any other throw is a fault: something the graph did not declare.
 */
export class Refusal extends Error {
  /** `detail`: what the caller needs beside the words -- a challenge's id and how to answer it. Answered with the reason and message, never read by a graph. */
  constructor(
    readonly reason: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'Refusal';
  }
}

/**
 * Whether a thrown thing is a refusal: this engine's `Refusal`, or an `Error` named `Refusal` carrying a
 * string `reason`, so a plugin that bundles its own copy of the engine is still understood.
 */
export function isRefusal(error: unknown): error is Refusal {
  if (error instanceof Refusal) return true;
  return error instanceof Error && error.name === 'Refusal' && typeof (error as Refusal).reason === 'string';
}

export interface NodeReport {
  status: NodeStatus;
  /** call/map: the handler that ran (path#operation, or a binding operation). */
  handler?: string;
  in?: Record<string, unknown>;
  out?: unknown;
  error?: string;
  /** The handler refused on purpose: the reason it gave, a word a caller acts on. Absent on a fault. */
  reason?: string;
  /** What a refusal carries beside its words, when it does: answered to the caller as it is. */
  detail?: Record<string, unknown>;
  /** switch: the node it routed to. */
  selected?: string;
  /** call or map: the switch that routed this node's fault; the run went on, so this is not how it ended. */
  caught?: string;
  /** call bound to a graph: the nested run. */
  sub?: Report;
  /**
   * call, or one element of a map: the tries before the one this report shows, oldest first. Absent: it ran
   * once. The node's status, out and error are the last try's; its `startedAt` and `endedAt` span every try.
   */
  attempts?: Attempt[];
  /**
   * map: one report per element, in order -- its status, in, out or error, and the nested run in `sub` when
   * the operation is a graph. Every element settles before the node does, so a failed map still says what
   * each element did, and a caller can seed the finished ones (`initial['<id>.<index>']`) and run the rest.
   */
  items?: NodeReport[];
  startedAt?: number;
  endedAt?: number;
}

/** One try of a node that did not stand: when it ran, why it was tried again, and the nested run when it was a graph. */
export interface Attempt {
  startedAt: number;
  endedAt: number;
  error: string;
  sub?: Report;
}

export interface Report {
  graph: string;
  /** How the run ended: `cancelled` when its signal fired before anything else ended it; a cancelled run has no output. */
  status: 'done' | 'failed' | 'blocked' | 'cancelled';
  output?: unknown;
  /** blocked: the root paths that were read but never supplied. */
  needs?: string[];
  nodes: Record<string, NodeReport>;
  startedAt: number;
  endedAt: number;
}

export interface RunContext {
  /** Dotted position of the running node, for nested stubs and reports. */
  nodePath: string[];
  /** Attach the nested report of a graph-bound operation to the calling node. */
  attach: (sub: Report) => void;
  /** Record a try of this node that did not stand: the node's report keeps them, in order, under `attempts`. */
  attempted: (attempt: Attempt) => void;
  /** The running node's `site`, as the compiler tagged it. Absent when the node carries none. */
  site?: string;
  /** Pre-recorded results by dotted node path; when present the handler is not called. */
  stubs?: Record<string, unknown>;
  /** The trigger context (`request`) of this run, forwarded to nested graphs. */
  request?: unknown;
  signal?: AbortSignal;
  /** The clock this run stamps its reports with, forwarded so a nested run stamps by the same one. */
  clock: () => number;
  /** Anything the embedder wants handlers to see (connections, secrets, ...). Opaque to the kernel. */
  env: Record<string, unknown>;
}

export interface HandlerArgs {
  in: Record<string, unknown>;
  ctx: RunContext;
}
export type Handler = (args: HandlerArgs) => Promise<unknown>;
export type Handlers = Record<string, Handler>;

export interface RunOptions {
  /**
   * Pre-supplied values: pseudo-nodes (`in`, `request`), any node id (replay: the node is seeded, not
   * executed), and `<mapId>.<index>` for one element of a map (that element is seeded, the others run).
   */
  initial?: Record<string, unknown>;
  stubs?: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * What every `startedAt` and `endedAt` of this run is read from; `Date.now` unless given. It only reads
   * the time: the kernel never waits on it and never decides from it whether to run again.
   */
  clock?: () => number;
  env?: Record<string, unknown>;
  nodePath?: string[];
}
