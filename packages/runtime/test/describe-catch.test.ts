/**
 * What `wilanis describe` says about a fault (RFC 0014, step 11). A switch's line names where it routes a node that
 * broke, after its rules; a trigger whose kind maps refusals closes its refusal table with what that table leaves
 * out, since a fault has no reason to map. The example has no catch of its own, so a copy's `get-row` is given the
 * guide's: `fetched` breaking routes to `unreachable`, which refuses `upstream`.
 */
import { rmSync } from 'node:fs';
import { loadTree } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, UNCAUGHT_FAULT } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedEditing, PLUGINS } from './example-harness.js';

const GET_ROW = 'features/customers/data/get-row.graph.json';
const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

const { load: caught, dir } = loadedEditing(GET_ROW, (doc: any) => {
  doc.nodes.push({
    type: '@wilanis/node/run.schema.json',
    id: 'unreachable',
    run: '@std/outcome.port.json#refuse',
    in: {
      reason: 'upstream',
      message: 'the customer API could not be reached',
      type: '@customers/domain/Customer.shape.json',
    },
  });
  doc.out.from.push('unreachable');
  doc.nodes.find((node: any) => node.id === 'outcome').catch = { fetched: 'unreachable' };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('describe: a switch that catches a fault', () => {
  it('names the caught node and its target after the rules, on the switch line', () => {
    expect(describeDoc(caught, `@${GET_ROW}`)).toContain(
      '    outcome  switch → noCustomer | customer | upstreamFailed  catches fetched → unreachable',
    );
  });

  it('says nothing of a catch on a switch that has none', () => {
    const said = describeDoc(example, `@${GET_ROW}`);
    expect(said).toContain('    outcome  switch → noCustomer | customer | upstreamFailed\n');
    expect(said).not.toContain('catches');
  });
});

describe('describe: what a trigger answers a fault with', () => {
  it('closes the refusal table of a kind that maps refusals with the fault line', () => {
    const lines = describeDoc(example, '@customers/edge/get-customer.trigger.json').split('\n');
    const at = lines.indexOf(UNCAUGHT_FAULT);
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toMatch(/^ {8}refusals: \{"missing":404/);
    expect(UNCAUGHT_FAULT).toBe(
      "Anything that breaks and no switch catches is a fault: answered the kind's one way, never mapped.",
    );
  });

  it('prints no fault line for a kind that maps no refusals', () => {
    expect(describeDoc(example, '@customers/edge/digest.trigger.json')).not.toContain(UNCAUGHT_FAULT);
  });
});
