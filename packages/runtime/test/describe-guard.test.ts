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
import { join } from 'node:path';
import { loadTree } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc } from '../src/index.js';
import { copyOfExample, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

const REACHABLE = "'A customer is reachable' (@features/customers/domain/a-customer-is-reachable.invariant.json)";
const ADDRESS = "'An address names its domain' (@features/customers/domain/an-address-names-its-domain.invariant.json)";
/** The example's two invariants over `Customer`, in the order the registry holds them and the guard conjoins them. */
const CALLS = `${REACHABLE} and ${ADDRESS}`;
const RULE = "(len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))) && (email contains '@')";

const KEPT_GET = '@customers/data/kept-get.graph.json';
const KEPT_LIST = '@customers/data/kept-list.graph.json';
const WRITE_CSV = '@customers/data/write-csv.graph.json';
const GREET = '@hello/domain/greet.graph.json';

describe('describe: a graph whose made value is guarded', () => {
  const said = () => describeDoc(example, KEPT_GET);

  it('names the invariants and their rules once, above the nodes the guard is', () => {
    // the fact all of them share belongs above them, as a policy's `gates:` line already does. The rules are
    // printed exactly as the switch tests them, brackets and all, in the order the registry holds them, which is
    // the order `guardsOf` conjoins them in: the header and the switch read the same way round
    expect(said()).toContain(`    guard for ${CALLS}, when ${RULE}:`);
    expect(said().split(CALLS)).toHaveLength(2);
  });

  it('prints each node the compiler lowered, marked as a guard, under the id the spec gives it', () => {
    // one guard however many rules, whose switch routes to one refusal per rule, the first keeping its id
    expect(said().split('guard for')).toHaveLength(2);
    expect(said()).toContain(
      '        customer:check  switch → customer | customer:violated | customer:violated:2  (guard)',
    );
    expect(said()).toContain('        customer  answers customer:made, which the rule let through  (guard)');
  });

  it('says which invariant each refusal is for, in the order the header names them', () => {
    expect(said()).toContain("        customer:violated  refuses 'invariant' for 'A customer is reachable'  (guard)");
    expect(said()).toContain(
      "        customer:violated:2  refuses 'invariant' for 'An address names its domain'  (guard)",
    );
  });

  it('prints the author s own node under the id it moved aside to, and does not call it a guard', () => {
    // `customer:made` is the node the author wrote; the mark belongs on what the compiler added, not what it renamed
    expect(said()).toContain('    customer:made  @std/object.port.json#make');
    expect(said()).not.toContain('customer:made  @std/object.port.json#make  (guard)');
  });

  it('routes whatever routed the made node to where it moved, since that is where the value is made', () => {
    expect(said()).toContain('    isKept  switch → customer:made | noCustomer');
    expect(said()).not.toContain('    isKept  switch → customer | noCustomer');
  });

  it('answers with the guard s refusals too, which is how the graph refuses when one of its rules fails', () => {
    // with either refusal, since it refuses with whichever the guard routed to
    expect(said()).toContain(
      'answers @customers/domain/Customer.shape.json  from customer | customer:violated | customer:violated:2 | noCustomer',
    );
  });
});

describe('describe: a graph whose value is a list of the shape', () => {
  it('says the one node a list site gains: a map over the nested spec, element by element', () => {
    const said = describeDoc(example, KEPT_LIST);
    expect(said).toContain(`    guard for ${CALLS}, when ${RULE}:`);
    expect(said).toContain(
      '        customers  maps customers:made through guard:@features/customers/data/kept-list.graph.json#customers, element by element  (guard)',
    );
    expect(said).toContain('    customers:made  @storage/store.port.json#find');
  });

  it('appends no refusal to what the graph answers, since the map refuses with the element s reason', () => {
    expect(describeDoc(example, KEPT_LIST)).toContain(
      'answers @customers/domain/Customer.shape.json[]  from customers',
    );
  });
});

describe('describe: a graph whose taken value is guarded', () => {
  const said = () => describeDoc(example, WRITE_CSV);

  it('opens the nodes with the guard, since a taken value has no authored node to move aside', () => {
    expect(said()).toContain(`    guard for ${CALLS}, when ${RULE}:`);
    expect(said()).toContain(
      '        in:ok  maps in through guard:@features/customers/data/write-csv.graph.json#in, element by element  (guard)',
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

// ---- one rule over the shape ------------------------------------------------------------------------

/**
 * A site is guarded once however many rules were unproved there (RFC 0007, decided during implementation), and
 * each refusal says whose it is where there are several, or a reader could not tell `customer:violated` from
 * `customer:violated:2`. Where the guard stands for one rule alone, the header has said whose it is. The example
 * holds `Customer` to two rules, so a copy without the address rule is the case of one.
 */
const oneDir = copyOfExample();
rmSync(join(oneDir, 'features/customers/domain/an-address-names-its-domain.invariant.json'));
const one = loadTree(oneDir, PLUGINS, INCLUDES);
afterAll(() => rmSync(oneDir, { recursive: true, force: true }));

describe('describe: a site one invariant is unproved at', () => {
  it('names the one invariant and its rule above the guard', () => {
    expect(describeDoc(one, KEPT_GET)).toContain(
      `    guard for ${REACHABLE}, when (len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))):`,
    );
  });

  it('does not repeat the invariant on the refusal where the guard stands for one rule alone', () => {
    // the header has said it; a second spelling on the one refusal would be the same fact twice
    const said = describeDoc(one, KEPT_GET);
    expect(said).toContain('        customer:check  switch → customer | customer:violated  (guard)');
    expect(said).toContain("        customer:violated  refuses 'invariant'  (guard)");
    expect(said).toContain(
      'answers @customers/domain/Customer.shape.json  from customer | customer:violated | noCustomer',
    );
  });
});
