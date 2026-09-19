/**
 * What a plugin is to the toolchain: an alias root (@http), the directory of documents it ships (its manifest
 * plugin.json, ports, trigger kinds, connection kinds, codecs, shapes -- JSON files a reader can open, the way
 * a library ships headers), the handlers behind its native
 * operations, the runtimes behind its trigger kinds, the codecs behind its content types, and two hooks:
 * `check` for its own rules, `postLoad` for work that happens every time the tree is loaded and judged -- and, for
 * the one plugin that identifies callers, a `guard`.
 *
 * A plugin package exports its PluginModule as the default export; project.json names the package in
 * `plugins[].from` and the runtime imports it. @std and @cli are built into the runtime and need no `from`.
 */
import type { Readable } from 'node:stream';
import type { Handler, Report } from '@wilanis/engine';
import type { TriggerDoc } from './model.js';
import type { Refusal, Registry } from './registry.js';
import type { Scope } from './scope.js';
import type { BlobHandle, Type } from './types.js';

/**
 * The blob registry: where the bytes of a `blob` value live, so that a file is held once, on disk, and never
 * as a value. A codec streams an uploaded body in and answers the handle; an operation streams a handle out
 * to read it, or streams bytes in to answer a new one; a codec streams the answer to the caller. The engine
 * only ever carries handles. The runtime owns the one store of a tree.
 */
export interface BlobStore {
  /** Store what the source yields, as it yields it; answers the handle a graph carries once the source has ended. */
  put(source: Readable | Buffer | string, meta: { contentType: string; filename?: string }): Promise<BlobHandle>;
  /** The bytes behind a handle, as a stream. Fails when the handle names nothing this store holds. */
  open(handle: BlobHandle): Readable;
  /** Forget a handle and its bytes. */
  drop(handle: BlobHandle): Promise<void>;
  /** A scope of this store: what is put through it is dropped by `release`, so a run's blobs end with the run. */
  scope(): BlobScope;
}
export interface BlobScope extends BlobStore {
  release(): Promise<void>;
}

/**
 * What a `holds` operation is given, as `env.hold`: it hands back the way to stop what it started, and the
 * runtime keeps the process alive until every held thing has been stopped, in reverse. A handler that does
 * not hold anything never sees it; a `holds` operation that never calls it holds nothing and the run ends.
 */
export type Hold = (what: { label: string; stop: () => Promise<void> }) => void;

