/**
 * Sabotage: `@std/list.port.json#totals` (RFC 0039). The example's digest totals its customers per tier; it checks
 * clean. Each case then names a path the element's shape does not answer as the contract says: `by` must reach a
 * required string field of the element, and `sum` a required number field (G028).
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageHinting, sabotagePointing, sabotageSaying } from './example-harness.js';

const DIGEST = 'features/customers/domain/digest.graph.json';
const AT = `@${DIGEST}#nodes`;
const CUSTOMER = '@features/customers/domain/Customer.shape.json';

/** The digest with the totals node's input `field` set to `path`. */
const totalling = (field: string, path: string) => (doc: any) => {
  doc.nodes.find((node: any) => node.id === 'tiers').in[field] = path;
};

describe('a list totalled by a path within its element', () => {
  it('checks clean as the example writes it', () => {
    expect(sabotage(DIGEST, () => {})).toEqual([]);
  });
});

describe('G028: by and sum name a path the element holds, of the type each reaches', () => {
  it('refuses a by that is not a field of the element, naming the fields it could be', () => {
    expect(sabotagePointing(DIGEST, totalling('by', 'teir'))).toEqual([`G028 ${AT}/tiers/in/by`]);
    expect(sabotageSaying(DIGEST, totalling('by', 'teir'))).toEqual([`G028 by: 'teir' is not a field of ${CUSTOMER}`]);
    expect(sabotageHinting(DIGEST, totalling('by', 'teir'))).toEqual([
      'G028 name a required string field of the element: id, name, email, tier',
    ]);
  });

  it('refuses a by that is optional and not a string', () => {
    expect(sabotagePointing(DIGEST, totalling('by', 'active'))).toEqual([`G028 ${AT}/tiers/in/by`]);
  });

  it('refuses a sum that is a string, not a number', () => {
    expect(sabotagePointing(DIGEST, totalling('sum', 'name'))).toEqual([`G028 ${AT}/tiers/in/sum`]);
    expect(sabotageSaying(DIGEST, totalling('sum', 'name'))).toEqual(["G028 sum: 'name' is string, not number"]);
  });
});
