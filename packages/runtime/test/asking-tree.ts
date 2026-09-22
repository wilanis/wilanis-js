/**
 * A tree of two cli triggers and nothing else: `ask` fires a graph whose one effect, `asked`, throws `boom`;
 * `find` fires a graph that refuses `missing`. What `wilanis run` says of a fault and of a refusal, side by side.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Kind, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import { docsDir } from './example-harness.js';

/** The plugin behind `asked`: one operation, and it never answers. */
const fake: PluginModule = {
  root: '@fake',
  docs: docsDir({
    'plugin.json': { $schema: schemaRef('plugin'), description: 'd', grants: { ports: ['@fake/ask.port.json'] } },
    'ask.port.json': {
      $schema: schemaRef('port'),
      description: 'd',
      operations: { ask: { description: 'ask the upstream', returns: 'string' } },
    },
  }),
  handlers: {
    '@fake/ask.port.json#ask': async () => {
      throw new Error('boom');
    },
  },
};

/** The tree's directory, written fresh, and the plugins beyond the built-in ones it names. */
export function askingTree(): { dir: string; plugins: Record<string, PluginModule> } {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-asking-'));
  const put = (rel: string, doc: object) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    const kind = rel
      .replace(/\.json$/, '')
      .split(/[./]/)
      .at(-1) as Kind;
    writeFileSync(join(dir, rel), JSON.stringify({ $schema: schemaUrl(kind), description: 'd', ...doc }));
  };
  const node = (id: string, run: string, input?: object) => ({
    type: '@wilanis/node/run.schema.json',
    id,
    run,
    in: input,
  });
  put('project.json', { name: 'asking', plugins: [{ use: '@std' }, { use: '@cli' }, { use: '@fake' }] });
  put('features/asking/feature.json', { exports: [], effects: ['@fake/ask.port.json#ask'] });
  put('features/asking/domain/asking.port.json', {
    operations: { ask: { description: 'd', returns: 'string' }, find: { description: 'd', returns: 'string' } },
  });
  put('features/asking/data/asking.binding.json', {
    port: '@features/asking/domain/asking.port.json',
    operations: {
      ask: { graph: '@features/asking/data/ask.graph.json' },
      find: { graph: '@features/asking/data/find.graph.json' },
    },
  });
  put('features/asking/data/ask.graph.json', {
    out: { type: 'string', from: 'asked' },
    nodes: [node('asked', '@fake/ask.port.json#ask')],
  });
  put('features/asking/data/find.graph.json', {
    out: { type: 'string', from: 'missing' },
    nodes: [
      node('missing', '@std/outcome.port.json#refuse', { reason: 'missing', message: 'no such thing', type: 'string' }),
    ],
  });
  for (const op of ['ask', 'find'])
    put(`features/asking/edge/${op}.trigger.json`, {
      kind: '@cli/cli.trigger-kind.json',
      settings: {},
      out: 'string',
      fire: { run: `@features/asking/domain/asking.port.json#${op}` },
    });
  return { dir, plugins: { '@fake': fake } };
}