/** What one transaction's participant can do once it is open. */
export interface Participant {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * What an atomic graph's run hands every handler below it, as `env.atomic`. The first transactional operation
 * to run opens the transaction on its connection through `join`; every later one on the same connection gets
 * the same participant. The runtime settles it when the graph's run ends: commit when it answered, rollback
 * otherwise. A handler that is not transactional never reads it.
 */
export interface Atomic {
  join<T extends Participant>(connection: string, open: () => Promise<T>): Promise<T>;
}

/** What one span carries: a value an exporter can put on a span without knowing anything of this tree. */
export type TraceAttributes = Record<string, string | number | boolean>;

/**
 * One run said as spans: what ran, when it started and ended, how it ended, what it was, and what ran under
 * it. A trace is its root span, so the type is the span and the nesting is the trace. Plain data, in the
 * tree's own words: it is what an exporter reads, so it holds the smallest thing one needs and no more.
 */
export interface Trace {
  /** What ran, in the tree's words: `fire <trigger>`, `<port>#<operation>`, `<node id> <handler>`. */
  name: string;
  /** When it started and ended, from the run's clock, in milliseconds. */
  startedAt: number;
  endedAt: number;
  /** How it ended: `ok`, `refused: <reason>`, `denied`, `challenged`, `failed`, `cancelled`, `seeded`. */
  status: string;
  /** What it was, by the `wilanis.*` names the RFC's table gives; a level of `summary` carries no value. */
  attributes: TraceAttributes;
  /** What ran under it: a graph's nodes, a binding's graph, a map's elements. */
  children: Trace[];
}

/** How much a span carries: `summary` never a value, `full` the report's redacted in/out and the message. */
export type TraceLevel = 'summary' | 'full';

/**
 * The attributes that carry what a run said rather than what it did: the report's redacted in and out, and a
 * node's message. `summary` carries none of them -- a reason is a word the author declared in `refuses` and
 * cannot leak, a message is prose that interpolates whatever the author wrote into it. The list lives here,
 * beside the `Trace` it describes, because the runtime that builds a trace and an exporter that sends one
 * must agree on it: two copies drift the day a fourth attribute is added, and the copy that did not learn
 * about it is the one that exports a value an operator asked never to leave.
 */
export const VALUED_ATTRIBUTES = ['wilanis.in', 'wilanis.out', 'wilanis.error'];

/** One span's attributes at this level: all of them at `full`, and none of the valued ones at `summary`. */
function attributesAtLevel(attributes: TraceAttributes, level: TraceLevel): TraceAttributes {
  if (level === 'full') return attributes;
  const out: TraceAttributes = {};
  for (const [name, value] of Object.entries(attributes)) if (!VALUED_ATTRIBUTES.includes(name)) out[name] = value;
  return out;
}

/**
 * A trace already built, narrowed to what a level allows: the same spans and the same nesting, carrying only
 * what the level lets them. A cancelled node is kept at `full` and dropped at `summary`, so a reader at
 * `summary` sees what ran and a reader at `full` also sees the branches not taken.
 *
 * One trace is built per run, at `full`, and handed to every observer, so the narrowing is each observer's
 * and not the server's -- a printer asked for `summary` and an exporter asked for `full` are served by the
 * one walk. An exporter calls this again at its own edge, where the bytes leave the process: the level that
 * is safe by default is only safe if the thing that sends enforces it, whatever it was handed.
 */
export function atLevel(trace: Trace, level: TraceLevel): Trace {
  const children = trace.children
    .filter(child => level === 'full' || child.status !== 'cancelled')
    .map(child => atLevel(child, level));
  return { ...trace, attributes: attributesAtLevel(trace.attributes, level), children };
}

/**
 * What a `holds` operation that answers requests is given, as `env.serving`: the triggers of one kind and
 * the way to fire them. It is read afresh on every request, so a reload can replace the tree underneath a
 * listener whose socket stays open -- the listener holds this object, never the tree it came from.
 */
export interface Serving {
  /** Every trigger of one kind in the tree as it now stands. */
  triggers(kind: string): TriggerDoc[];
  /**
   * The canonical path a trigger is written at, or nothing where it is not one of the tree's. It is what
   * names a trigger across processes and restarts -- two triggers may fire one operation on one schedule and
   * differ only in their inputs, and the document is the only thing that tells them apart.
   */
  pathOf(trigger: TriggerDoc): string | undefined;
  /** Run a trigger's operation and answer its report. */
  fire(args: FireArgs): Promise<Report>;
  /** The trigger's in/out types, resolved. */
  types(trigger: TriggerDoc): { in?: Type; out?: Type };
  /** Build and judge the trigger's input from the context this kind assembled (body already decoded). */
  inputFor(trigger: TriggerDoc, request: Record<string, unknown>): { input: unknown } | { error: string };
  /** content type -> codec, from a plugin's settings table. */
  codecs(root: string): Codecs;
  /** The tree's blob registry; a listener opens a scope per request and releases it once it has answered. */
  blobs: BlobStore;
  log(line: string): void;
  /**
   * Be told of every fire while this tree is served; answers the way to stop listening, as `env.hold` does.
   * Survives a reload: the listeners are the server's, not the tree's, so an exporter holds what it
   * subscribed to and never goes quiet when the tree underneath it is replaced.
   *
   * The trace handed over is built at `full`, so it carries the report's redacted `in`/`out` and each node's
   * message: one trace is built per run and every observer sees it, and a listener that narrows would
   * otherwise have dropped what another wanted. Narrowing is therefore the observer's own -- an observer that
   * does not narrow receives values, and one that exports must apply its level before any byte leaves.
   */
  observe(listener: (trace: Trace) => void): () => void;
  /**
   * Load and judge the tree again, and serve it if it is clean. The runtime does the loading and the judging
   * -- a plugin never imports the compiler -- so a watcher only decides *when*. A tree that refuses is not
   * served: the refusals come back and whatever is already listening keeps answering from the last good one.
   * The plugins are the ones the tree was started with, not whatever `plugins[].from` now resolves to: a
   * reload serves the same plugins against a new tree, and a plugin added to project.json needs a restart.
   */
  reload(): Promise<{ ok: true; documents: number } | { ok: false; refusals: string }>;
  /** The directory of the tree being served, for a watcher that has to know what to watch. */
  root: string;
}

/**
 * The whole of a stream, for a codec that needs the body entire (JSON, text, a form). A blob *codec* never
 * calls this -- it streams, so the bytes stay in the registry -- and the one operation whose answer is a whole
 * file as text, `@blob/text#read`, does. Who may is held by
 * `fitness/a-blob-is-never-read-whole.fitness.ts`.
 */
export async function readAll(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks);
}

