#!/usr/bin/env node
/** The wilanis command line. */
import { createWriteStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkTree } from '@wilanis/compiler';
import type { BlobHandle, Trace } from '@wilanis/core';
import { KINDS, type Kind, type LoadResult, RefusalList } from '@wilanis/core';
import { loadProject, type ProjectLoad } from './project.js';
import { runSaid } from './run-said.js';
import { runTrigger, start } from './serve.js';
import { type StopInput, stopHook } from './stopping.js';
import {
  describe,
  diagnosticsOf,
  fuzz,
  init,
  ls,
  manifestOf,
  map,
  migrate,
  printed,
  regress,
  rehearse,
  SCENARIOS,
  scaffold,
  withMigration,
  withRegression,
  withRehearsal,
} from './tools.js';
import { atLevel, type Level, traceJson, traceText } from './trace.js';

/** Every flag `wilanis migrate` knows; anything else is exit 2, since a misspelt flag must never silently plan. */
const MIGRATE_FLAGS = ['profile', 'apply', 'allow-destructive', 'adopt', 'history', 'json'];

/**
 * The flags that name one of several things rather than one thing, so a second `--branch` adds a branch instead
 * of replacing the first. Every other flag is last-wins, which is what a caller repeating one by accident means.
 */
const REPEATABLE = ['branch'];

const USAGE = `wilanis -- declarative dataflow, judged by a compiler, run by a stateless engine

  wilanis check    [root] [--json]                 judge the whole tree, under every profile; exit 1 with every refusal
  wilanis rehearse [root] [--seed n] [-v] [--json] run every trigger, and every branch of every switch
  wilanis fuzz     [root] [--runs n]               write one scenario per trigger per seed to scenarios/fuzz/
  wilanis regress  [root] [--json]                 replay every scenario and diff node by node
  wilanis start    [root] [--profile word] [--trace[=text|json]] [--level summary|full]
                   refuse a variable the profile reads that is unset, then run postLoad and the profile's
                   startup steps; what listens is what those steps say
  wilanis run      <trigger> [root] [--in json] [--file path] [--out path] [--at iso] [--trace[=text|json]] [--flag=v ...]
                   fire one trigger; --file hands a file as request.file, --out receives a blob answer;
                   --at 2026-09-11T03:00:00Z fires a scheduled trigger's tick for that instant (request.scheduled);
                   --trace prints what the run did, span by span, on stderr
  wilanis migrate  [root] [--profile word] [--apply] [--allow-destructive a,b] [--adopt] [--history] [--json]   plan the stores against the database; apply when told
                   --allow-destructive names each as <connection>/<target>, the pair that names a table
  wilanis ls       [root] [kind]                   every document, or those of one kind
  wilanis describe <path> [root]                   a document, with its contract laid out
  wilanis map      [root] [--profile word]         trigger → graph → port → binding → graph
  wilanis manifest [root] [--profile word]         what the tree is, as JSON on stdout (packages/runtime/schemas/manifest.schema.json);
                   every profile's block, or the one --profile names; WILANIS_PROFILE is not read
  wilanis new      <kind> <name|path> [root] [--layer edge|data] [--port word] [--run word#op] [--kind k]
                   [--of shape] [--over word#op] [--on shape]
                   graph, read-decide-write: --store <store> --collection <name> --read-then patch|put|remove
                   [--branch <id>:<when> ...] [--type shape]   one write per branch, each routed to by its when;
                   repeat the flag. Its ids name what each node holds: the shape (--type, else the store's), the
                   write, the branch
                   kinds: project feature shape port graph binding store trigger policy resolvers invariant
  wilanis init     [root]                          write CLAUDE.md and agent hooks into a tree
  wilanis stop-hook [root]                         the Stop hook: judge the tree, answer the harness on stdout

check, rehearse, regress and migrate take --json: one JSON object on stdout (RFC 0019's envelope, packages/runtime/
schemas/diagnostics.schema.json), the refusals as data on a refused tree whichever was asked, and the same exit codes.
rehearse, fuzz, regress, start and run take --profile word, and run under it; else under WILANIS_PROFILE, else
under the profile project.json marks "default": true. A project that declares no profile runs its one unnamed one.
Every path is @-rooted (@features/tasks/tasks.port.json) or through a project alias.
Plugins beyond @std and @cli are npm packages named by "from" in project.json.`;

/** What a flag is worth: what follows its `=`, else the next word when that is not a flag, else just being there. */
function flagValue(argv: string[], at: number, written: string | undefined): { value: string; next: number } {
  if (written !== undefined) return { value: written, next: at };
  const following = argv[at + 1];
  if (following !== undefined && !following.startsWith('-')) return { value: following, next: at + 1 };
  return { value: 'true', next: at };
}

