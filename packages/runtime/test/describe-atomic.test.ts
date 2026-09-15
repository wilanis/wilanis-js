/**
 * What `wilanis describe` and `wilanis map` say about a graph whose effects move together. A graph declares
 * one word, `atomic`, and everything that follows from it -- which connection the one transaction falls on,
 * which of the graph's nodes take part, and which declared refusals roll it back -- is worked out from the
 * tree. A reader who cannot see those three has to walk the bindings by hand to know what a rollback would
 * undo, which is the one thing `describe` exists to avoid.
 *
 * The cases mark the example's own graphs atomic rather than planting new ones, the way the sabotage cases
 * do: `kept-record` asks for a key and writes under it, two effects on one store, and is the graph an atomic
 * declaration suits; `kept-update` is the one `map` names where a binding meets it, so the mark can be read
 * where the tree hangs together rather than only where the document is opened.
 */
import { rmSync } from 'node:fs';
import { loadTree } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, map } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedEditing, PLUGINS } from './example-harness.js';

const KEPT = 'features/monitor/data/kept-record.graph.json';
const UPDATE = 'features/monitor/data/kept-update.graph.json';
const atomic = (doc: any) => {
  doc.atomic = true;
};

const kept = loadedEditing(KEPT, atomic);
const updated = loadedEditing(UPDATE, atomic);
afterAll(() => {
  for (const one of [kept, updated]) rmSync(one.dir, { recursive: true, force: true });
});

describe('describe: a graph whose effects move together', () => {
  const said = () => describeDoc(kept.load, '@monitor/data/kept-record.graph.json');

  it('says it commits when it answers, and names every reason that rolls it back', () => {
    // kept-record refuses with 'upstream' when the store wrote nothing: that refusal is what undoes the write
    expect(said()).toContain("atomic: commits when it answers; rolls back on 'upstream', or a fault");
  });

  it('names the one connection the transaction falls on, which no node of the graph writes down', () => {
    // the nodes name a store; the store names the connection. A reader is told the end of that chain.
    expect(said()).toContain('    on  @connections/entries.connection.json');
  });

  it('names the nodes that take part, in the order the document writes them', () => {
    // key and saved run @storage operations; route, row and failed do not reach the store at all
    expect(said()).toContain('    taken part in by  key, saved');
  });

  it('says none of it of the same graph before it declares atomic', () => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    expect(describeDoc(load, '@monitor/data/kept-record.graph.json')).not.toContain('atomic:');
  });
});

describe('describe: an operation that can take part in one', () => {
  it('lists transactional beside pure, refuses and holds, so a caller sees it on the contract', () => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    const said = describeDoc(load, '@storage/store.port.json');
    expect(said).toContain('#put  (transactional):');
    expect(said).toContain('#newKey  (transactional):');
  });
});

describe('map: where the tree names an atomic graph', () => {
  it('marks it where a binding leads to it, so the transaction is seen without opening the document', () => {
    const marked = map(updated.load).filter(line => line.trim().startsWith('@features/monitor/data/kept-update.'));
    expect(marked.length).toBeGreaterThan(0);
    for (const line of marked) expect(line).toContain('[atomic]');
  });

  it('marks only the graph that says so', () => {
    const others = map(updated.load).filter(line => line.includes('[atomic]') && !line.includes('kept-update.'));
    expect(others).toEqual([]);
  });

  it('does not make it an orphan: a mark beside the path is not a different path', () => {
    // the orphans are gathered as the walk goes, never read back off the lines it wrote
    const orphans = (lines: string[]) => lines.filter(line => line.startsWith('orphan '));
    expect(orphans(map(updated.load))).toEqual(orphans(map(loadTree(EXAMPLE, PLUGINS, INCLUDES))));
  });
});