export interface FireArgs {
  trigger: TriggerDoc;
  /** The decoded input, already judged against the trigger's in type. */
  input: unknown;
  /** The context this kind hands: what resolvers read as request.* */
  request: Record<string, unknown>;
  /** The blob scope of this run: what the graph stores through it is released when the kind has answered. */
  blobs?: BlobStore;
}

export interface TriggerRuntime {
  /** Start every trigger of this kind; `fire` runs the graph and answers its report. Answers a stop function. */
  start(
    triggers: TriggerDoc[],
    fire: (args: FireArgs) => Promise<Report>,
    opts: {
      settings: Record<string, unknown>;
      registry: Registry;
      log: (line: string) => void;
      /** The trigger's in/out types, resolved. */
      types: (trigger: TriggerDoc) => { in?: Type; out?: Type };
      /** Build and judge the trigger's input from the context this kind assembled (body already decoded). */
      inputFor: (trigger: TriggerDoc, request: Record<string, unknown>) => { input: unknown } | { error: string };
      /** content type -> codec, from this plugin's settings table. */
      codecs: Codecs;
      /** The tree's blob registry; a kind opens a scope per run and releases it once it has answered. */
      blobs: BlobStore;
    },
  ): Promise<() => Promise<void>>;
  /** Encode a report the way this kind would answer, for `wilanis run` and rehearsal. */
  encode?(trigger: TriggerDoc, report: Report): unknown;
}

/**
 * A body codec: a body stream <-> a value, judged against a declared type when the codec yields `declared`.
 * A codec that yields `blob` streams the body into the registry and answers the handle, and streams a
 * handle's bytes back out; every other codec reads the body whole and ignores the store.
 */
export interface Encoded {
  /** The answer's bytes: a stream (a blob, read from the registry) or a buffer (a value, encoded). */
  body: Readable | Buffer;
  contentType: string;
  /** The stream's length when known, so the caller can say so up front. */
  length?: number;
  headers?: Record<string, string>;
}
export interface Codec {
  decode(body: Readable, contentType: string, declared: Type | undefined, blobs: BlobStore): unknown | Promise<unknown>;
  encode(value: unknown, declared: Type | undefined, blobs: BlobStore): Encoded | Promise<Encoded>;
}
/** content type -> codec, as the plugin's settings table declares it. */
export type Codecs = Record<string, Codec>;

