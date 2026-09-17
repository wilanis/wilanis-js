/**
 * What `wilanis describe <graph>` says about the nodes the compiler lowered (RFC 0007, step 7). Where a field
 * invariant could not be proved at a site, the graph a run walks has nodes the file does not: the made node
 * moved aside to `<id>:made`, a switch on the rule, the value it lets through, the refusal it ends in. A
 * reader told only the authored nodes would be told a graph that does not exist -- would see no `invariant`
 * among the reasons, no branch the value can fail on, and a `switch` routing to an id the spec has renamed.
 *
 * Nothing here re-derives which sites are guarded: `graph-said.ts` asks `guardsOf`, the same answer the
 * compiler lowers by and `guard-lowering.test.ts` asserts the ids of, so the CLI cannot name a node the spec
 * does not have. The wording is asserted rather than left loose because the viewer's canvas badge (step 8)
 * must say the same thing, and two spellings of one fact are two facts to a reader.
 */
import { rmSync } from 'node:fs';
import { loadTree, schemaUrl } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedWith, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

const CALLS = "'An entry names a call' (@features/monitor/domain/an-entry-names-a-call.invariant.json)";
const RULE = "(len(url) > 0 && (method != 'DELETE' || has(agent)))";

const KEPT_GET = '@monitor/data/kept-get.graph.json';
const KEPT_LIST = '@monitor/data/kept-list.graph.json';
const WRITE_CSV = '@monitor/data/write-csv.graph.json';
const GREET = '@hello/domain/greet.graph.json';

describe('describe: a graph whose made value is guarded', () => {
  const said = () => describeDoc(example, KEPT_GET);

  it('names the invariant and its rule once, above the nodes the guard is', () => {
    // the fact all three share belongs above the three, as a policy's `gates:` line already does. The rule is
    // printed exactly as the switch tests it, brackets and all, so a reader can match the two
    expect(said()).toContain(`    guard for ${CALLS}, when ${RULE}:`);
    expect(said().split(CALLS)).toHaveLength(2);
  });

  it('prints each node the compiler lowered, marked as a guard, under the id the spec gives it', () => {
    expect(said()).toContain('        row:check  switch → row | row:violated  (guard)');
    expect(said()).toContain('        row  answers row:made, which the rule let through  (guard)');
    expect(said()).toContain("        row:violated  refuses 'invariant'  (guard)");
  });

  it('prints the author s own node under the id it moved aside to, and does not call it a guard', () => {
    // `row:made` is the node the author wrote; the mark belongs on what the compiler added, not what it renamed
    expect(said()).toContain('    row:made  @std/object.port.json#make');
    expect(said()).not.toContain('row:made  @std/object.port.json#make  (guard)');
  });

  it('routes whatever routed the made node to where it moved, since that is where the value is made', () => {
    expect(said()).toContain('    route  switch → row:made | missing');
    expect(said()).not.toContain('    route  switch → row | missing');
  });

  it('answers with the guard s refusal too, which is how the graph refuses when its own rule fails', () => {
    expect(said()).toContain('answers @monitor/domain/Entry.shape.json  from row | row:violated | missing');
  });
});

describe('describe: a graph whose value is a list of the shape', () => {
  it('says the one node a list site gains: a map over the nested spec, element by element', () => {
    const said = describeDoc(example, KEPT_LIST);
    expect(said).toContain(`    guard for ${CALLS}, when ${RULE}:`);
    expect(said).toContain(
      '        rows  maps rows:made through guard:@features/monitor/data/kept-list.graph.json#rows, element by element  (guard)',
    );
    expect(said).toContain('    rows:made  @storage/store.port.json#find');
  });

  it('appends no refusal to what the graph answers, since the map refuses with the element s reason', () => {
    expect(describeDoc(example, KEPT_LIST)).toContain('answers @monitor/domain/Entry.shape.json[]  from rows');
  });
});

describe('describe: a graph whose taken value is guarded', () => {
  const said = () => describeDoc(example, WRITE_CSV);

  it('opens the nodes with the guard, since a taken value has no authored node to move aside', () => {
    expect(said()).toContain(`    guard for ${CALLS}, when ${RULE}:`);
    expect(said()).toContain(
      '        in:ok  maps in through guard:@features/monitor/data/write-csv.graph.json#in, element by element  (guard)',
    );
  });

  it('leaves every node the author wrote exactly as it was', () => {
    expect(said()).toContain('    file  @blob/csv.port.json#write');
  });
});

describe('describe: a graph with nothing to guard', () => {
  it('says not a word about guards, and prints its nodes under the ids its file spells', () => {
    const said = describeDoc(example, GREET);
    expect(said).not.toContain('(guard)');
    expect(said).not.toContain('guard for');
    expect(said).not.toContain(':made');
  });
});

// ---- two rules over one shape, unproved at one site -------------------------------------------------

/**
 * A site is guarded once however many rules were unproved there (RFC 0007, decided during implementation): the
 * one switch tests their conjunction. The header must read correctly in that case too, or a reader would go
 * looking for a rule the guard tests and the line never named.
 */
const SECOND = '@features/monitor/domain/an-entry-has-a-method.invariant.json';
const { load: two, dir: twoDir } = loadedWith({
  'features/monitor/domain/an-entry-has-a-method.invariant.json': {
    $schema: schemaUrl('invariant'),
    label: 'An entry has a method',
    description: 'A second rule over the same shape, unproved at the same sites, so one guard stands for both.',
    holds: { on: '@monitor/domain/Entry.shape.json', when: 'len(method) > 0' },
  },
});
afterAll(() => rmSync(twoDir, { recursive: true, force: true }));

describe('describe: a site two invariants are unproved at', () => {
  it('names both invariants above the one guard, and both rules as the switch conjoins them', () => {
    // in the order the registry holds them, which is the order `guardsOf` conjoins the rules in: the header
    // and the switch's own predicate read the same way round, so a reader can match one to the other
    const said = describeDoc(two, KEPT_GET);
    expect(said).toContain(
      `    guard for 'An entry has a method' (${SECOND}) and ${CALLS}, when (len(method) > 0) && ${RULE}:`,
    );
  });

  it('still lowers one guard, so the four ids are what they were with one rule', () => {
    const said = describeDoc(two, KEPT_GET);
    expect(said.split('guard for')).toHaveLength(2);
    expect(said).toContain('        row:check  switch → row | row:violated  (guard)');
  });
});