function parse(argv: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at];
    if (word === '-v') {
      flags.verbose = 'true';
      continue;
    }
    if (!word.startsWith('--')) {
      positional.push(word);
      continue;
    }
    const [name, written] = word.slice(2).split(/=(.*)/s);
    const { value, next } = flagValue(argv, at, written);
    const before = flags[name];
    flags[name] = REPEATABLE.includes(name) && before !== undefined ? `${before}\n${value}` : value;
    at = next;
  }
  return { flags, positional };
}

/**
 * What `--trace` and `--verbose` print, and nothing where neither was given: a printing observer, on stderr,
 * where a trace belongs whatever stdout is carrying. `--trace=json` writes one object per run for a shipper;
 * anything else writes the text form. `--level` says how much a span may carry, `summary` by default.
 */
function tracing(flags: Record<string, string>): ((trace: Trace) => void) | undefined {
  const asked = flags.trace ?? (flags.verbose ? 'text' : undefined);
  if (asked === undefined) return undefined;
  const level: Level = flags.level === 'full' ? 'full' : 'summary';
  const write = asked === 'json' ? traceJson : traceText;
  return trace => console.error(write(atLevel(trace, level)));
}

async function load(root: string): Promise<ProjectLoad> {
  const abs = resolve(root);
  if (!existsSync(join(abs, 'project.json'))) {
    console.error(`no project.json in ${abs}`);
    process.exit(2);
  }
  return loadProject(abs);
}

/**
 * Load and judge the tree, and stop at a refusal: in words on stderr, or, under `--json`, as the envelope on stdout
 * with `command` set to what was asked, so a refused tree reads the same whichever command met it.
 */
async function check(root: string, json?: string): Promise<ProjectLoad> {
  const loaded = await load(root);
  const answer = checkTree(loaded);
  if (!answer.ok) {
    if (json) console.log(printed(diagnosticsOf(loaded, answer, { command: json, root })));
    else console.error(`${answer.format()}\n\n${answer.items.length} refusal(s)`);
    process.exit(1);
  }
  return loaded;
}

/** The envelope of a tree the checker accepted, for a command to add what it computed to. */
const accepted = (loaded: LoadResult, command: string, root: string) =>
  diagnosticsOf(loaded, new RefusalList(), { command, root });

/** The command's name when `--json` was given, which is what `check` needs to print the envelope; else nothing. */
const jsonOf = (flags: Record<string, string>, command: string) => (flags.json ? command : undefined);

/** What the command line gave: the flags, the words, and the root each command reads from. */
interface Given {
  flags: Record<string, string>;
  positional: string[];
  rootArg: (at: number) => string;
  /** The words after the command, for a command that reads its own flags from them. */
  rest: string[];
}

