#!/usr/bin/env node
/** The wilanis command line. */
import { createWriteStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkTree } from '@wilanis/compiler';
import type { BlobHandle, Trace } from '@wilanis/core';
import { KINDS, type Kind, type LoadResult } from '@wilanis/core';
import { loadProject } from './project.js';
import { runSaid } from './run-said.js';
import { runTrigger, start } from './serve.js';
import { type StopInput, stopHook } from './stopping.js';
import { describe, fuzz, init, ls, map, migrate, regress, rehearse, SCENARIOS, scaffold } from './tools.js';
import { atLevel, type Level, traceJson, traceText } from './trace.js';

/** Every flag `wilanis migrate` knows; anything else is exit 2, since a misspelt flag must never silently plan. */
const MIGRATE_FLAGS = ['profile', 'apply', 'allow-destructive', 'adopt', 'history', 'json'];

/**
 * The flags that name one of several things rather than one thing, so a second `--branch` adds a branch instead
 * of replacing the first. Every other flag is last-wins, which is what a caller repeating one by accident means.
 */
const REPEATABLE = ['branch'];

const USAGE = `wilanis -- declarative dataflow, judged by a compiler, run by a stateless engine

  wilanis check    [root] [--profile word]            judge the whole tree; exit 1 with every refusal
  wilanis rehearse [root] [--seed n] [-v]          run every trigger, and every branch of every switch
  wilanis fuzz     [root] [--runs n]               write one scenario per trigger per seed to scenarios/
  wilanis regress  [root]                          replay every scenario and diff node by node
  wilanis start    [root] [--profile word] [--trace[=text|json]] [--level summary|full]
                   run postLoad and the project's startup steps; what listens is what those steps say
  wilanis run      <trigger> [root] [--in json] [--file path] [--out path] [--trace[=text|json]] [--flag=v ...]
                   fire one cli trigger; --file hands a file as request.file, --out receives a blob answer;
                   --trace prints what the run did, span by span, on stderr
  wilanis migrate  [root] [--profile word] [--apply] [--allow-destructive a,b] [--adopt] [--history] [--json]   plan the stores against the database; apply when told
                   --allow-destructive names each as <connection>/<target>, the pair that names a table
  wilanis ls       [root] [kind]                   every document, or those of one kind
  wilanis describe <path> [root]                   a document, with its contract laid out
  wilanis map      [root] [--profile word]         trigger → graph → port → binding → graph
  wilanis new      <kind> <name|path> [root] [--layer edge|data] [--port word] [--run word#op] [--kind k]
                   [--of shape] [--over word#op] [--on shape]
                   graph, read-decide-write: --store <store> --collection <name> --read-then patch|put|remove
                   [--branch <id>:<when> ...]   one write per branch, each routed to by its when; repeat the flag
                   kinds: project feature shape port graph binding store trigger policy resolvers invariant
  wilanis init     [root]                          write CLAUDE.md and agent hooks into a tree
  wilanis stop-hook [root]                         the Stop hook: judge the tree, answer the harness on stdout

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

async function load(root: string): Promise<LoadResult> {
  const abs = resolve(root);
  if (!existsSync(join(abs, 'project.json'))) {
    console.error(`no project.json in ${abs}`);
    process.exit(2);
  }
  return loadProject(abs);
}

async function check(root: string): Promise<LoadResult> {
  const loaded = await load(root);
  const answer = checkTree(loaded);
  if (!answer.ok) {
    console.error(answer.format());
    console.error(`\n${answer.items.length} refusal(s)`);
    process.exit(1);
  }
  return loaded;
}

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
  check: async ({ rootArg }) => {
    const loaded = await check(rootArg(0));
    console.log(`ok: ${loaded.registry.files.length} documents`);
  },
  rehearse: async ({ flags, rootArg }) => {
    const loaded = await check(rootArg(0));
    const answer = await rehearse(loaded, {
      seed: flags.seed ? Number(flags.seed) : undefined,
      profile: flags.profile,
      verbose: Boolean(flags.verbose),
    });
    console.log(answer.lines.join('\n'));
    if (!answer.ok) process.exit(1);
  },
  fuzz: async ({ flags, rootArg }) => {
    const loaded = await check(rootArg(0));
    // said first, so whoever sees the directory appear knows it is generated and kept out of git, as .wilanis/ is
    console.log(
      `writing scenarios to ${join(loaded.root, SCENARIOS)} -- generated, and ignored by git as .wilanis/ is`,
    );
    const written = await fuzz(loaded, { runs: flags.runs ? Number(flags.runs) : undefined, profile: flags.profile });
    console.log(written.map(file => `wrote ${file}`).join('\n'));
  },
  regress: async ({ flags, rootArg }) => {
    const loaded = await check(rootArg(0));
    const answer = await regress(loaded, { profile: flags.profile });
    console.log(answer.lines.join('\n') || 'no scenarios -- run wilanis fuzz first');
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
    if (flags.json) {
      // RFC 0019's envelope, and its field names, are settled by issue #228, which is still open.
      console.error('wilanis migrate --json waits on the envelope of RFC 0019 (issue #228); run without --json');
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
    });
    console.log(answer.lines.join('\n'));
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
