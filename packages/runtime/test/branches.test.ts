import { describe, expect, it } from 'vitest';
import { type Branch, branchesOf, satisfy } from '../src/branches.js';
import { NO_MEMBER } from '../src/stubs.js';

/** The demands of one case, by the node it routes to. */
const to = (branches: Branch[], target: string) => branches.find(one => one.to === target)!;

describe('solving a switch to its branches', () => {
  it('gives one case per rule and one for the else', () => {
    const bs = branchesOf(
      [
        { when: 'a == 1', to: 'x' },
        { when: 'a == 2', to: 'y' },
      ],
      'z',
    );
    expect(bs.map(one => one.to)).toEqual(['x', 'y', 'z']);
    expect(bs.map(one => one.rule)).toEqual([0, 1, -1]);
  });

  it('solves the example rule: an equality and a presence together', () => {
    const bs = branchesOf([{ when: 'status == 200 && has(body)', to: 'rows' }], 'failed');
    expect(to(bs, 'rows').demands).toEqual({ status: { eq: 200, present: true }, body: { present: true } });
    // the else needs only the equality to fail; body may be anything
    expect(to(bs, 'failed').demands).toEqual({ status: { ne: [200] } });
  });

  it('narrows a later rule against the rules before it', () => {
    const bs = branchesOf(
      [
        { when: 'n > 10', to: 'big' },
        { when: 'n > 5', to: 'mid' },
      ],
      'small',
    );
    expect(to(bs, 'mid').demands).toEqual({ n: { gt: 5, present: true, lte: 10 } });
    expect(to(bs, 'small').demands).toEqual({ n: { lte: 5, present: true } });
  });

  it('treats a missing path as satisfying an inequality', () => {
    const bs = branchesOf(
      [
        { when: 'kind == "urgent"', to: 'a' },
        { when: '!has(kind)', to: 'b' },
      ],
      'c',
    );
    expect(to(bs, 'b').demands.kind.absent).toBe(true);
  });

  it('solves len() to a length rather than a value', () => {
    const bs = branchesOf([{ when: 'len(rows) > 50', to: 'page' }], 'whole');
    expect(to(bs, 'page').demands).toEqual({ rows: { minLen: 51, present: true } });
    expect(to(bs, 'whole').demands).toEqual({ rows: { maxLen: 50, present: true } });
  });

  it('takes one side of a disjunction', () => {
    const bs = branchesOf([{ when: 'status == 200 || status == 201', to: 'ok' }], 'bad');
    expect(to(bs, 'ok').demands.status.eq).toBe(200);
    expect(to(bs, 'bad').demands.status.ne).toEqual([200, 201]);
  });

  it('reports a rule shadowed by an earlier one as uncovered', () => {
    const bs = branchesOf(
      [
        { when: 'status >= 200', to: 'rows' },
        { when: 'status == 200', to: 'also' },
      ],
      'failed',
    );
    expect(to(bs, 'also').unsolved).toMatch(/no inputs satisfy/);
  });

  it('reports a self-contradictory rule as uncovered', () => {
    const bs = branchesOf([{ when: 'n > 10 && n < 5', to: 'never' }], 'always');
    expect(to(bs, 'never').unsolved).toMatch(/contradicts itself/);
  });

  it('solves two paths compared equal by demanding one value of both, and unequal by two (#845)', () => {
    const bs = branchesOf([{ when: 'a == b', to: 'same' }], 'diff');
    expect(to(bs, 'same').demands).toEqual({
      a: { paired: 'equal', present: true },
      b: { paired: 'equal', present: true },
    });
    expect(to(bs, 'diff').demands).toEqual({ a: { paired: 'equal', present: true }, b: { paired: 'unequal' } });
  });

  it('meets two paths compared unequal either way round, so an earlier pair in the other order leaves it a case', () => {
    const turned = branchesOf(
      [
        { when: 'b == a', to: 'same' },
        { when: 'a != b', to: 'apart' },
      ],
      'never',
    );
    expect(to(turned, 'apart').unsolved).toBeUndefined();
    // `b == a` false is met either way round; only the second, a at the generated value, also meets `a != b`
    expect(to(turned, 'apart').demands).toEqual({
      a: { paired: 'equal', present: true },
      b: { paired: 'unequal' },
    });
    const chained = branchesOf(
      [
        { when: 'a == b', to: 'first' },
        { when: 'c == a', to: 'second' },
        { when: 'n == 1', to: 'third' },
      ],
      'rest',
    );
    expect(to(chained, 'third').unsolved).toBeUndefined();
    expect(to(chained, 'third').demands.n).toEqual({ eq: 1, present: true });
  });

  it('solves a presence and an equality of two paths together, which do not contradict (#845)', () => {
    const bs = branchesOf([{ when: 'has(previous) && previous == commit', to: 'same' }], 'moved');
    expect(to(bs, 'same').unsolved).toBeUndefined();
    expect(to(bs, 'same').demands).toEqual({
      previous: { paired: 'equal', present: true },
      commit: { paired: 'equal', present: true },
    });
  });

  it('says it cannot compare two paths it cannot solve, not that the rule contradicts itself (#845)', () => {
    const bs = branchesOf([{ when: 'has(a) && a < b', to: 'less' }], 'more');
    expect(to(bs, 'less').unsolved).toBe("the solver cannot compare two paths as 'has(a) && a < b' does");
  });

  it('says the same of two paths it pairs one way only, rather than judge the rule', () => {
    const bs = branchesOf([{ when: 'a == b && a != b', to: 'never' }], 'always');
    expect(to(bs, 'never').unsolved).toBe("the solver cannot compare two paths as 'a == b && a != b' does");
  });
});

