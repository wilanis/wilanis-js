/** The tree behind a listener: what every request is answered from, and what a reload puts there instead. */
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, Scope, type Serving, type Trace } from '@wilanis/core';
import type { Embedder } from './embed.js';
import type { Ran } from './fired.js';
import { postLoad } from './post-load.js';
import { secretsRefusal } from './profile.js';
import { loadProject } from './project.js';
import { embedderFor } from './tools.js';
import { traceOf } from './trace.js';

/** A tree loaded, judged and set up, ready to be put behind the listener. */
interface Prepared {
  load: LoadResult;
  emb: Embedder;
  down: () => Promise<void>;
}

/**
 * A tree being served, as a listener sees it. It reads `current` on every request rather than closing over
 * one load, so `swap` can put a freshly loaded tree behind a socket that never closed -- what `@reload` does.
 */
export class Served {
  /**
   * What the plugins of the tree now being served set up in their postLoad. A reload replaces it, since the
   * tree it belongs to is the one being replaced: an engine registered against the old environment is not
   * registered against the new one, and nothing else would notice until a graph asked for it.
   */
  private down: () => Promise<void> = async () => {};

  /**
   * Who is being told of every fire. They live here and not on the embedder because a reload builds a fresh
   * one: an exporter holds the server, never the tree it came from, exactly as a listener does.
   */
  private readonly listeners = new Set<(trace: Trace) => void>();

  /**
   * `under` is the profile this process started with and the environment it read: a reload never changes
   * profile, and holds the tree it loads to the variables that profile's reach reads in that environment.
   */
  constructor(
    private current: { load: LoadResult; emb: Embedder },
    readonly log: (line: string) => void,
    private readonly under: { profile?: string; env?: NodeJS.ProcessEnv } = {},
  ) {}

  /** Take what the plugins of this tree set up, so a reload can replace it and stopping can undo it. */
  setDown(down: () => Promise<void>): void {
    this.down = down;
  }

  /** Undo what the plugins of the tree being served set up. */
  stopPlugins(): Promise<void> {
    return this.down();
  }
  /** The embedder of the tree being served now, so a swap is seen by whoever asks next. */
  get emb() {
    return this.current.emb;
  }
  /** The tree being served now, so a swap is seen by whoever asks next. */
  get load() {
    return this.current.load;
  }

  /** Be told of every fire while this tree is served; answers the way to stop listening. Survives a reload. */
  observe(listener: (trace: Trace) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * What the embedder of the tree being served hands over after every run -- a fire of a trigger, or one of
   * the project's startup steps -- said as a trace and told to everyone listening. It is the server that is
   * told and not the embedder that tells, because a reload replaces the embedder and never the listeners.
   *
   * The trace is built at `full`, because one is built once and handed to every observer: a printer asked for
   * `summary` and an exporter asked for `full` cannot both be served by a trace that already dropped what one
   * of them wanted. Each narrows what it was handed with `atLevel`, and the level a run leaves the process at
   * is the one the thing that sends was configured with, never the one the server happened to build.
   */
  ran(what: Ran): void {
    this.observed(traceOf(what, this.emb.scope, { level: 'full' }));
  }

  /**
   * Tell everyone listening what one run did. An observer that throws is said and stepped over: an exporter
   * that cannot reach its collector must not take down the run whose trace it was handed.
   */
  observed(trace: Trace): void {
    for (const listener of this.listeners)
      try {
        listener(trace);
      } catch (error) {
        this.log(`observer: ${(error as Error).message}`);
      }
  }

  /**
   * Load and judge the tree again; serve it only if it is clean. What was held stays held -- the listener is
   * the same one, and its socket never closed -- so a reload swaps the tree a request is answered from, and
   * a tree that refuses leaves the last good one serving. The plugins are the ones this tree was started
   * with: a plugin added to project.json is not picked up until the process restarts.
   */
  async reload(): Promise<{ ok: true; documents: number } | { ok: false; refusals: string }> {
    const ready = await this.prepare();
    if ('refusals' in ready) return { ok: false, refusals: ready.refusals };
    const before = this.down;
    this.swap(ready.load, ready.emb);
    this.setDown(ready.down);
    // the new tree is serving by now, so the old one's teardown can no longer refuse the reload: what it
    // failed to release is said and left, rather than reported as a reload that did not happen
    try {
      await before();
    } catch (error) {
      this.log(`reload: the old tree did not stop cleanly: ${(error as Error).message}`);
    }
    return { ok: true, documents: ready.load.registry.files.length };
  }

  /**
   * Load, judge and set up the tree that is to be served next, without touching the one that is: everything
   * a reload can still refuse happens here, so what the caller swaps in is a tree whose plugins are already
   * registered against its own environment.
   */
  private async prepare(): Promise<Prepared | { refusals: string }> {
    // the modules this tree was started with, so a reload serves the same plugins rather than whatever the
    // directory resolves to now: one started with a module of its own could not otherwise reload at all
    const plugins = Object.fromEntries(this.load.plugins.map(plugin => [plugin.root, plugin]));
    const load = await loadProject(this.load.root, { plugins });
    const refusals = checkTree(load);
    if (!refusals.ok) return { refusals: refusals.format() };
    const { profile, env = process.env } = this.under;
    // the same profile's reach, re-derived from the tree as it now stands: a reload that makes it read a
    // variable nobody set is refused as a start would be, and the last good tree keeps serving
    const missing = secretsRefusal(new Scope(load.registry, load.resolve), profile, env);
    if (missing) return { refusals: missing };
    const emb = embedderFor(load, { profile, env });
    emb.serve(this);
    // what the old embedder held is still running and still ours: the new one answers for it when we stop
    emb.held.push(...this.emb.held);
    // the new tree's plugins set themselves up before it is served, so nothing is asked of an environment
    // they have not seen; a plugin that will not start leaves the last good tree serving, as a refusal does
    try {
      return { load, emb, down: await postLoad(load, emb, this.log) };
    } catch (error) {
      return { refusals: `a plugin did not load: ${(error as Error).message}` };
    }
  }

  /** Put a newly loaded tree behind whatever is already listening. The old embedder's held things are not stopped: the listener is the same one. */
  swap(load: LoadResult, emb: Embedder) {
    this.current = { load, emb };
  }
  /** What a `holds` operation reads as env.serving: every member goes through `current`, so a swap is seen at once. */
  serving(): Serving {
    const held = this;
    return {
      triggers: kind =>
        held.load.registry
          .all('trigger')
          .filter(trigger => held.load.resolve(trigger.doc.kind) === kind)
          .map(trigger => trigger.doc),
      pathOf: trigger => held.load.registry.all('trigger').find(one => one.doc === trigger)?.path,
      fire: ({ trigger, input, request, blobs, signal }) => held.emb.fire(trigger, input, request, { blobs, signal }),
      types: trigger => held.emb.types(trigger),
      inputFor: (trigger, request) => held.emb.inputFor(trigger, request),
      codecs: root => held.emb.codecsOf(root),
      get blobs() {
        return held.emb.blobs;
      },
      log: held.log,
      observe: listener => held.observe(listener),
      reload: () => held.reload(),
      get root() {
        return held.load.root;
      },
    };
  }
}
