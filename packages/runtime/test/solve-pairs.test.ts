import { describe, expect, it } from 'vitest';
import type { Branch } from '../src/domains.js';
import { branchesOf } from '../src/solve.js';

/** The case of one switch that routes to a target. */
const to = (branches: Branch[], target: string) => branches.find(one => one.to === target)!;
const long = (count: number) => ({ minLen: count, maxLen: count, present: true });

describe('solving a two-length rule inside the bounds earlier rules set (#915)', () => {
  // each operator, after `len(a) <= 2`: the lengths its rule is met by, and the lengths its else is met by
  const cases: [string, [number, number], [number, number]][] = [
    ['==', [3, 3], [3, 1]],
    ['!=', [3, 1], [3, 3]],
    ['<', [3, 4], [3, 1]],
    ['<=', [3, 3], [3, 1]],
    ['>', [3, 1], [3, 3]],
    ['>=', [3, 1], [3, 4]],
  ];
  it.each(cases)('solves len(a) %s len(b) where an earlier rule pushes a past 2', (op, rule, otherwise) => {
    const bs = branchesOf(
      [
        { when: 'len(a) <= 2', to: 'short' },
        { when: `len(a) ${op} len(b)`, to: 'yes' },
      ],
      'no',
    );
    expect(to(bs, 'yes').unsolved).toBeUndefined();
    expect(to(bs, 'yes').demands).toEqual({ a: long(rule[0]), b: long(rule[1]) });
    expect(to(bs, 'no').unsolved).toBeUndefined();
    expect(to(bs, 'no').demands).toEqual({ a: long(otherwise[0]), b: long(otherwise[1]) });
  });

  it('meets the bounds earlier rules set on both sides', () => {
    const bs = branchesOf(
      [
        { when: 'len(a) < 4 || len(b) < 4', to: 'small' },
        { when: 'len(a) == len(b)', to: 'even' },
      ],
      'odd',
    );
    expect(to(bs, 'even').demands).toEqual({ a: long(4), b: long(4) });
    expect(to(bs, 'odd').demands).toEqual({ a: long(4), b: long(5) });
  });

  it('meets a value an earlier rule bounds, against a length', () => {
    const bs = branchesOf(
      [
        { when: 'limit < 3', to: 'tight' },
        { when: 'len(rows) >= limit', to: 'full' },
      ],
      'room',
    );
    expect(to(bs, 'full').demands).toEqual({ rows: long(3), limit: { gte: 3, eq: 3, present: true } });
    expect(to(bs, 'room').demands).toEqual({ rows: long(1), limit: { gte: 3, eq: 3, present: true } });
  });

  it('meets a bound the other half of a conjunction sets', () => {
    const bs = branchesOf([{ when: 'len(a) == len(b) && len(b) > 3', to: 'yes' }], 'no');
    expect(to(bs, 'yes').demands).toEqual({ a: long(4), b: long(4) });
  });

  it('holds a length at 0 only where the bounds leave it nothing else', () => {
    const bs = branchesOf(
      [
        { when: 'len(b) > 1', to: 'long' },
        { when: 'len(a) < len(b)', to: 'shorter' },
      ],
      'not',
    );
    expect(to(bs, 'shorter').demands).toEqual({ a: long(0), b: long(1) });
    expect(to(bs, 'not').demands).toEqual({ a: long(1), b: long(1) });
  });

  it('names its own limit where no case it finds for the earlier rules lets the rule hold', () => {
    const bs = branchesOf(
      [
        { when: 'len(a) < 3 || len(b) > 2', to: 'skip' },
        { when: 'len(a) == len(b)', to: 'even' },
      ],
      'odd',
    );
    expect(to(bs, 'even').unsolved).toBe(
      "no case the solver finds for the rules before it lets 'len(a) == len(b)' hold",
    );
    expect(to(bs, 'odd').demands).toEqual({ a: long(3), b: long(1) });
  });

  it('never says the rules contradict where its own case for them is narrower than they are', () => {
    // the else of the first rule is solved as len(a) > 2 and len(b) <= 2, yet a = 1, b = 2 also leaves it false
    const bs = branchesOf(
      [
        { when: 'len(a) == 2 || len(b) > 2', to: 'skip' },
        { when: 'len(a) < len(b)', to: 'shorter' },
      ],
      'not',
    );
    expect(to(bs, 'shorter').unsolved).toBe(
      "no case the solver finds for the rules before it lets 'len(a) < len(b)' hold",
    );
    expect(to(bs, 'shorter').unsolved).not.toMatch(/contradict/);
  });

  it('steps past the values earlier rules exclude', () => {
    const bs = branchesOf(
      [
        { when: 'limit < 1', to: 'none' },
        { when: 'limit == 1', to: 'one' },
        { when: 'limit == 2', to: 'two' },
        { when: 'len(rows) == limit', to: 'full' },
      ],
      'room',
    );
    expect(to(bs, 'full').unsolved).toBeUndefined();
    expect(to(bs, 'full').demands).toEqual({ rows: long(3), limit: { gte: 1, ne: [1, 2], eq: 3, present: true } });
  });
});