/** What a guard is handed on every fire of a trigger that attaches a policy. */
export interface GuardArgs {
  trigger: TriggerDoc;
  /** The trigger kind, canonical. */
  kind: string;
  /** The kind's context as assembled so far; what `identify` answers is added to it. */
  request: Record<string, unknown>;
  /** The credentials the trigger's policy attachments gave, by the names the guard's plugin.json declares, read from the context; absent when the request carried none. */
  credentials: Record<string, unknown>;
  /** The same, as written on the trigger: the {{request.*}} reads, so the guard can tell a caller where to present an answer. */
  reads: Record<string, unknown>;
  /** The guarding plugin's settings from project.json, secrets substituted. */
  settings: Record<string, unknown>;
  env: Record<string, unknown>;
}
/**
 * The one plugin that identifies callers. The runtime calls it around every fire of a gated trigger, for every
 * trigger kind alike: `identify` before any policy, `challenge` when a policy's outcome asks for one, `settle`
 * after the run. Validating a credential lives here and nowhere else; what a verified caller may do is the
 * policies' decision. Its `plugin.json` declares `guard`: the context it adds and the reasons it refuses with.
 */
export interface Guard {
  /**
   * Verify the credentials the trigger gave and answer what the context gains: request.principal, request.session,
   * request.challenge. A credential that is there and does not verify is refused here with one of the plugin's
   * declared reasons; an absent one is not -- the caller is anonymous and the policies decide.
   */
  identify(
    args: GuardArgs,
  ): Promise<
    | { context: Record<string, unknown> }
    | { refuse: { reason: string; message: string; detail?: Record<string, unknown> } }
  >;
  /** Open a challenge a policy outcome asked for; answers what the caller is told, and the detail (its id, how to answer) that rides with the refusal. */
  challenge(
    args: GuardArgs & { policy: string; reason: string; message: string; method?: string },
  ): Promise<{ message: string; detail: Record<string, unknown> }>;
  /** After the trigger's operation ran: consume what was single-use, stamp what was proven. */
  settle?(args: GuardArgs & { report: Report }): Promise<void>;
}

/** What a plugin's `check` sees: the resolved tree, its own settings, and the way to refuse (an X code, the file, the message, where, the fix). */
export interface PluginCheckContext {
  scope: Scope;
  settings: Record<string, unknown>;
  refuse: (refusal: Refusal) => void;
}

/** What a plugin's `postLoad` sees. */
export interface PostLoadContext {
  /** The project directory. */
  root: string;
  registry: Registry;
  scope: Scope;
  /** This plugin's settings from project.json, secrets substituted. */
  settings: Record<string, unknown>;
  /** The environment handlers see: connections, plugins, canon, resolveType, resolving, and `ports` (a `FirePort`) for the ports a plugin requires. */
  env: Record<string, unknown>;
  log: (line: string) => void;
}

/**
 * What `wilanis migrate` gives a plugin's `migrate` member: what `postLoad` saw, the profile the command ran
 * under, the targets the operator allowed a destructive step on, and whether a target the world holds but the
 * record does not may be adopted.
 */
export interface MigrateContext extends PostLoadContext {
  /** The profile the command ran under, as `start`'s is: it decides which connection settings are read. */
  profile: string;
  /** The targets the operator named with `--allow-destructive`, each `<connection>/<target>`; a destructive step on any other is refused. */
  allowDestructive: string[];
  /** Whether a target the world holds and the record does not may be taken into the record rather than refused. */
  adopt: boolean;
}

/**
 * One thing a plugin would do to the world to make it match the tree. `target` is what the step is about in
 * the plugin's own words and `at` the part of it; the runtime reads only `class` and `refused`, so it never
 * learns what either names.
 */
export interface PlanStep {
  /** The verb, in the plugin's words: what would be done. */
  do: string;
  /** What it would be done to, in the plugin's words. */
  target: string;
  /** The part of the target it is about, where it is about one. */
  at?: string;
  /** Additive always applies; transformative applies under `--apply`; destructive needs the operator to allow it. */
  class: 'additive' | 'transformative' | 'destructive';
  /** The one line an operator reads to know what this step does. */
  says: string;
  /** What the step would destroy, said plainly, where it would destroy anything. */
  loses?: string;
  /** How many rows the step touches, where the plugin counted them. */
  rows?: number;
  /** Why the step cannot apply at all; a refused step refuses its whole target, since a plan is one transaction. */
  refused?: string;
}

