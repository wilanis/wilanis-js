/**
 * An invariant sabotaged, in both its forms. The example's access invariants say that every write of the registry
 * is gated by the registrar policy and that nothing touches a session without a principal proved, so breaking a
 * trigger, the invariant's own references, or what it constrains is what the I family answers. Its field
 * invariants say a customer is always reachable and that its address names its domain, so breaking a rule itself
 * (I004), or writing a value that contradicts one where every read is a literal (I005), is what the site rules
 * answer.
 */
import { schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { plantedEditing, plantedEditingAllAt, sabotage, sabotageSaying } from './example-harness.js';

const WRITES = 'features/customers/domain/writes-are-for-registrars.invariant.json';
const SESSIONS = 'features/directories/domain/the-session-is-the-callers.invariant.json';
const REACHABLE = 'features/customers/domain/a-customer-is-reachable.invariant.json';
const ADDRESS = 'features/customers/domain/an-address-names-its-domain.invariant.json';
/** The graph whose `row` node makes a customer: where a literal value is written to contradict the rule. */
const STORED = 'features/customers/data/store-and-latest.graph.json';
/**
 * What a tree answers once nothing of `Customer` is guarded any more: the nine triggers of the registry that map
 * `invariant` reach no guard, and T006 refuses each for mapping a reason it cannot be answered with. A rule
 * that guards nothing takes its reason with it, which is the whole of what makes the word honest. While one of
 * the example's two rules still holds of `Customer`, its guard still answers the reason, and no T006 follows.
 */
const UNGUARDED = Array.from({ length: 9 }, () => 'T006');
/** An edit pointing a field invariant at another shape than `Customer`. */
const onto = (shape: string) => (invariant: any) => {
  invariant.holds.on = shape;
};

describe('sabotage: invariants, the access form', () => {
  it('I001 a trigger reaching a gated operation without the policy the invariant names', () => {
    expect(
      sabotage('features/customers/edge/delete-customer.trigger.json', trigger => {
        trigger.policies.pop();
      }),
    ).toEqual(['I001']);
  });

  it('I001 names the operation a trigger reached through when it did not fire it', () => {
    expect(
      sabotageSaying('features/customers/edge/import-customers.trigger.json', trigger => {
        trigger.policies.pop();
      }).filter(one => one.startsWith('I001')),
    ).toEqual([
      "I001 trigger reaches @features/customers/domain/customer.port.json#import, which 'Writes are for registrars' (@features/customers/domain/writes-are-for-registrars.invariant.json) gates with @access/edge/can-register.policy.json, but attaches no such policy",
    ]);
  });

  it('I001 the proves form: a path none of the policies a reaching trigger attaches establishes', () => {
    expect(
      sabotage(SESSIONS, invariant => {
        invariant.access.requires.proves = ['context.challenge'];
      }),
    ).toEqual(['I001', 'I001', 'I001']);
  });

  it('I002 over naming a native operation, and proves naming a path no guard hands', () => {
    expect(
      sabotage(WRITES, invariant => {
        invariant.access.over = ['@http/http.port.json#request'];
      }),
    ).toEqual(['I002', 'I003']);
    expect(
      sabotage(SESSIONS, invariant => {
        invariant.access.requires.proves = ['context.nope'];
      }),
    ).toEqual(['I002']);
  });

  it('R001 an invariant naming a policy the tree has not, and an operation it has not', () => {
    expect(
      sabotage(WRITES, invariant => {
        invariant.access.requires.policy = '@access/edge/nope.policy.json';
      }),
    ).toEqual(['R001']);
    expect(
      sabotage(WRITES, invariant => {
        invariant.access.over = ['@customers/domain/customer.port.json#nope'];
      }),
    ).toEqual(['R001', 'I003']);
  });

  it('I003 an invariant over an operation no trigger reaches', () => {
    expect(
      sabotage(WRITES, invariant => {
        invariant.access.over = ['@customers/domain/customer.port.json#prepare'];
      }),
    ).toEqual(['I003']);
  });
});

describe('sabotage: invariants, the field form', () => {
  it('I004 a rule whose root is not a field of the shape', () => {
    expect(
      sabotageSaying(REACHABLE, invariant => {
        invariant.holds.when = 'quantity >= 0';
      }),
    ).toEqual([
      "I004 'quantity' is not an input of this node (inputs: id, name, email, tier, registrar, active, note)",
    ]);
  });

  it('I004 a rule that does not type against the fields it names', () => {
    expect(
      sabotage(REACHABLE, invariant => {
        invariant.holds.when = 'email > 3';
      }),
    ).toEqual(['I004']);
  });

  it('I004 a rule that does not parse, and one that is not a boolean', () => {
    expect(
      sabotage(REACHABLE, invariant => {
        invariant.holds.when = 'len(email) >';
      }),
    ).toEqual(['I004']);
    expect(
      sabotage(REACHABLE, invariant => {
        invariant.holds.when = 'len(email)';
      }),
    ).toEqual(['I004']);
  });

  it('I002 holds.on naming an edge shape, and R001 naming no shape at all', () => {
    // the address rule still guards Customer, so the guard's reason is still answered where it is mapped
    expect(sabotage(REACHABLE, onto('@customers/edge/CustomerView.shape.json'))).toEqual(['I002']);
    expect(sabotage(REACHABLE, onto('@customers/domain/Nope.shape.json'))).toEqual(['R001']);
  });

  it('T006 every mapping of the guard s reason, once neither rule guards Customer', () => {
    // pointing both rules at another shape guards nothing of Customer any more, so every trigger that mapped the
    // guard's reason now maps one it cannot reach (T006). That is the price the RFC names: the reason and the
    // guard stand or fall together, and the nine mappings the example carries say so.
    const edge = onto('@customers/edge/CustomerView.shape.json');
    const codes = plantedEditingAllAt({}, { [REACHABLE]: edge, [ADDRESS]: edge }).map(one => one.split(' ')[0]);
    expect(codes).toEqual([...UNGUARDED, 'I002', 'I002']);
  });

  it('I003 a rule over a core shape no graph makes or takes', () => {
    // the address rule still guards Customer, so only the rule moved to the unmade shape is refused
    // every core shape of the example is made or taken somewhere, so the case plants one nothing names
    const unmade = {
      $schema: schemaUrl('shape'),
      label: 'Unmade',
      layer: 'core',
      description: 'A shape no graph makes or takes.',
      fields: { tier: { type: 'string' } },
    };
    expect(
      plantedEditing({ 'features/customers/domain/Unmade.shape.json': unmade }, REACHABLE, invariant => {
        invariant.holds.on = '@customers/domain/Unmade.shape.json';
        invariant.holds.when = 'len(tier) > 0';
      }),
    ).toEqual(['I003']);
  });

  it('I006 a refuse node an author wrote whose reason is the word a guard is refused with', () => {
    expect(
      sabotageSaying(STORED, graph => {
        graph.nodes[5].in.reason = 'invariant';
      }).filter(one => one.startsWith('I006')),
    ).toEqual(["I006 reason 'invariant' is reserved"]);
  });

  it('I005 a site whose every read is literal and contradicts the rule', () => {
    // an empty address breaks both rules, and each is refused with its own sentence
    expect(
      sabotageSaying(STORED, graph => {
        graph.nodes[4].in.value = { id: 'x', name: 'Ada', email: '', tier: 'bronze' };
      }).filter(one => one.startsWith('I005')),
    ).toEqual([
      "I005 the value 'customer' makes contradicts 'A customer is reachable' " +
        '(@features/customers/domain/a-customer-is-reachable.invariant.json): ' +
        "'len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))' is false where email = \"\"",
      "I005 the value 'customer' makes contradicts 'An address names its domain' " +
        '(@features/customers/domain/an-address-names-its-domain.invariant.json): ' +
        "'email contains '@'' is false where email = \"\"",
    ]);
  });

  it('I005 a literal address that holds no @, and none where it does', () => {
    const written = (email: string) => (graph: any) => {
      graph.nodes[4].in.value = { id: 'x', name: 'Ada', email, tier: 'bronze' };
    };
    expect(sabotageSaying(STORED, written('ada.example.com')).filter(one => one.startsWith('I005'))).toEqual([
      "I005 the value 'customer' makes contradicts 'An address names its domain' " +
        '(@features/customers/domain/an-address-names-its-domain.invariant.json): ' +
        "'email contains '@'' is false where email = \"ada.example.com\"",
    ]);
    expect(sabotage(STORED, written('ada@example.com'))).toEqual([]);
  });

  it('I004 a contains rule whose word is a field, not a word written in the rule', () => {
    expect(
      sabotageSaying(ADDRESS, invariant => {
        invariant.holds.when = 'email contains name';
      }),
    ).toEqual(["I004 contains looks for a word written in the rule, as email contains '@', not for 'name'"]);
  });

  it('I005 a literal gold account that carries no note, and none where it does', () => {
    const gold = (rest: Record<string, unknown>) => ({
      id: 'x',
      name: 'Ada',
      email: 'ada@x.test',
      tier: 'gold',
      ...rest,
    });
    expect(
      sabotage(STORED, graph => {
        graph.nodes[4].in.value = gold({});
      }),
    ).toEqual(['I005']);
    expect(
      sabotage(STORED, graph => {
        graph.nodes[4].in.value = gold({ note: 'signed by the board' });
      }),
    ).toEqual([]);
  });
});