/** What each command does. Every one works from a loaded, checked tree; `wilanis <cmd> --help` prints USAGE. */
const COMMANDS: Record<string, (given: Given) => Promise<void> | void> = {
  check: async ({ flags, rootArg }) => {
    const loaded = await check(rootArg(0), jsonOf(flags, 'check'));
    if (flags.json) console.log(printed(accepted(loaded, 'check', rootArg(0))));
    else console.log(`ok: ${loaded.registry.files.length} documents`);
  },
  rehearse: async ({ flags, rootArg }) => {
    const loaded = await check(rootArg(0), jsonOf(flags, 'rehearse'));
    const answer = await rehearse(loaded, {
      seed: flags.seed ? Number(flags.seed) : undefined,
      profile: flags.profile,
      verbose: Boolean(flags.verbose),
    });
    if (flags.json) console.log(printed(withRehearsal(accepted(loaded, 'rehearse', rootArg(0)), answer)));
    else console.log(answer.lines.join('\n'));
    if (!answer.ok) process.exit(1);
  },
  fuzz: async ({ flags, rootArg }) => {
    const loaded = await check(rootArg(0));
    // said first, so whoever sees the directory appear knows it is generated and kept out of git, as .wilanis/ is
    console.log(
      `writing scenarios to ${join(loaded.root, SCENARIOS)} -- generated, and ignored by git as .wilanis/ is`,
    );
    const answer = await fuzz(loaded, { runs: flags.runs ? Number(flags.runs) : undefined, profile: flags.profile });
    console.log(answer.written.map(file => `wrote ${file}`).join('\n'));
    if (answer.lines.length) console.error(answer.lines.join('\n'));
    if (!answer.ok) process.exit(1);
  },
  regress: async ({ flags, rootArg }) => {
    const loaded = await check(rootArg(0), jsonOf(flags, 'regress'));
    const answer = await regress(loaded, { profile: flags.profile });
    if (flags.json) console.log(printed(withRegression(accepted(loaded, 'regress', rootArg(0)), answer)));
    else console.log(answer.lines.join('\n') || 'no scenarios -- run wilanis fuzz first');
    if (!answer.ok) process.exit(1);
  },
  start: async ({ flags, rootArg }) => {
    const loaded = await check(rootArg(0));
    const { stop, held } = await start(loaded, { profile: flags.profile, observe: tracing(flags) });
    if (!held) {
      console.log('nothing is held: project.json declares no startup step that listens, so there is nothing to serve');
      await stop();
    }
    const bye = async () => {
      await stop();
      process.exit(0);
    };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  },
  run: async ({ flags, positional, rootArg, rest }) => {
    const loaded = await check(rootArg(1));
    const { flags: f2 } = parse(rest.slice(1));
    let delivered = false;
    const deliver = async (body: Readable, handle: BlobHandle) => {
      delivered = true;
      if (f2.out) {
        await pipeline(body, createWriteStream(f2.out));
        console.error(`wrote ${f2.out} (${handle.contentType}, ${handle.size} bytes)`);
      } else await pipeline(body, process.stdout, { end: false });
    };
    const { report, answer } = await runTrigger(
      loaded,
      positional[0],
      { flags: f2, args: positional.slice(2) },
      {
        profile: flags.profile,
        seed: flags.seed ? Number(flags.seed) : undefined,
        deliver,
        observe: tracing(flags),
      },
    );
    const said = runSaid(report, answer);
    if (said.stdout !== undefined && !delivered) console.log(said.stdout);
    if (said.stderr !== undefined) console.error(said.stderr);
    if (report.status !== 'done') process.exit(1);
  },
  migrate: async ({ flags, rootArg }) => {
    const unknown = Object.keys(flags).filter(name => !MIGRATE_FLAGS.includes(name));
    if (unknown.length) {
      console.error(`wilanis migrate: unknown flag(s) ${unknown.map(name => `--${name}`).join(', ')}\n\n${USAGE}`);
      process.exit(2);
    }
    // migrate judges the tree itself, so that a caller without the command line gets the same guarantee
    const loaded = await load(rootArg(0));
    const answer = await migrate(loaded, {
      profile: flags.profile,
      apply: Boolean(flags.apply),
      allowDestructive: flags['allow-destructive'] ? flags['allow-destructive'].split(',') : [],
      adopt: Boolean(flags.adopt),
      history: Boolean(flags.history),
      // under --json stdout carries the one envelope and nothing else, so what postLoad says goes unsaid
      log: flags.json ? () => {} : undefined,
    });
    if (flags.json) {
      const diag = diagnosticsOf(loaded, { items: answer.refusals }, { command: 'migrate', root: rootArg(0) });
      console.log(printed(withMigration(diag, answer)));
    } else console.log(answer.lines.join('\n'));
    if (answer.code) process.exit(answer.code);
  },
  ls: async ({ positional }) => {
    const kind = positional.find(word => (KINDS as string[]).includes(word)) as Kind | undefined;
    const root = positional.find(word => !(KINDS as string[]).includes(word)) ?? '.';
    console.log(ls(await load(root), kind).join('\n'));
  },
  describe: async ({ positional, rootArg }) => {
    console.log(describe(await load(rootArg(1)), positional[0]));
  },
  map: async ({ flags, rootArg }) => {
    console.log(map(await load(rootArg(0)), flags.profile).join('\n'));
  },
  // judged first, as start is: the manifest of a tree with an unresolved reference would describe nothing real
  manifest: async ({ flags, rootArg }) => {
    const loaded = await check(rootArg(0));
    console.log(JSON.stringify(manifestOf(loaded, { root: rootArg(0), profile: flags.profile }), null, 2));
  },
  new: async ({ flags, positional, rootArg }) => {
    const [kind, target] = positional;
    if (!kind || !target) {
      console.error(USAGE);
      process.exit(2);
    }
    console.log(
      scaffold(resolve(rootArg(2)), kind, target, flags)
        .map(file => `wrote ${file}`)
        .join('\n'),
    );
  },
  init: async ({ rootArg }) => {
    console.log(init(resolve(rootArg(0))).join('\n'));
  },
  // the Stop hook: the harness hands it JSON on stdin and reads JSON back, so nothing else may reach stdout
  'stop-hook': async ({ rootArg }) => {
    const answer = await stopHook(await stdinJson(), resolve(rootArg(0)));
    if (Object.keys(answer).length) console.log(JSON.stringify(answer));
  },
};

/** What the harness wrote on stdin, as an object; an empty one where it wrote nothing or nothing parseable. */
async function stdinJson(): Promise<StopInput> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as StopInput;
  } catch {
    return {};
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parse(rest);
  const run = COMMANDS[cmd ?? ''];
  if (!run) {
    console.log(USAGE);
    process.exit(cmd ? 2 : 0);
  }
  await run({ flags, positional, rest, rootArg: (at: number) => positional[at] ?? '.' });
}

main().catch(error => {
  console.error((error as Error).message);
  process.exit(1);
});
