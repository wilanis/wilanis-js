/**
 * `wilanis new graph --port` and `--store`: the load-make-keep pair a change to a record takes (RFC 0035), scaffolded
 * into a copy of the example over its customer port and store. The domain graph loads the customer, lays the change
 * over it with `#merge`, and hands the result whole to `keep`, so the guard over Customer stands at the merge,
 * upstream of the write; the data graph behind `keep` takes the customer as its `in` and `#put`s it whole. Neither
 * writes a `#patch`, and each checks clean once the TODOs a tool cannot decide are filled.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { describe as describeDoc, scaffold } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const PORT = '@customers/domain/customer.port.json';
const STORE = { store: '@customers/data/customers.store.json', collection: 'customers' };
const CUSTOMER = '@customers/domain/Customer.shape.json';
const UPDATE = '@customers/domain/CustomerUpdate.shape.json';
const FIELDS = ['id', 'name', 'email', 'tier', 'registrar', 'active', 'note'];

/** The copy each case writes into, removed after it. */
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Scaffold one graph into a fresh copy of the example, and answer its path and the document written. */
function written(name: string, opts: Record<string, string>): { file: string; doc: Record<string, any> } {
  dir = mkdtempSync(join(tmpdir(), 'wilanis-keep-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  return also(name, opts);
}

/** Scaffold one more graph into the same copy. */
function also(name: string, opts: Record<string, string>): { file: string; doc: Record<string, any> } {
  const [file] = scaffold(dir, 'graph', `features/customers/${name}`, opts);
  return { file, doc: JSON.parse(readFileSync(join(dir, file), 'utf8')) };
}

/** The refusals of the copy once a graph's `"in": "TODO"` names the change it takes. */
function checkedTaking(file: string, change: string): string[] {
  const at = join(dir, file);
  writeFileSync(at, readFileSync(at, 'utf8').replaceAll('"in": "TODO"', `"in": "${change}"`));
  return checkTree(loadTree(dir, PLUGINS, INCLUDES)).items.map(one => `${one.code} ${one.file}#${one.at ?? ''}`);
}

/** Every node of a graph as `id operation`, a switch as `id switch`. */
const nodesOf = (doc: Record<string, any>) =>
  (doc.nodes as { id: string; run?: string }[]).map(node => `${node.id} ${node.run ?? 'switch'}`);

describe('wilanis new graph --port: load, make, keep', () => {
  it('writes the domain graph: the customer loaded, the change laid over it, and the result handed to keep', () => {
    const { file, doc } = written('rename-customer', { port: PORT });
    expect(file).toBe('features/customers/domain/rename-customer.graph.json');
    expect(nodesOf(doc)).toEqual([`current ${PORT}#get`, 'customer @std/object.port.json#merge', `kept ${PORT}#keep`]);
    expect(doc.nodes[0].in).toEqual({ id: '{{in.id}}' });
    expect(doc.nodes[1].in).toEqual({ base: '{{current}}', over: '{{in}}', type: CUSTOMER });
    // keep takes a Customer, so it is given the customer's fields one by one, each read off the merge
    expect(doc.nodes[2].in).toEqual(Object.fromEntries(FIELDS.map(field => [field, `{{customer.${field}}}`])));
    expect(doc.out).toEqual({ type: CUSTOMER, from: 'kept' });
    expect(JSON.stringify(doc)).not.toContain('#patch');
  });

  it('checks clean once it takes the change, and the guard stands at the merge, before keep', () => {
    const { file } = written('rename-customer', { port: PORT });
    expect(checkedTaking(file, UPDATE)).toEqual([]);
    const said = describeDoc(loadTree(dir, PLUGINS, INCLUDES), '@customers/domain/rename-customer.graph.json');
    expect(said).toContain('    customer:made  @std/object.port.json#merge');
    expect(said).toContain('        customer:check  switch → customer | customer:violated  (guard)');
  });

  it('reads and writes through the operations --read and --write name', () => {
    const { doc } = written('register-again', { port: PORT, read: 'get', write: 'register' });
    expect(doc.nodes[2]).toMatchObject({ id: 'kept', run: `${PORT}#register` });
    expect(Object.keys(doc.nodes[2].in)).toEqual(FIELDS);
  });

  it('writes TODO where the tree has no such port, and names the ids after the record', () => {
    const { doc } = written('elsewhere', { port: '@features/nowhere/domain/nothing.port.json' });
    expect(nodesOf(doc).map(one => one.split(' ')[0])).toEqual(['current', 'record', 'kept']);
    expect(doc.nodes[2].in).toEqual({ TODO: '{{record.TODO}}' });
    expect(doc.out).toEqual({ type: 'TODO', from: 'kept' });
  });

  it('refuses --port beside --store: each writes one half of the pair', () => {
    expect(() => written('both', { port: PORT, ...STORE })).toThrow(
      '--port writes the domain graph that loads, makes and keeps a record, and --store the data graph behind its write; give one',
    );
  });
});

describe('wilanis new graph --store: keep the record whole', () => {
  it('writes the data graph: the customer taken as in and put whole, what the store answered answered', () => {
    const { file, doc } = written('keep-renamed', STORE);
    expect(file).toBe('features/customers/data/keep-renamed.graph.json');
    expect(doc.in).toBe(CUSTOMER);
    expect(nodesOf(doc)).toEqual([
      'stored @storage/store.port.json#put',
      'outcome switch',
      'kept @std/object.port.json#make',
      'repeated @std/outcome.port.json#refuse',
      'nothingWritten @std/outcome.port.json#refuse',
    ]);
    // the one write, of the record read whole from in, where the compiler guards it (I008 refuses anything else)
    expect(doc.nodes[0].in).toEqual({ ...STORE, record: '{{in}}' });
    expect(doc.nodes[1]).toMatchObject({
      rules: [
        { when: 'has(violated)', to: 'repeated' },
        { when: 'has(record)', to: 'kept' },
      ],
      else: 'nothingWritten',
    });
    expect(doc.out).toEqual({ type: CUSTOMER, from: ['kept', 'repeated', 'nothingWritten'] });
    expect(JSON.stringify(doc)).not.toContain('#patch');
  });

  it('checks clean as written: the shape is the collection’s, and the one made value is behind the write', () => {
    // `kept` makes a Customer from what the store answered and no effect reads it, which step 3's rule allows
    written('keep-renamed', STORE);
    expect(checkTree(loadTree(dir, PLUGINS, INCLUDES)).items).toEqual([]);
  });

  it('writes the pair into one tree, the domain half over keep and the data half behind it, and both check clean', () => {
    const domain = written('rename-customer', { port: PORT });
    also('keep-renamed', STORE);
    expect(checkedTaking(domain.file, UPDATE)).toEqual([]);
  });
});
