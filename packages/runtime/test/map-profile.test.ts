/**
 * What `wilanis map` draws under a profile. The example's customer port has three bindings -- the REST upstream, the
 * in-memory store and PostgreSQL -- and a profile chooses one, as `rehearse` chooses it. Without a profile the map
 * draws every binding and says the port needs one; under a profile it draws the chosen binding alone, and never
 * the `??` line, since there is nothing left to choose. What the other profiles' bindings run is then named after
 * the triggers, bound by whoever runs it, and never called an orphan: that word means a graph the checker's walk
 * enters under no profile at all, which over the example is none.
 */
import { rmSync } from 'node:fs';
import { loadTree, schemaUrl } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { map } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedWith, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const POSTGRES = '@features/customers/data/customers-postgres.binding.json';
const REST = '@features/customers/data/customers-rest.binding.json';
const KEPT_REMOVE_POSTGRES = '@features/customers/data/kept-remove-postgres.graph.json';
/** A graph nothing binds: the one thing the map may call an orphan, planted in a copy of the example. */
const NOBODY = '@features/customers/data/nobody-reaches.graph.json';
const { load: planted, dir: plantedDir } = loadedWith({
  'features/customers/data/nobody-reaches.graph.json': {
    $schema: schemaUrl('graph'),
    description: 'A graph no binding of any profile names, so nothing reaches it under any profile.',
    nodes: [
      {
        type: '@wilanis/node/run.schema.json',
        id: 'first',
        run: '@std/text.port.json#fill',
        in: { values: {}, template: 'nobody' },
      },
    ],
    out: { type: 'string', from: 'first' },
  },
});
afterAll(() => rmSync(plantedDir, { recursive: true, force: true }));
const DELETE =
  '@features/customers/edge/delete-customer.trigger.json  (@http/http.trigger-kind.json)  route "/customers/{id}", method "DELETE", produces "application/json"';
/** Fires a domain graph that calls the customer port again, which is where a binding has to be chosen mid-walk. */
const DIGEST = '@features/customers/edge/digest.trigger.json  (@cli/cli.trigger-kind.json)  command "digest"';
const CHOOSE = 'has 3 bindings';
/** The lines the map draws under one trigger, up to the next. */
function under(lines: string[], trigger: string): string[] {
  const at = lines.indexOf(trigger);
  expect(at).toBeGreaterThan(-1);
  const next = lines.findIndex((line, index) => index > at && !line.startsWith(' ') && !line.startsWith('orphan'));
  return lines.slice(at + 1, next < 0 ? undefined : next);
}

describe('map under a profile', () => {
  it('without one, draws every binding of the port and says a call on it needs a profile', () => {
    const all = map(example);
    const lines = under(all, DELETE);
    expect(lines.some(line => line.includes('kept-remove-postgres.graph.json'))).toBe(true);
    expect(lines.some(line => line.includes('delete-row.graph.json'))).toBe(true);
    expect(lines.some(line => line.includes('kept-remove.graph.json'))).toBe(true);
    // a domain graph calling the port mid-walk is where the choice is missing, and the line says so -- under each
    // of the three bindings that meet the trigger's own operation with that graph, so three times over
    const digest = under(all, DIGEST);
    expect(
      digest.filter(line => line.includes(`?? port '@features/customers/domain/customer.port.json' ${CHOOSE}`)),
    ).toHaveLength(3);
    expect(digest.some(line => line.includes('.binding.json#listEvery'))).toBe(false);
  });

  it('under local, walks the store binding alone and never asks the reader to choose', () => {
    const all = map(example, 'local');
    expect(all.filter(line => line.includes(CHOOSE))).toEqual([]);
    const lines = under(all, DELETE);
    expect(lines.some(line => line.includes('kept-remove.graph.json'))).toBe(true);
    expect(lines.some(line => line.includes('kept-remove-postgres.graph.json'))).toBe(false);
    expect(lines.some(line => line.includes('delete-row.graph.json'))).toBe(false);
    // a domain graph reaching the port mid-walk is met by the same profile's binding, and walked through it
    const digest = under(all, DIGEST);
    expect(digest.some(line => line.includes('@features/customers/data/customers-store.binding.json#listEvery'))).toBe(
      true,
    );
    expect(digest.some(line => line.includes('kept-list-every.graph.json'))).toBe(true);
    expect(all.some(line => line.includes('customers-postgres.binding.json#'))).toBe(false);
  });

  it('under production, the same trigger walks the postgres binding instead', () => {
    const lines = under(map(example, 'production'), DELETE);
    expect(lines.some(line => line.includes('kept-remove-postgres.graph.json'))).toBe(true);
    expect(lines.some(line => line.includes('kept-remove.graph.json  '))).toBe(false);
  });

  it('names a graph only another profile runs as unreached under this one, bound by whoever runs it', () => {
    const lines = map(example, 'local');
    expect(lines).toContain(`unreached under local  ${KEPT_REMOVE_POSTGRES}  bound by ${POSTGRES}`);
    expect(lines).toContain(`unreached under local  @features/customers/data/delete-row.graph.json  bound by ${REST}`);
    // one line per graph the other profiles' bindings run, after the triggers and before any orphan
    const unreached = lines.filter(line => line.startsWith('unreached under local  '));
    expect(unreached).toHaveLength(6);
    expect(unreached.every(line => line.includes(`bound by ${POSTGRES}`) || line.includes(`bound by ${REST}`))).toBe(
      true,
    );
    const lastTrigger = lines.map(line => /^@.*\.trigger\.json/.test(line)).lastIndexOf(true);
    expect(lines.indexOf(unreached[0])).toBeGreaterThan(lastTrigger);
    // and never an orphan: what another profile runs is the other half of what profiles are for. The orphans
    // are the same graphs with a profile and without, which is what the word has always meant
    const orphans = (profile?: string) => map(example, profile).filter(line => line.startsWith('orphan '));
    expect(orphans('local')).not.toContain(`orphan  ${KEPT_REMOVE_POSTGRES}`);
    expect(orphans('local')).toEqual(orphans());
    expect(orphans('production')).toEqual(orphans());
    expect(map(example).filter(line => line.startsWith('unreached under '))).toEqual([]);
  });

  it('calls nothing in the example an orphan: every graph is entered under some profile', () => {
    // the policy graphs run at every gate, the digest's list graphs behind `listEvery` mid-walk, `record-each`
    // under a `map` node's nested spec, the CSV graphs behind `import` and `export`: the drawing above stops
    // short of each, and the checker's walk enters them all, so the word reads that walk and not the drawing
    for (const profile of [undefined, 'local', 'production', 'live']) {
      expect(map(example, profile).filter(line => line.startsWith('orphan '))).toEqual([]);
    }
  });

  it('calls a graph no binding names the one orphan, with a profile and without', () => {
    const orphans = (load = planted, profile?: string) => map(load, profile).filter(line => line.startsWith('orphan '));
    expect(orphans()).toEqual([`orphan  ${NOBODY}`]);
    expect(orphans(planted, 'local')).toEqual(orphans());
    expect(orphans(planted, 'production')).toEqual(orphans());
    // the orphan comes after what the other profiles run, so the tail reads: theirs, then nobody's
    const lines = map(planted, 'local');
    expect(lines.indexOf(`orphan  ${NOBODY}`)).toBeGreaterThan(
      lines.findIndex(line => line.startsWith('unreached under ')),
    );
    expect(lines.some(line => line.startsWith('unreached under ') && line.includes(NOBODY))).toBe(false);
  });
});
