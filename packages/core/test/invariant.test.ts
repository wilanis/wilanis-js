import { describe, expect, it } from 'vitest';
import { at, doc, refused } from './documents.js';

describe('invariant', () => {
  const access = (requires: unknown) => ({
    over: ['@features/customers/domain/customer.port.json#register'],
    requires,
  });
  const holds = {
    on: '@features/customers/domain/Customer.shape.json',
    when: "len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))",
  };
  const form = (body: Record<string, unknown>) => {
    const { holds: _baseline, ...envelope } = doc('invariant');
    return { ...envelope, ...body };
  };

  it('the access form: operations, and the policy or the proofs every reaching trigger must carry', () => {
    expect(refused(form({ access: access({ policy: '@access/edge/can-register.policy.json' }) }))).toEqual([]);
    expect(refused(form({ access: access({ proves: ['context.principal'] }) }))).toEqual([]);
    expect(
      refused(
        form({ access: access({ policy: '@access/edge/can-register.policy.json', proves: ['context.session.id'] }) }),
      ),
    ).toEqual([]);
  });

  it('the field form: a shape, and a rule over its fields', () => {
    expect(refused(form({ holds }))).toEqual([]);
    expect(refused(form({ label: 'A customer is reachable', holds }))).toEqual([]);
  });

  it('a document is exactly one of the two forms: both is refused, and neither', () => {
    expect(refused(form({ access: access({ proves: ['context.principal'] }), holds }))).toEqual([
      at('holds', "'holds' is not allowed here"),
      at('access', "'access' is not allowed here"),
    ]);
    expect(refused(form({}))).toEqual([at(undefined, "missing 'access'"), at(undefined, "missing 'holds'")]);
  });

  it('over names at least one operation without repeating one, and requires says at least one thing', () => {
    expect(refused(form({ access: { over: [], requires: { proves: ['context.principal'] } } }))).toEqual([
      at('access/over', 'fewer than 1 items'),
    ]);
    const twice = ['@features/f/domain/f.port.json#write', '@features/f/domain/f.port.json#write'];
    expect(refused(form({ access: { over: twice, requires: { proves: ['context.principal'] } } }))).toEqual([
      at('access/over', 'duplicate items'),
    ]);
    expect(refused(form({ access: access({}) }))).toEqual([at('access/requires', 'fewer than 1 properties')]);
    expect(refused(form({ access: access({ proves: ['principal'] }) }))).toEqual([
      at('access/requires/proves/0', '^context'),
    ]);
    expect(
      refused(
        form({ access: { over: ['@features/f/domain/f.port.json'], requires: { proves: ['context.principal'] } } }),
      ),
    ).toEqual([at('access/over/0', 'path#operation')]);
  });

  it('holds names a shape and a rule, and nothing else', () => {
    expect(refused(form({ holds: { on: holds.on } }))).toEqual([at('holds', "missing 'when'")]);
    expect(refused(form({ holds: { when: 'true' } }))).toEqual([at('holds', "missing 'on'")]);
    expect(refused(form({ holds: { ...holds, when: '' } }))).toEqual([at('holds/when', 'fewer than 1 characters')]);
    expect(refused(form({ holds: { ...holds, over: [] } }))).toEqual([at('holds', "unknown property 'over'")]);
  });
});
