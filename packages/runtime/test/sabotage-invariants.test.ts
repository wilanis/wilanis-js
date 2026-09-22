/**
 * An invariant sabotaged, in both its forms. The example's access invariants say that every write of the registry
 * is gated by the registrar policy and that nothing touches a session without a principal proved, so breaking a
 * trigger, the invariant's own references, or what it constrains is what the I family answers. Its field
 * invariant says a customer is always reachable, so breaking the rule itself (I004), or writing a
 * value that contradicts it where every read is a literal (I005), is what the site rules answer.
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageSaying } from './example-harness.js';

const WRITES = 'features/customers/domain/writes-are-for-registrars.invariant.json';
const SESSIONS = 'features/directories/domain/the-session-is-the-callers.invariant.json';
const REACHABLE = 'features/customers/domain/a-customer-is-reachable.invariant.json';
/** The graph whose `row` node makes a customer: where a literal value is written to contradict the rule. */
const STORED = 'features/customers/data/store-and-latest.graph.json';
/**
 * What a tree answers once nothing of `Customer` is guarded any more: the eight triggers of the registry that map
 * `invariant` reach no guard, and T006 refuses each for mapping a reason it cannot be answered with. A rule
 * that guards nothing takes its reason with it, which is the whole of what makes the word honest.
 */
const UNGUARDED = Array.from({ length: 8 }, () => 'T006');

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
        invariant.access.requires.proves = ['request.challenge'];
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
        invariant.access.requires.proves = ['request.nope'];
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
    // pointing the rule at another shape guards nothing of Customer any more, so every trigger that mapped the
    // guard's reason now maps one it cannot reach (T006). That is the price the RFC names: the reason and the
    // guard stand or fall together, and the eight mappings the example carries say so.
    expect(
      sabotage(REACHABLE, invariant => {
        invariant.holds.on = '@customers/edge/CustomerView.shape.json';
      }),
    ).toEqual([...UNGUARDED, 'I002']);
    expect(
      sabotage(REACHABLE, invariant => {
        invariant.holds.on = '@customers/domain/Nope.shape.json';
      }),
    ).toEqual([...UNGUARDED, 'R001']);
  });

  it('I003 a rule over a core shape no graph makes or takes', () => {
    expect(
      sabotage(REACHABLE, invariant => {
        invariant.holds.on = '@customers/domain/TierLatest.shape.json';
        invariant.holds.when = 'len(tier) > 0';
      }),
    ).toEqual([...UNGUARDED, 'I003']);
  });

  it('I006 a refuse node an author wrote whose reason is the word a guard is refused with', () => {
    expect(
      sabotageSaying(STORED, graph => {
        graph.nodes[5].in.reason = 'invariant';
      }).filter(one => one.startsWith('I006')),
    ).toEqual(["I006 reason 'invariant' is reserved"]);
  });

  it('I005 a site whose every read is literal and contradicts the rule', () => {
    expect(
      sabotageSaying(STORED, graph => {
        graph.nodes[4].in.value = { id: 'x', name: 'Ada', email: '', tier: 'bronze' };
      }).filter(one => one.startsWith('I005')),
    ).toEqual([
      "I005 the value 'customer' makes contradicts 'A customer is reachable' " +
        '(@features/customers/domain/a-customer-is-reachable.invariant.json): ' +
        "'len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))' is false where email = \"\"",
    ]);
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