/** One connection's plan: what it is, what would be done to it, and why nothing would be, where nothing would. */
export interface PlanTarget {
  /** The canonical path of the connection this plan is against; the runtime orders targets by it. */
  connection: string;
  /** What is behind the connection, for the operator to read. */
  engine: string;
  /** Why this connection was not planned at all, where it was not. */
  skipped?: string;
  /** What the world holds that the record does not agree with; a drifted connection plans nothing. */
  drifted?: string[];
  /**
   * What the operator should know about this connection that is not a change to make: a mark in the tree that
   * has done its work, say, and the edit that removes it. It is printed and never judged -- it does not stop a
   * step applying, does not count towards what refused, and does not reach the exit code -- because the plugin
   * that has something to say about a tree has no step to say it with, and a line that judged would refuse a
   * connection nothing is wrong with.
   */
  notes?: string[];
  /** The steps, in the order the plugin declared them. */
  steps: PlanStep[];
}

/** Every connection one plugin would reconcile, and the steps for each. */
export interface Plan {
  targets: PlanTarget[];
}

/** One plan that was applied, as the world now records it. */
export interface Applied {
  id: number;
  appliedAt: string;
  /** Who ran it, as the plugin recorded them. */
  by: string;
  /** The tree the plan came from: `project.json → name`. */
  tree: string;
  connection: string;
  /** The targets this application touched, in the plugin's words. */
  targets: string[];
}

export interface PluginModule {
  /** The alias root, e.g. '@http'. */
  root: string;
  /**
   * The directory of the documents this plugin ships. Every *.json under it is loaded as `${root}/<relative path>`
   * and judged like any tree document; it must hold plugin.json. Absolute, so a package points it at itself:
   * fileURLToPath(new URL('../docs', import.meta.url)).
   */
  docs: string;
  /** 'path#operation' -> handler */
  handlers: Record<string, Handler>;
  /** trigger-kind path -> runtime */
  triggers?: Record<string, TriggerRuntime>;
  /** codec path -> implementation */
  codecs?: Record<string, Codec>;
  /** Identifies callers and opens challenges; at most one plugin of a tree has one, and its plugin.json declares `guard`. */
  guard?: Guard;
  /** Plugin-specific rules (X codes), run by `checkTree` after the generic ones. */
  check?(ctx: PluginCheckContext): void;
  /**
   * Runs once per load of the tree, after it is checked and before any trigger starts: open connections, warm
   * caches, register parsers. A reload is that happening again, so this runs once more, against the new
   * tree's environment, and what it sets up belongs to that tree alone -- never to the process. May hand back
   * a teardown, run when the tree it set up stops being served: on a reload, once the new tree is serving.
   * Whatever it holds must be released there, or a tree that reloads holds a little more each time.
   */
  postLoad?(ctx: PostLoadContext): Promise<void | (() => Promise<void>)>;
  /**
   * What a plugin that keeps declared state in the world does for `wilanis migrate`: the plan from the tree as it
   * stands against what the world has recorded, and its application. Run after postLoad under the chosen profile,
   * never by a graph and never by start. Plugins without one have nothing in the world to reconcile.
   */
  migrate?: {
    plan(ctx: MigrateContext): Promise<Plan>;
    apply(ctx: MigrateContext, plan: Plan): Promise<Applied[]>;
    /**
     * Every plan this plugin has already applied to the world, latest first, for `wilanis migrate --history`.
     * The record is the world's and not the tree's, so only the plugin that wrote it can read it back; a
     * plugin that keeps none has no history to print.
     */
    history?(ctx: MigrateContext): Promise<Applied[]>;
  };
}
