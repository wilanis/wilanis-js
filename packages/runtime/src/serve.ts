/** wilanis start: run every plugin's postLoad, then the project's startup steps -- what listens is what those steps say. wilanis run: fire one cli trigger. */
import { createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import type { Readable } from 'node:stream';
import {
  type BlobHandle,
  isBlobHandle,
  type Loaded,
  type LoadResult,
  type Trace,
  type TriggerDoc,
} from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { FileBlobStore } from './blobs.js';
import type { Embedder } from './embed.js';
import { postLoad } from './post-load.js';
import { Served } from './served.js';
import { embedderFor } from './tools.js';

/**
 * Run the project's startup steps in order, before any trigger kind starts: each fires the domain port
 * operation it names, and the profile's binding decides how it is met. A step that refuses stops serving
 * unless it says `required: false`, in which case the refusal is logged and the rest go on.
 */
export async function runStartup(load: LoadResult, emb: Embedder, log: (line: string) => void): Promise<void> {
  const steps = load.registry.project?.doc.startup ?? [];
  for (const [at, step] of steps.entries()) {
    const name = step.label ?? step.run;
    const report = await emb.startup(step, { at });
    if (report.status === 'done') {
      log(`startup ${at + 1}/${steps.length} ${name}: ok`);
      continue;
    }
    const why = failureOf(report);
    if (step.required === false) {
      log(`startup ${at + 1}/${steps.length} ${name}: ${why} (optional, going on)`);
      continue;
    }
    throw new Error(
      `startup step ${at} '${name}' ${why}; nothing is serving. Mark it "required": false in project.json to serve without it.`,
    );
  }
}

/** Why a report did not reach done: the first node that did not finish, and what it said. */
function failureOf(report: Report): string {
  if (report.status === 'blocked') return `is blocked, needing ${(report.needs ?? []).join(', ')}`;
  for (const [id, node] of Object.entries(report.nodes)) {
    if (node.status !== 'failed') continue;
    return node.reason ? `refused at '${id}' with '${node.reason}': ${node.error}` : `failed at '${id}': ${node.error}`;
  }
  return `did not finish (${report.status})`;
}

/**
 * Load a tree, run every plugin's postLoad, then run the project's startup steps -- and nothing else. What
 * listens, and whether anything listens at all, is what those steps say: a tree whose startup names no
 * `holds` operation serves nothing and this answers at once. Answers the way to stop what was held.
 * An `observe` given here is registered before the first step runs, so the steps' own traces reach it too --
 * an exporter that a step starts can only ever hear what ran after it.
 */
export async function start(
  load: LoadResult,
  opts: { profile?: string; log?: (line: string) => void; observe?: (trace: Trace) => void } = {},
): Promise<{ stop: () => Promise<void>; held: number }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const emb = embedderFor(load, { profile: opts.profile });
  if (emb.missingSecrets.length) throw new Error(`missing secrets: ${emb.missingSecrets.join(', ')}`);
  const served = new Served({ load, emb }, log, opts.profile);
  if (opts.observe) served.observe(opts.observe);
  emb.serve(served);
  served.setDown(await postLoad(load, emb, log));
  const bye = async () => {
    for (const holding of [...served.emb.held].reverse()) await holding.stop();
    await served.stopPlugins();
    if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
  };
  try {
    await runStartup(load, emb, log);
  } catch (error) {
    await bye();
    throw error;
  }
  return { stop: bye, held: emb.held.length };
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
 * profile and seed, the observer registered through a `Served` of its own -- the server an observer registers
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
  const emb = embedderFor(load, { profile: opts.profile, seed: opts.seed });
  if (opts.observe) {
    const served = new Served({ load, emb }, opts.log, opts.profile);
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
    if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
  }
}
