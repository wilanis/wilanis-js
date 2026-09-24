/** wilanis start: run every plugin's postLoad, then the project's startup steps -- what listens is what those steps say. wilanis run: fire one cli trigger. */
import { createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import type { Readable } from 'node:stream';
import {
  type BlobHandle,
  isBlobHandle,
  type Loaded,
  type LoadResult,
  runsUnder,
  Scope,
  type Trace,
  type TriggerDoc,
} from '@wilanis/core';
import { type Outcome, outcomeOf, type Report } from '@wilanis/engine';
import { FileBlobStore } from './blobs.js';
import type { Embedder } from './embed.js';
import { postLoad, stopEach } from './post-load.js';
import { activeProfile, secretsRefusal } from './profile.js';
import { Served } from './served.js';
import { embedderFor } from './tools.js';

/**
 * Run the project's startup steps that run under the profile (`startup[].profiles` absent or naming it), in
 * order, before any trigger kind starts: each fires the domain port operation it names, and the profile's
 * binding decides how it is met. A step that does not answer stops serving unless it says `required: false`,
 * in which case how it ended is logged and the rest go on. The log line and the throw name a step the same
 * way: its one-based place among the steps this profile runs, its name, and its outcome. The trace keeps the
 * step's index in `project.json → startup`, which is where a reader finds it.
 */
export async function runStartup(
  load: LoadResult,
  emb: Embedder,
  log: (line: string) => void,
  profile?: string,
): Promise<void> {
  const steps = [...(load.registry.project?.doc.startup ?? []).entries()].filter(([, step]) =>
    runsUnder(step, profile),
  );
  for (const [nth, [at, step]] of steps.entries()) {
    const said = `${nth + 1}/${steps.length} ${step.label ?? step.run}`;
    const why = failureOf(outcomeOf(await emb.startup(step, { at })));
    if (why === undefined) {
      log(`startup ${said}: ok`);
      continue;
    }
    if (step.required === false) {
      log(`startup ${said}: ${why} (optional, going on)`);
      continue;
    }
    throw new Error(
      `startup step ${said}: ${why}; nothing is serving. Mark it "required": false in project.json to serve without it.`,
    );
  }
}

/** How a step that did not answer ended, in the outcome's words; nothing for one that answered. */
function failureOf(outcome: Outcome): string | undefined {
  if (outcome.kind === 'refused') return `refused as '${outcome.reason}': ${outcome.message}`;
  if (outcome.kind === 'faulted') return `failed at '${outcome.at}': ${outcome.error}`;
  if (outcome.kind === 'blocked') return `blocked: needs ${outcome.needs.join(', ')}`;
  if (outcome.kind === 'cancelled') return 'cancelled';
  return undefined;
}

/** What a start is told: the profile asked for, the environment read, where it logs, and who hears every run. */
interface StartOptions {
  /** `--profile`; else `WILANIS_PROFILE` in `env`, else the profile marked default (`activeProfile`). */
  profile?: string;
  /** Where the profile's name and its secrets are read; `process.env` unless given. */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  observe?: (trace: Trace) => void;
}

/**
 * The profile a start runs under, said first, and refused before anything is set up where a variable its
 * reach reads is not set: no postLoad has run, and nothing has opened a socket or a pool, when it prints.
 */
function chosen(load: LoadResult, env: NodeJS.ProcessEnv, flag: string | undefined, log: (line: string) => void) {
  const profile = activeProfile(load.registry.project?.doc, { flag, env });
  log(`profile ${profile ?? 'none declared'}`);
  const refused = secretsRefusal(new Scope(load.registry, load.resolve), profile, env);
  if (refused) throw new Error(`${refused}; nothing is serving`);
  return profile;
}

/**
 * Load a tree, pick its profile (`activeProfile`), refuse it where a variable its reach reads is unset, run
 * every plugin's postLoad, then the startup steps that profile runs -- and nothing else. What listens, and
 * whether anything listens at all, is what those steps say: a tree whose startup names no `holds` operation
 * serves nothing and this answers at once. Answers the way to stop what was held. An `observe` given here is
 * registered before the first step runs, so the steps' own traces reach it too -- an exporter that a step
 * starts can only ever hear what ran after it.
 */
export async function start(
  load: LoadResult,
  opts: StartOptions = {},
): Promise<{ stop: () => Promise<void>; held: number }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const env = opts.env ?? process.env;
  const profile = chosen(load, env, opts.profile, log);
  const emb = embedderFor(load, { profile, env });
  const served = new Served({ load, emb }, log, { profile, env });
  if (opts.observe) served.observe(opts.observe);
  emb.serve(served);
  // what was held, in reverse, then the plugins' own teardowns (which say for themselves what would not stop),
  // then the blob store: each runs whatever the one before it threw
  const bye = () =>
    stopEach(
      [
        ...[...served.emb.held].reverse(),
        { stop: () => served.stopPlugins() },
        { label: 'the blob store', stop: async () => destroyed(emb) },
      ],
      log,
    );
  try {
    served.setDown(await postLoad(load, emb, log));
    await runStartup(load, emb, log, profile);
  } catch (error) {
    // what would not stop has been logged; the error that stopped the start is the one to answer
    await bye().catch(() => undefined);
    throw error;
  }
  return { stop: bye, held: emb.held.length };
}