/** A demand for a list or string of exactly this many elements. */
const long = (count: number) => ({ minLen: count, maxLen: count, present: true });

describe('solving a rule that compares a length with another side (#905)', () => {
  // each operator, the lengths its rule is met by, and the lengths its else is met by
  const cases: [string, [number, number], [number, number]][] = [
    ['==', [1, 1], [1, 2]],
    ['!=', [1, 2], [1, 1]],
    ['<', [1, 2], [1, 1]],
    ['<=', [1, 1], [2, 1]],
    ['>', [2, 1], [1, 1]],
    ['>=', [1, 1], [1, 2]],
  ];
  it.each(cases)('solves len(a) %s len(b) and its else to concrete lengths', (op, rule, otherwise) => {
    const bs = branchesOf([{ when: `len(a) ${op} len(b)`, to: 'yes' }], 'no');
    expect(to(bs, 'yes').unsolved).toBeUndefined();
    expect(to(bs, 'yes').demands).toEqual({ a: long(rule[0]), b: long(rule[1]) });
    expect(to(bs, 'no').unsolved).toBeUndefined();
    expect(to(bs, 'no').demands).toEqual({ a: long(otherwise[0]), b: long(otherwise[1]) });
  });

  it('solves a length against a path to a length and a number, either side first', () => {
    const bs = branchesOf([{ when: 'len(rows) < limit', to: 'room' }], 'full');
    expect(to(bs, 'room').demands).toEqual({ rows: long(1), limit: { eq: 2, present: true } });
    expect(to(bs, 'full').demands).toEqual({ rows: long(1), limit: { eq: 1, present: true } });
    const turned = branchesOf([{ when: 'limit > len(rows)', to: 'room' }], 'full');
    expect(to(turned, 'room').demands).toEqual({ rows: long(1), limit: { eq: 2, present: true } });
  });

  it('takes the next pair where an earlier rule rules the first out', () => {
    const bs = branchesOf(
      [
        { when: 'len(a) < 2', to: 'short' },
        { when: 'len(a) == len(b)', to: 'even' },
      ],
      'odd',
    );
    expect(to(bs, 'even').demands).toEqual({ a: long(2), b: long(2) });
    expect(to(bs, 'odd').demands).toEqual({ a: long(2), b: long(1) });
  });

  it('says it cannot compare a length with itself unequal, rather than judge the rule', () => {
    const bs = branchesOf([{ when: 'len(a) != len(a)', to: 'never' }], 'always');
    expect(to(bs, 'never').unsolved).toBe("the solver cannot compare two paths as 'len(a) != len(a)' does");
    expect(to(bs, 'always').demands).toEqual({ a: long(1) });
  });
});

