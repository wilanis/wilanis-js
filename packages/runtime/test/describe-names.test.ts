/**
 * What `wilanis describe` says about a field that names a connection or a store (RFC 0037, step 1): `describe
 * <port>` prints `(names a connection)` or `(names a store)` beside `(static)`, and the reach lines of `describe
 * project.json` print every connection a call names after `via` -- the scheduler's `lease` too, which is no field
 * called `connection`.
 */
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

describe('wilanis describe: a field that names a connection or a store', () => {
  it('says beside (static) what a field names, a connection or a store', () => {
    const scheduler = describeDoc(example, '@schedule/scheduler.port.json').split('\n');
    expect(scheduler).toContainEqual(
      expect.stringMatching(/^ {4}in {2}lease\?: string {2}\(static\) {2}\(names a connection\) {2}-- /),
    );
    const store = describeDoc(example, '@storage/store.port.json').split('\n');
    expect(store).toContainEqual(
      expect.stringMatching(/^ {4}in {2}store: string {2}\(static\) {2}\(names a store\) {2}-- /),
    );
  });

  it('says nothing more of a static field that names no document', () => {
    const store = describeDoc(example, '@storage/store.port.json').split('\n');
    const collection = store.filter(line => line.startsWith('    in  collection:'));
    expect(collection.length).toBeGreaterThan(0);
    for (const line of collection) expect(line).not.toContain('(names');
  });

  it("prints the connection the scheduler's lease names after via, under the profile whose step gives it", () => {
    const said = describeDoc(example, 'project.json').split('\n');
    const start = said.findIndex(line => line.startsWith('profile production-scheduler'));
    const block = said.slice(start, said.indexOf('', start));
    expect(block).toContain(
      '             @schedule/scheduler.port.json#run  via @connections/customers-postgres.connection.json',
    );
  });
});