/** Remove what the embedder's blob store wrote, where that store is one on disk. */
function destroyed(emb: Embedder): void {
  if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
}

/** The content type a file on disk is taken to have, by its extension; anything else is a stream of bytes. */
const BY_EXTENSION: Record<string, string> = {
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
};
/** The content type a file on disk is taken to have, read off its extension; anything unknown is a stream of bytes. */
export const contentTypeOf = (file: string) => BY_EXTENSION[extname(file).toLowerCase()] ?? 'application/octet-stream';

/** What a run answers: what the trigger kind's runtime encodes, or the report's own output. */
function encoded(load: LoadResult, trigger: Loaded<TriggerDoc>, report: Report) {
  const runtime = load.plugins
    .flatMap(plugin => Object.entries(plugin.triggers ?? {}))
    .find(([kind]) => kind === load.resolve(trigger.doc.kind))?.[1];
  return runtime?.encode ? runtime.encode(trigger.doc, report) : report.output;
}

/** What a command line hands a trigger: its flags and arguments, a body from --in, and a file streamed into the registry. */
async function requestOf(
  flags: Record<string, string>,
  args: string[],
  blobs: { put: (source: Readable, meta: { contentType: string; filename: string }) => Promise<BlobHandle> },
): Promise<Record<string, unknown>> {
  const request: Record<string, unknown> = { flags, args, cwd: process.cwd() };
  if (flags.in !== undefined) request.body = JSON.parse(flags.in);
  if (flags.file !== undefined)
    request.file = await blobs.put(createReadStream(flags.file), {
      contentType: contentTypeOf(flags.file),
      filename: basename(flags.file),
    });
  return request;
}

/** What one command-line run is fired through: the trigger, the embedder set up for it, and its teardown. */
interface OneRun {
  found: Loaded<TriggerDoc>;
  emb: Embedder;
  down: () => Promise<void>;
}

/**
 * Everything a one-shot run needs before it fires: the trigger the reference names, an embedder for the
 * profile (`activeProfile`, as `start` picks it) and seed, the observer registered through a `Served` of its own -- the server an observer registers
 * with here exactly as it is under `start`, so `--trace` reads what an exporter would be handed -- and the
 * plugins' postLoad, which a seeded run skips because nothing of it ever leaves the process.
 */
async function readied(
  load: LoadResult,
  ref: string,
  opts: { profile?: string; seed?: number; log: (line: string) => void; observe?: (trace: Trace) => void },
): Promise<OneRun> {
  const found = load.registry.get('trigger', load.resolve(ref));
  if (!found) throw new Error(`no trigger at '${ref}'`);
  const profile = activeProfile(load.registry.project?.doc, { flag: opts.profile, env: process.env });
  const emb = embedderFor(load, { profile, seed: opts.seed });
  if (opts.observe) {
    const served = new Served({ load, emb }, opts.log, { profile, env: process.env });
    served.observe(opts.observe);
    emb.serve(served);
  }
  return { found, emb, down: opts.seed === undefined ? await postLoad(load, emb, opts.log) : async () => {} };
}

/**
 * Fire a trigger from the command line with a context built from flags and args. A real run (no seed)
 * runs postLoad first and its teardown after; a seeded run stubs every effect and skips the hooks. `--file`
 * streams a file into the blob registry and hands its handle as request.file; a blob answer is streamed to
 * `--out`, or to stdout, by `deliver`. The run's blobs are released once delivered. An `observe` given here is
 * handed the trace of the fire, the same one a tree being served would hand an exporter.
 */
export async function runTrigger(
  load: LoadResult,
  ref: string,
  given: { flags?: Record<string, string>; args?: string[] } = {},
  opts: {
    profile?: string;
    seed?: number;
    log?: (line: string) => void;
    deliver?: (body: Readable, handle: BlobHandle) => Promise<void>;
    observe?: (trace: Trace) => void;
  } = {},
) {
  const log = opts.log ?? ((line: string) => console.error(line));
  const { found, emb, down } = await readied(load, ref, { ...opts, log });
  const blobs = emb.blobs.scope();
  try {
    const request = await requestOf(given.flags ?? {}, given.args ?? [], blobs);
    const built = emb.inputFor(found.doc, request);
    if ('error' in built) throw new Error(`input: ${built.error}`);
    const report = await emb.fire(found.doc, built.input, request, { blobs });
    const answer = encoded(load, found, report);
    if (isBlobHandle(answer) && opts.deliver) await opts.deliver(blobs.open(answer), answer);
    return { report, answer };
  } finally {
    await blobs.release();
    await down();
    destroyed(emb);
  }
}
