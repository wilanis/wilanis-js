/**
 * A tree whose one effect is a scripted upstream, for what the compiler's retry wrapper does (RFC 0011). The fake
 * plugin's `ask` counts every call and does what the case's script says of it: fault, hang until told to stop,
 * refuse, or answer a status. `ask` runs it once on `asked`; `each` maps it over three items on `each`; a case
 * puts `retry` and `timeoutMs` on either node, or on the binding's `ask`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree, runGraph } from '@wilanis/compiler';
import { type Kind, loadTree, type PluginModule, type Retry, Scope, schemaRef, schemaUrl } from '@wilanis/core';
import { Refusal, type Report } from '@wilanis/engine';
import { BUILTIN_PLUGINS, Embedder } from '../src/index.js';
import { docsDir } from './example-harness.js';

/** What one call does: fault, hang until its signal aborts, refuse `missing`, or answer `{ status }`. */
export type Step = 'fault' | 'hang' | 'refuse' | number;

/** The upstream a case scripts: what each call does, by item and how many times that item was asked before. */
export interface Upstream {
  next: (item: string, before: number) => Step;
  /** every call, by item, in the order it was made */
  calls: string[];
  /** the signal each call was handed, in the same order */
  signals: (AbortSignal | undefined)[];
}

/** What a case writes on a site: the words RFC 0011 adds. */
export interface Said {
  retry?: Retry;
  timeoutMs?: number;
}

/** Where a case writes them: the run node, the map node, the binding's `ask`. */
export interface Placed {
  asked?: Said;
  each?: Said;
  binding?: Said;
}

/** An upstream that does `steps` in order for every item, and answers 200 once they run out. */
export function scripted(steps: Step[] | ((item: string, before: number) => Step)): Upstream {
  const next = typeof steps === 'function' ? steps : (_: string, before: number) => steps[before] ?? 200;
  return { next, calls: [], signals: [] };
}

function act(step: Step, signal: AbortSignal | undefined): Promise<unknown> {
  if (step === 'fault') return Promise.reject(new Error('the upstream dropped the call'));
  if (step === 'refuse') return Promise.reject(new Refusal('missing', 'no such item'));
  if (step === 'hang')
    return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('stopped'))));
  return Promise.resolve({ status: step });
}

function flaky(upstream: Upstream): PluginModule {
  return {
    root: '@flaky',
    docs: docsDir({
      'plugin.json': {
        $schema: schemaRef('plugin'),
        description: 'an upstream that does what a test says',
        grants: { ports: ['@flaky/flaky.port.json'] },
      },
      'flaky.port.json': {
        $schema: schemaRef('port'),
        description: 'asking the scripted upstream',
        operations: {
          ask: {
            description: 'Ask about one item.',
            idempotent: true,
            accepts: { item: { type: 'string' } },
            returns: { fields: { status: { type: 'number' } } },
          },
        },
      },
    }),
    handlers: {
      '@flaky/flaky.port.json#ask': async ({ in: input, ctx }) => {
        const item = String(input.item);
        const before = upstream.calls.filter(one => one === item).length;
        upstream.calls.push(item);
        upstream.signals.push(ctx.signal);
        return act(upstream.next(item, before), ctx.signal);
      },
    },
  };
}

const node = (type: 'run' | 'map', id: string, rest: object) => ({
  type: schemaRef(`node/${type}`),
  id,
  run: '@flaky/flaky.port.json#ask',
  ...rest,
});

/** The tree's directory, with the words a case places. */
function flakyTree(placed: Placed): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-attempts-'));
  const put = (rel: string, doc: object) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    const kind = rel
      .replace(/\.json$/, '')
      .split(/[./]/)
      .at(-1) as Kind;
    writeFileSync(join(dir, rel), JSON.stringify({ $schema: schemaUrl(kind), description: 'd', ...doc }));
  };
  const domain = '@features/flaky/domain';
  put('project.json', { name: 'flaky', plugins: [{ use: '@std' }, { use: '@flaky' }] });
  put('features/flaky/feature.json', { effects: ['@flaky/flaky.port.json#ask'] });
  put('features/flaky/domain/Item.shape.json', { layer: 'core', fields: { item: { type: 'string' } } });
  put('features/flaky/domain/Answer.shape.json', { layer: 'core', fields: { status: { type: 'number' } } });
  put('features/flaky/domain/flaky.port.json', {
    operations: {
      ask: { description: 'd', accepts: { item: { type: 'string' } }, returns: `${domain}/Answer.shape.json` },
      each: { description: 'd', returns: `${domain}/Answer.shape.json[]` },
    },
  });
  put('features/flaky/data/flaky.binding.json', {
    port: `${domain}/flaky.port.json`,
    operations: {
      ask: { graph: '@features/flaky/data/ask.graph.json', ...placed.binding },
      each: { graph: '@features/flaky/data/each.graph.json' },
    },
  });
  put('features/flaky/data/ask.graph.json', {
    in: `${domain}/Item.shape.json`,
    out: { type: `${domain}/Answer.shape.json`, from: 'asked' },
    nodes: [node('run', 'asked', { in: { item: '{{in.item}}' }, ...placed.asked })],
  });
  put('features/flaky/data/each.graph.json', {
    out: { type: `${domain}/Answer.shape.json[]`, from: 'each' },
    nodes: [node('map', 'each', { over: ['a', 'b', 'c'], in: {}, ...placed.each })],
  });
  return dir;
}

/** Run one operation of the tree against `upstream`, and answer the report of the binding's call. */
export async function running(op: 'ask' | 'each', upstream: Upstream, placed: Placed = {}): Promise<Report> {
  const dir = flakyTree(placed);
  try {
    const loaded = loadTree(dir, { ...BUILTIN_PLUGINS, '@flaky': flaky(upstream) });
    const refused = checkTree(loaded).format();
    if (refused) throw new Error(`the tree a case runs must itself pass:\n${refused}`);
    const embedder = new Embedder(new Scope(loaded.registry, loaded.resolve), loaded.plugins, { env: {}, root: dir });
    const compiled = embedder.operation(`@features/flaky/domain/flaky.port.json#${op}`);
    return await runGraph(compiled, { initial: { in: op === 'ask' ? { item: 'a' } : {} }, env: embedder.env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