describe('turning a demand into a value', () => {
  it('keeps what the seed generated when it already satisfies the demand', () => {
    expect(satisfy({ gt: 100, present: true }, 200)).toBe(200);
    expect(satisfy({ ne: [200] }, 404)).toBe(404);
  });
  it('replaces a value the demand excludes', () => {
    expect(satisfy({ eq: 201, present: true }, 500)).toBe(201);
  });
  it('excludes a status with a failure, not with the next success code', () => {
    // 201 satisfies != 200 arithmetically, but a branch testing the error path must not see a success
    expect(satisfy({ ne: [200] }, 200)).toBe(500);
    expect(satisfy({ ne: [200] }, 201)).toBe(500);
    expect(satisfy({ ne: [201] }, undefined)).toBe(500);
  });
  it('deletes the key for an absence', () => {
    expect(satisfy({ absent: true }, 'anything')).toBeUndefined();
  });
  it('pads a list out to a demanded length', () => {
    expect(satisfy({ minLen: 3, present: true }, ['a'])).toHaveLength(3);
    expect(satisfy({ maxLen: 1, present: true }, ['a', 'b', 'c'])).toHaveLength(1);
  });
  it('meets a length on a string with a string, not a list, so its readers still see the declared type (#625)', () => {
    const text = { kind: 'string' } as const;
    expect(satisfy({ minLen: 1, present: true }, undefined, text)).toBe('x');
    expect(satisfy({ minLen: 1, present: true }, 'Ada', text)).toBe('Ada');
    expect(satisfy({ maxLen: 0, present: true }, 'Ada', text)).toBe('');
    expect(satisfy({ minLen: 3, present: true }, 'a')).toBe('axx');
  });
  it('generates a value of the declared type for a bare presence', () => {
    const list = satisfy({ present: true }, undefined, { kind: 'list', of: { kind: 'string' } });
    expect(Array.isArray(list)).toBe(true);
  });
  it('excludes an enum member with another member, never a value outside the enum (#845)', () => {
    const status = { kind: 'string', enum: ['clean', 'findings', 'broke'] } as const;
    expect(satisfy({ ne: ['clean', 'findings'] }, '', status)).toBe('broke');
    expect(satisfy({ ne: ['clean', 'findings'] }, 'clean', status)).toBe('broke');
    expect(satisfy({ ne: ['clean'] }, 'findings', status)).toBe('findings');
  });
  it('answers NO_MEMBER where the domain excludes every member of an enum, never a value outside it (#861)', () => {
    const status = { kind: 'string', enum: ['clean', 'findings', 'broke'] } as const;
    expect(satisfy({ ne: ['clean', 'findings', 'broke'] }, 'broke', status)).toBe(NO_MEMBER);
    // a string with no enum still takes a value the rules leave
    expect(satisfy({ ne: ['clean', 'findings', 'broke'] }, 'clean', { kind: 'string' })).toBe('');
  });
  it('makes two paths paired equal the same value of their type, and a path paired unequal another', () => {
    const text = { kind: 'string' } as const;
    const one = satisfy({ paired: 'equal', present: true }, 'a', text, 3);
    expect(satisfy({ paired: 'equal', present: true }, 'b', text, 3)).toBe(one);
    expect(typeof one).toBe('string');
    expect(satisfy({ paired: 'unequal' }, one, text, 3)).not.toBe(one);
    const flag = { kind: 'boolean' } as const;
    expect(satisfy({ paired: 'unequal' }, undefined, flag, 1)).toBe(!satisfy({ paired: 'equal' }, undefined, flag, 1));
  });
  it('replaces an empty list for a presence, which reads as present but breaks its readers', () => {
    const list = satisfy({ present: true }, [], { kind: 'list', of: { kind: 'string' } }) as unknown[];
    expect(list.length).toBeGreaterThan(0);
  });
});
