/**
 * What `wilanis describe` and `wilanis map` say about a graph whose effects move together. A graph declares
 * one word, `atomic`, and everything that follows from it -- which connection the one transaction falls on,
 * which of the graph's nodes take part, and which declared refusals roll it back -- is worked out from the
 * tree. A reader who cannot see those three has to walk the bindings by hand to know what a rollback would
 * undo, which is the one thing `describe` exists to avoid.
 *
 * The cases read the example's own atomic graphs, which is the whole point of the example having them:
 * `store-and-latest` is a data graph writing two collections of one store, and `record-all` is a domain
 * graph whose own nodes reach no store at all -- what it takes part in is written in the data graph its
 * operations are bound to, and differs by profile.
 */
import { rmSync } from 'node:fs';
import { loadTree } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, map } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedEditing, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const LATEST = '@monitor/data/store-and-latest.graph.json';
const ALL = '@monitor/domain/record-all.graph.json';

describe('describe: a data graph whose effects move together', () => {
  const said = () => describeDoc(example, LATEST);

  it('says it commits when it answers, and names every reason that rolls it back', () => {
    // it refuses with 'conflict' where the store answered a violated unique, and with 'upstream' where either
    // write answered no record: each refusal undoes both writes. And with 'invariant' where the entry it made
    // does not satisfy the field invariant -- the guard the compiler lowered at that site refuses inside the
    // transaction, so it rolls back like any refusal the graph writes.
    expect(said()).toContain(
      "atomic: commits when it answers; rolls back on 'conflict', 'invariant', 'upstream', or a fault",
    );
  });

  it('names the one connection the transaction falls on, which no node of the graph writes down', () => {
    // the nodes name a store and a collection; the store names the connection. A reader is told the end of
    // that chain rather than being left to walk it.
    expect(said()).toContain('    on  @connections/entries.connection.json');
  });

  it('names the nodes that take part, in the order the document writes them', () => {
    // key, stored and latest run @storage operations; route, row and failed reach no store at all
    expect(said()).toContain('    taken part in by  key, stored, latest');
  });

  it('says none of it of a graph that does not declare it, however many effects it reaches', () => {
    expect(describeDoc(example, '@monitor/data/kept-update.graph.json')).not.toContain('atomic:');
  });
});

describe('describe: a domain graph whose effects move together', () => {
  const said = () => describeDoc(example, ALL);

  it('names the node whose operation leads to the store, not the data graph below it', () => {
    // record-all runs one map over monitor.submit; the writes are two graphs further down
    expect(said()).toContain('    taken part in by  recorded');
  });

  it('names every connection the profiles that bind it fall on, saying a run falls on one', () => {
    // local keeps the entries in memory and production in PostgreSQL: the same graph, two connections,
    // and a reader chooses a profile before running
    expect(said()).toContain(
      '    on  @connections/entries-postgres.connection.json or @connections/entries.connection.json  (one per profile; a run falls on the one its profile binds)',
    );
  });
});

describe('describe: an operation that can take part in one', () => {
  it('lists transactional beside pure, refuses and holds, so a caller sees it on the contract', () => {
    const said = describeDoc(example, '@storage/store.port.json');
    expect(said).toContain('#put  (transactional):');
    expect(said).toContain('#newKey  (transactional):');
  });
});

describe('map: where the tree names an atomic graph', () => {
  // kept-update is the one atomic-able graph the map's walk reaches, since it walks what a trigger fires
  const marked = loadedEditing('features/monitor/data/kept-update.graph.json', (doc: any) => {
    doc.atomic = true;
  });
  afterAll(() => {
    rmSync(marked.dir, { recursive: true, force: true });
  });

  it('marks it where a binding leads to it, so the transaction is seen without opening the document', () => {
    const lines = map(marked.load).filter(line => line.trim().startsWith('@features/monitor/data/kept-update.'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toContain('[atomic]');
  });

  it('marks only the graph that says so', () => {
    expect(map(marked.load).filter(line => line.includes('[atomic]') && !line.includes('kept-update.'))).toEqual([]);
  });

  it('does not make it an orphan: a mark beside the path is not a different path', () => {
    // the orphans are gathered as the walk goes, never read back off the lines it wrote
    const orphans = (lines: string[]) => lines.filter(line => line.startsWith('orphan '));
    expect(orphans(map(marked.load))).toEqual(orphans(map(example)));
  });
});
