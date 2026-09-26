/**
 * `wilanis new graph --read-then`: the read-decide-write shape, scaffolded. The claim is not that the JSON looks a
 * certain way but that it is the shape whole -- the ids and the routing in place -- and that filling in the
 * TODOs a tool cannot decide is the only work left: the scaffold, written into a copy of the example over its
 * customers store and given the shapes it answers, checks clean. It replaces or removes a record; it never
 * patches one (RFC 0035), and `--read-then patch` is refused with the pair that changes a record whole.
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
const REF = '@customers/domain/CustomerRef.shape.json';

/** A copy of the example with one scaffolded graph in it, and the graph itself, read back. */
function scaffolded(name: string, opts: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-rdw-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  const [file] = scaffold(dir, 'graph', `features/customers/${name}`, { ...STORE, ...opts });
  const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
  return { dir, file, doc };
}

/** Fill the TODOs a scaffold cannot decide -- what the graph takes and answers -- and check the tree. */
function fill(dir: string, file: string, changes: Record<string, string>): string[] {
  const at = join(dir, file);
  const filled = readFileSync(at, 'utf8')
    .replaceAll('"in": "TODO"', `"in": "${REF}"`)
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

/** Two branches over what the record holds: one for an account that has lapsed, one for any other. */
const BRANCHES = 'lapsed:has(record) && !has(record.active)\nclosed:has(record)';

describe('wilanis new graph --read-then: read, decide, write', () => {
  it('writes the shape whole: the read, the decision, and a write with its own routing per branch', () => {
    const { dir, doc } = scaffolded('close-customer', { 'read-then': 'remove', branch: BRANCHES });
    // every id says what its node holds: the store's collection is of Customer, the branches are the author's
    expect(shapeOf(doc)).toEqual([
      'storedCustomer run',
      'whichWrite switch',
      'lapsed run',
      'stillThereAfterLapsed switch',
      'lapsedCustomer run',
      'goneBeforeLapsed run',
      'closed run',
      'stillThereAfterClosed switch',
      'closedCustomer run',
      'goneBeforeClosed run',
      'noCustomer run',
    ]);
    // the read is by the key the graph takes, and the decision routes on what it answered
    const nodes = doc.nodes as Record<string, unknown>[];
    expect(nodes[0]).toMatchObject({ run: '@storage/store.port.json#get', in: { ...STORE, key: '{{in.id}}' } });
    expect(nodes[1]).toMatchObject({
      in: { record: '{{storedCustomer.record}}' },
      rules: [
        { when: 'has(record) && !has(record.active)', to: 'lapsed' },
        { when: 'has(record)', to: 'closed' },
      ],
      else: 'noCustomer',
    });
    // each write routes on what it answered, so a record gone between the read and the write is a case, not a fault
    expect(nodes[3]).toMatchObject({
      in: { record: '{{lapsed.record}}' },
      rules: [{ when: 'has(record)', to: 'lapsedCustomer' }],
      else: 'goneBeforeLapsed',
    });
    // every node that can answer is a candidate, in the order the branches were named
    expect(doc.out).toEqual({
      type: 'TODO',
      from: ['lapsedCustomer', 'goneBeforeLapsed', 'closedCustomer', 'goneBeforeClosed', 'noCustomer'],
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('checks clean against the example once the TODOs are filled', () => {
    const { dir, file } = scaffolded('close-customer', { 'read-then': 'remove', branch: BRANCHES });
    expect(fill(dir, file, {})).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('checks clean for each write --read-then names, since each answers the record the same way', () => {
    // a put writes the record whole, read from in where it is judged (I008), so the graph takes a Customer
    for (const [write, changes] of [
      ['remove', {}],
      ['put', { [`"in": "${REF}"`]: `"in": "${CUSTOMER}"` }],
    ] as [string, Record<string, string>][]) {
      const { dir, file, doc } = scaffolded(`probe-${write}`, { 'read-then': write, branch: 'taken:has(record)' });
      expect((doc.nodes as { run?: string }[])[2].run).toBe(`@storage/store.port.json#${write}`);
      expect(fill(dir, file, changes), write).toEqual([]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a put whose record is the graph’s whole in, never one composed at the write', () => {
    const { dir, doc } = scaffolded('replace-customer', { 'read-then': 'put' });
    expect((doc.nodes as { in: Record<string, unknown> }[])[2].in).toEqual({ ...STORE, record: '{{in}}' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a data graph whatever --layer says, since it reaches a store', () => {
    const { dir, file } = scaffolded('elsewhere', { 'read-then': 'remove', layer: 'domain' });
    expect(file).toBe('features/customers/data/elsewhere.graph.json');
    rmSync(dir, { recursive: true, force: true });
  });

  it('scaffolds one branch named for its write where none was named, and refuses a --branch that is not <id>:<when>', () => {
    const { dir, doc } = scaffolded('one-branch', { 'read-then': 'put' });
    expect(shapeOf(doc)).toEqual([
      'storedCustomer run',
      'whichWrite switch',
      'replaced run',
      'stillThereAfterReplaced switch',
      'replacedCustomer run',
      'goneBeforeReplaced run',
      'noCustomer run',
    ]);
    const { dir: other, doc: named } = scaffolded('one-remove', { 'read-then': 'remove' });
    expect((named.nodes as { id: string }[])[2].id).toBe('removed');
    rmSync(other, { recursive: true, force: true });
    expect(() =>
      scaffold(dir, 'graph', 'features/customers/bad', { ...STORE, 'read-then': 'remove', branch: 'noWhen' }),
    ).toThrow("--branch 'noWhen' is not <id>:<when>");
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the ids after --type where it is given, and after the record where nothing names a shape', () => {
    // --type is the answer's shape, so it also fills every type the scaffold would otherwise leave TODO
    const typed = scaffolded('typed', { 'read-then': 'remove', type: '@customers/domain/TierLatest.shape.json' });
    expect(shapeOf(typed.doc).filter(one => one.endsWith('run'))).toEqual([
      'storedTierLatest run',
      'removed run',
      'removedTierLatest run',
      'goneBeforeRemoved run',
      'noTierLatest run',
    ]);
    expect(typed.doc.out).toMatchObject({ type: '@customers/domain/TierLatest.shape.json' });
    rmSync(typed.dir, { recursive: true, force: true });
    // a store the tree does not have says nothing of its collection, so the ids fall back to the record
    const bare = scaffolded('bare', { 'read-then': 'remove', store: '@features/nowhere/data/nothing.store.json' });
    expect(shapeOf(bare.doc)[0]).toBe('storedRecord run');
    expect(shapeOf(bare.doc).at(-1)).toBe('noRecord run');
    rmSync(bare.dir, { recursive: true, force: true });
  });

  it('refuses --read-then patch, naming the pair that changes a record whole, and a word that is no write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-rdw-'));
    cpSync(EXAMPLE, dir, { recursive: true });
    const asked = (opts: Record<string, string>) => () => scaffold(dir, 'graph', 'features/customers/x', opts);
    expect(asked({ ...STORE, 'read-then': 'patch' })).toThrow(
      '--read-then patch is not scaffolded: a record is changed whole (RFC 0035). --port <port> writes the domain graph',
    );
    expect(asked({ ...STORE, 'read-then': 'upsert' })).toThrow(/^--read-then takes put or remove, not 'upsert'$/);
    // a bare --read-then reaches the scaffold as 'true', as the CLI hands any flag given no value: no word was written
    expect(asked({ ...STORE, 'read-then': 'true' })).toThrow(/^--read-then takes put or remove$/);
    // a --branch routes the read-decide-write form, so without a write it asks for one
    expect(asked({ ...STORE, branch: 'taken:has(record)' })).toThrow('give --read-then put|remove');
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a graph named with no store what it was: one node to replace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-rdw-'));
    cpSync(EXAMPLE, dir, { recursive: true });
    const [file] = scaffold(dir, 'graph', 'features/customers/greet', {});
    expect(file).toBe('features/customers/domain/greet.graph.json');
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
    expect(shapeOf(doc)).toEqual(['greeting run']);
    rmSync(dir, { recursive: true, force: true });
  });
});
