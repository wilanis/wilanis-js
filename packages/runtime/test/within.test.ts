/**
 * G028: a path within the element is typed (RFC 0039). A plugin whose operation takes a list, the type of its
 * elements, and two static paths within that type -- one to a string, one to a number -- and a graph that calls it.
 * The checker holds each path to a field the bound type has, required at every step, and of the type the contract
 * says it `reaches`; `describe` says what such a field is, so a reader of the port need not guess.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, NODE_RUN, type PluginModule, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, describe as describeDoc } from '../src/index.js';
import { docsDir } from './example-harness.js';

/** A plugin granting one pure operation that totals a list by a path within its element. */
const grouper: PluginModule = {
  root: '@grouper',
  docs: docsDir({
    'plugin.json': {
      $schema: schemaUrl('plugin'),
      description: 'a plugin that totals a list by a field of its elements',
      grants: {},
    },
    'group.port.json': {
      $schema: schemaUrl('port'),
      description: 'totals over a list',
      operations: {
        totals: {
          description: 'how many elements share each value of `by`',
          accepts: {
            list: { type: '$T[]' },
            type: { type: 'type', binds: '$T' },
            by: { type: 'string', static: true, within: '$T', reaches: 'string', description: 'the key' },
            sum: { type: 'string', static: true, required: false, within: '$T', reaches: 'number' },
          },
          returns: 'number',
          pure: true,
        },
      },
    },
  }),
  handlers: { 'group.port.json#totals': async () => 0 },
};

const ORDER = '@features/orders/domain/Order.shape.json';

/** A tree with one shape of order and one graph that totals a batch of them, given the node's `in`. */
function tree(given: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-within-'));
  const write = (file: string, doc: unknown) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(doc));
  };
  write('project.json', {
    $schema: schemaUrl('project'),
    name: 'orders',
    description: 'a tree that totals its orders',
    plugins: [{ use: '@std' }, { use: '@grouper' }],
  });
  write('features/orders/feature.json', { $schema: schemaUrl('feature'), description: 'orders and their totals' });
  write('features/orders/domain/Order.shape.json', {
    $schema: schemaUrl('shape'),
    description: 'one order',
    layer: 'core',
    fields: {
      tier: { type: 'string' },
      total: { type: 'number' },
      active: { type: 'boolean', required: false },
      buyer: { type: { fields: { name: { type: 'string' }, nick: { type: 'string', required: false } } } },
    },
  });
  write('features/orders/domain/Batch.shape.json', {
    $schema: schemaUrl('shape'),
    description: 'orders handed in together',
    layer: 'core',
    fields: { orders: { type: `${ORDER}[]` } },
  });
  write('features/orders/domain/total.graph.json', {
    $schema: schemaUrl('graph'),
    description: 'total a batch of orders',
    in: '@features/orders/domain/Batch.shape.json',
    nodes: [{ type: NODE_RUN, id: 'tiers', run: '@grouper/group.port.json#totals', in: given }],
    out: { type: 'number', from: 'tiers' },
  });
  return dir;
}

const TOTALS = { list: '{{in.orders}}', type: ORDER, by: 'tier', sum: 'total' };

/** The refusals one tree answers with, as `code at`, `message` and `hint`, then the tree is taken away. */
function refusalsOf(given: Record<string, unknown>) {
  const dir = tree(given);
  try {
    const loaded = loadTree(dir, { ...BUILTIN_PLUGINS, '@grouper': grouper });
    return [...loaded.refusals.items, ...checkTree(loaded).items];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pointing = (given: Record<string, unknown>) => refusalsOf(given).map(one => `${one.code} ${one.at ?? ''}`.trim());

describe('G028: a path within the element is typed', () => {
  it('a path to a required field of the type it reaches passes, nested or not, and an optional one may be left out', () => {
    expect(pointing(TOTALS)).toEqual([]);
    expect(pointing({ ...TOTALS, by: 'buyer.name' })).toEqual([]);
    const { sum: _, ...unsummed } = TOTALS;
    expect(pointing(unsummed)).toEqual([]);
  });

  it('a path the element does not hold, at the field that names it, with the fields it could name', () => {
    const [refusal] = refusalsOf({ ...TOTALS, by: 'teir' });
    expect(refusal.code).toBe('G028');
    expect(refusal.at).toBe('nodes/tiers/in/by');
    expect(refusal.message).toBe("by: 'teir' is not a field of @features/orders/domain/Order.shape.json");
    expect(refusal.hint).toBe('name a required string field of the element: tier, buyer.name');
    expect(pointing({ ...TOTALS, by: 'buyer.age' })).toEqual(['G028 nodes/tiers/in/by']);
  });

  it('a path that passes through a field that may be missing, though it ends at the type it reaches', () => {
    expect(pointing({ ...TOTALS, by: 'buyer.nick' })).toEqual(['G028 nodes/tiers/in/by']);
    expect(refusalsOf({ ...TOTALS, by: 'buyer.nick' })[0].message).toMatch(/may be missing/);
  });

  it('a path that is optional and of another type, or required and of another type', () => {
    expect(pointing({ ...TOTALS, by: 'active' })).toEqual(['G028 nodes/tiers/in/by']);
    const [named] = refusalsOf({ ...TOTALS, sum: 'tier' });
    expect(`${named.code} ${named.at}`).toBe('G028 nodes/tiers/in/sum');
    expect(named.message).toBe("sum: 'tier' is string, not number");
    expect(named.hint).toBe('name a required number field of the element: total');
  });

  it('a read where a path is written is P001, as for any static field, and G028 says nothing more', () => {
    expect(pointing({ ...TOTALS, by: '{{in.orders}}' }).map(line => line.split(' ')[0])).toEqual(['P001']);
  });
});

describe('describe and the keywords', () => {
  it('says a field is a path within a bound type, and what it reaches', () => {
    const dir = tree(TOTALS);
    try {
      const said = describeDoc(loadTree(dir, { ...BUILTIN_PLUGINS, '@grouper': grouper }), '@grouper/group.port.json');
      expect(said).toContain('in  by: string  (static)  (a path within $T to a string)  -- the key');
      expect(said).toContain('in  sum?: string  (static)  (a path within $T to a number)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
