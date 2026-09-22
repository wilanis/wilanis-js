/**
 * `wilanis new graph --store`: the read-decide-write shape, scaffolded. The claim is not that the JSON looks a
 * certain way but that it is the shape whole -- the ids and the routing in place -- and that filling in the
 * TODOs a tool cannot decide is the only work left: the scaffold, written into a copy of the example over its
 * customers store and given the shapes it answers, checks clean.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { scaffold } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const STORE = { store: '@customers/data/customers.store.json', collection: 'customers' };
const CUSTOMER = '@customers/domain/Customer.shape.json';

/** A copy of the example with one scaffolded graph in it, and the graph itself, read back. */
function scaffolded(name: string, opts: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-rdw-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  const [file] = scaffold(dir, 'graph', `features/customers/${name}`, { ...STORE, ...opts });
  const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
  return { dir, file, doc };
}

/** Fill the TODOs a scaffold cannot decide -- what the graph takes and answers, and what a patch changes. */
function fill(dir: string, file: string, changes: Record<string, string>): string[] {
  const at = join(dir, file);
  const filled = readFileSync(at, 'utf8')
    .replaceAll('"in": "TODO"', '"in": "@customers/domain/CustomerRef.shape.json"')
    .replaceAll('"type": "TODO"', `"type": "${CUSTOMER}"`);
  writeFileSync(
    at,
    Object.entries(changes).reduce((text, [was, now]) => text.replaceAll(was, now), filled),
  );
  return checkTree(loadTree(dir, PLUGINS, INCLUDES)).items.map(one => `${one.code} ${one.file}`);
}

/** Every node of a graph, by id and type: what the shape is, read off the document. */
const shapeOf = (doc: Record<string, unknown>) =>
  (doc.nodes as { id: string; type: string }[]).map(
    node => `${node.id} ${node.type === '@wilanis/node/switch.schema.json' ? 'switch' : 'run'}`,
  );

describe('wilanis new graph --store: read, decide, write', () => {
  it('writes the shape whole: the read, the decision, and a write with its own routing per branch', () => {
    const { dir, doc } = scaffolded('note-customer', {
      'read-then': 'patch',
      branch: 'noted:has(record) && !has(record.note)\nrenoted:has(record)',
    });
    expect(shapeOf(doc)).toEqual([
      'asked run',
      'route switch',
      'noted run',
      'notedRoute switch',
      'notedRow run',
      'notedMissing run',
      'renoted run',
      'renotedRoute switch',
      'renotedRow run',
      'renotedMissing run',
      'missing run',
    ]);
    // the read is by the key the graph takes, and the decision routes on what it answered
    const nodes = doc.nodes as Record<string, unknown>[];
    expect(nodes[0]).toMatchObject({ run: '@storage/store.port.json#get', in: { ...STORE, key: '{{in.id}}' } });
    expect(nodes[1]).toMatchObject({
      in: { record: '{{asked.record}}' },
      rules: [
        { when: 'has(record) && !has(record.note)', to: 'noted' },
        { when: 'has(record)', to: 'renoted' },
      ],
      else: 'missing',
    });
    // each write routes on what it answered, so a record gone between the read and the write is a case, not a fault
    expect(nodes[3]).toMatchObject({
      in: { record: '{{noted.record}}' },
      rules: [{ when: 'has(record)', to: 'notedRow' }],
      else: 'notedMissing',
    });
    // every node that can answer is a candidate, in the order the branches were named
    expect(doc.out).toEqual({
      type: 'TODO',
      from: ['notedRow', 'notedMissing', 'renotedRow', 'renotedMissing', 'missing'],
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('checks clean against the example once the TODOs are filled', () => {
    const { dir, file } = scaffolded('note-customer', {
      'read-then': 'patch',
      branch: 'noted:has(record) && !has(record.note)\nrenoted:has(record)',
    });
    expect(fill(dir, file, { '"TODO": "TODO"': '"note": "seen"' })).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('checks clean for each write --read-then names, since each answers the record the same way', () => {
    for (const [write, changes] of [
      ['remove', {}],
      ['put', { '"record": "TODO"': '"record": "{{asked.record}}"' }],
    ] as [string, Record<string, string>][]) {
      const { dir, file, doc } = scaffolded(`probe-${write}`, {
        'read-then': write,
        branch: 'taken:has(record)',
      });
      expect((doc.nodes as { run?: string }[])[2].run).toBe(`@storage/store.port.json#${write}`);
      expect(fill(dir, file, changes), write).toEqual([]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a data graph whatever --layer says, since it reaches a store', () => {
    const { dir, file } = scaffolded('elsewhere', { 'read-then': 'patch', layer: 'domain' });
    expect(file).toBe('features/customers/data/elsewhere.graph.json');
    rmSync(dir, { recursive: true, force: true });
  });

  it('scaffolds one branch to rename where none was named, and refuses a --branch that is not <id>:<when>', () => {
    const { dir, doc } = scaffolded('one-branch', { 'read-then': 'patch' });
    expect(shapeOf(doc)).toEqual([
      'asked run',
      'route switch',
      'changed run',
      'changedRoute switch',
      'changedRow run',
      'changedMissing run',
      'missing run',
    ]);
    expect(() => scaffold(dir, 'graph', 'features/customers/bad', { ...STORE, branch: 'noWhen' })).toThrow(
      "--branch 'noWhen' is not <id>:<when>",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a graph named with no store what it was: one node to replace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-rdw-'));
    cpSync(EXAMPLE, dir, { recursive: true });
    const [file] = scaffold(dir, 'graph', 'features/customers/greet', {});
    expect(file).toBe('features/customers/domain/greet.graph.json');
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
    expect(shapeOf(doc)).toEqual(['first run']);
    rmSync(dir, { recursive: true, force: true });
  });
});
