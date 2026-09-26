import { describe, expect, it } from 'vitest';
import type { KernelSpec } from '../src/index.js';
import { Kernel, redactValue } from '../src/index.js';

const SECRET = '«secret»';

/** Two accounts, each with a password a report must never show. */
const accounts = () => [
  { name: 'ada', password: 'p-ada' },
  { name: 'bob', password: 'p-bob' },
];

describe('a redacted value', () => {
  it('redacts a secret field of every element of a list result', () => {
    // a `returns` of list<Account> gives the path ["password"]: a list adds no segment
    expect(redactValue(accounts(), [['password']])).toEqual([
      { name: 'ada', password: SECRET },
      { name: 'bob', password: SECRET },
    ]);
  });

  it('redacts a secret field of every element of a list field', () => {
    const owner = { owner: 'ops', accounts: accounts() };
    expect(redactValue(owner, [['accounts', 'password']])).toEqual({
      owner: 'ops',
      accounts: [
        { name: 'ada', password: SECRET },
        { name: 'bob', password: SECRET },
      ],
    });
  });

  it('redacts through a list inside a list, at the root and below a field', () => {
    expect(redactValue([accounts(), [{ name: 'cy', password: 'p-cy' }]], [['password']])).toEqual([
      [
        { name: 'ada', password: SECRET },
        { name: 'bob', password: SECRET },
      ],
      [{ name: 'cy', password: SECRET }],
    ]);
    const teams = [{ team: 'a', members: accounts() }];
    expect(redactValue(teams, [['members', 'password']])).toEqual([
      {
        team: 'a',
        members: [
          { name: 'ada', password: SECRET },
          { name: 'bob', password: SECRET },
        ],
      },
    ]);
  });

  it('redacts an object path as before, and the whole value for a path of no segments', () => {
    const signed = { user: { name: 'ada', password: 'p-ada' }, token: 't' };
    expect(redactValue(signed, [['user', 'password'], ['token']])).toEqual({
      user: { name: 'ada', password: SECRET },
      token: SECRET,
    });
    expect(redactValue(signed, [[]])).toBe(SECRET);
  });

  it('changes nothing where a path leads nowhere', () => {
    const value = { user: { name: 'ada' }, plain: 'x', none: null, list: [{ name: 'bob' }, 3] };
    const paths = [
      ['user', 'password'],
      ['plain', 'password'],
      ['none', 'password'],
      ['missing'],
      ['list', 'password'],
    ];
    expect(redactValue(value, paths)).toEqual(value);
  });

  it('redacts the elements of a list that carry the field, and adds it to none that lack it', () => {
    expect(redactValue([{ name: 'ada' }, { name: 'bob', password: 'p-bob' }], [['password']])).toEqual([
      { name: 'ada' },
      { name: 'bob', password: SECRET },
    ]);
  });

  it('redacts a copy and leaves the value itself as it was', () => {
    const value = accounts();
    redactValue(value, [['password']]);
    expect(value).toEqual(accounts());
  });
});

describe('a report of a call or a map that answers a list', () => {
  const listed = async () => accounts();
  /** How many of the accounts it is handed still carry their password: what a node downstream sees. */
  const inClear = async ({ in: input }: { in: Record<string, unknown> }) =>
    (input.accounts as { password: string }[]).filter(one => one.password.startsWith('p-')).length;

  it("shows a call's list answer redacted, and hands the next node the value in clear", async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['counted'],
      nodes: {
        listed: { kind: 'call', handler: 'listed', in: {}, redact: { out: [['password']] } },
        counted: { kind: 'call', handler: 'inClear', in: { accounts: { ref: 'listed', path: [] } } },
      },
    };
    const report = await new Kernel({ listed, inClear }).run(spec, {});
    expect(report.nodes.listed.out).toEqual([
      { name: 'ada', password: SECRET },
      { name: 'bob', password: SECRET },
    ]);
    expect(report.output).toBe(2);
  });

  it('shows each list a map element answers redacted, in the element and in the answer', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['m'],
      nodes: {
        m: {
          kind: 'map',
          handler: 'listed',
          over: { value: [1, 2] },
          in: {},
          onItemFailure: 'fail',
          redact: { out: [['password']] },
        },
      },
    };
    const report = await new Kernel({ listed }).run(spec, {});
    const redacted = [
      { name: 'ada', password: SECRET },
      { name: 'bob', password: SECRET },
    ];
    expect(report.nodes.m.items?.map(item => item.out)).toEqual([redacted, redacted]);
    expect(report.nodes.m.out).toEqual([redacted, redacted]);
  });
});
