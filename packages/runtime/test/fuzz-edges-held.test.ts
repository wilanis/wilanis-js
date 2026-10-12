/**
 * What an edge's other fields hold (#1009): `fuzz --edges` sets one field of the trigger's input to an edge, and
 * changes the others where a rule the trigger's graphs hold them to would refuse them, so the run reaches what the edge
 * is named for. On a copy of the example, where `Customer: email contains '@'` holds and a generated email holds none.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadTree } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDGES, fuzz } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('fuzz --edges: the fields an edge does not test meet the rules', () => {
  let dir: string;
  beforeAll(async () => {
    dir = copyOfExample();
    const edged = await fuzz(loadTree(dir, PLUGINS, INCLUDES), { edges: true });
    expect(edged.ok, edged.lines.join('\n')).toBe(true);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** One recorded edge of a trigger: its input, and what each node did, read through the directory's answers. */
  function edgeOf(trigger: string, edge: string) {
    const doc = read(join(dir, EDGES, trigger, `${edge}.scenario.json`));
    const answers = read(join(dir, EDGES, 'answers.json')).nodes;
    const node = (path: string) => answers[doc.expect.nodes[path]] ?? {};
    return { in: doc.in, expect: doc.expect, node };
  }

  it('gives the email an @ where the edge is another field, so the run passes the guard and reaches the store', () => {
    const silver = edgeOf('customers.register-customer', 'tier.enum.silver');
    expect(silver.in.tier).toBe('silver');
    expect(silver.in.email).toContain('@');
    // the domain guard lets the customer through, and the store's outcome switch runs on what the store answered
    expect(silver.node('op.customer:check').selected).toBe('customer');
    expect(silver.node('op.registered.op.in:check').selected).toBe('in:ok');
    expect(silver.node('op.registered.op.outcome').status).toBe('done');
    // the name the edge does not test keeps the seed's, which the rules already hold
    expect(edgeOf('customers.register-customer', 'name.one').in.name).toBe('x');
    expect(edgeOf('customers.register-customer', 'email.one').in.name).toBe(silver.in.name);
  });

  it('never changes the field the edge tests, so an edge a rule refuses is refused by that rule', () => {
    const one = edgeOf('customers.register-customer', 'email.one');
    expect(one.in.email).toBe('x');
    expect(one.expect).toMatchObject({ status: 'failed', reason: 'invariant' });
    // the @ rule refuses it, not the rule the other fields could break
    expect(one.node('op.customer:check').selected).toBe('customer:violated:2');
    // gold asks for a note no field of the request gives: the email meets the @ rule, and the note rule refuses
    const gold = edgeOf('customers.register-customer', 'tier.enum.gold');
    expect(gold.in).toMatchObject({ tier: 'gold', email: expect.stringContaining('@') });
    expect(gold.node('op.customer:check').selected).toBe('customer:violated');
    // an absent field stays absent
    expect(edgeOf('customers.list-customers', 'tier.absent').in).toEqual({});
  });
});
