/**
 * What a report shows of a secret and what a run hands on: a map node's own `in` and a `collect` answer are
 * redacted as its elements are, a run answers its caller the value itself, and a nested run hangs on the node
 * that ran it with its answer redacted as that node's own.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerArgs, KernelSpec, Report } from '../src/index.js';
import { Kernel, Refusal } from '../src/index.js';

const SECRET = '«secret»';

/** Two accounts, each with a password a report must never show. */
const accounts = () => [
  { name: 'ada', password: 'p-ada' },
  { name: 'bob', password: 'p-bob' },
];
const redacted = [
  { name: 'ada', password: SECRET },
  { name: 'bob', password: SECRET },
];

/** How many of the accounts it is handed still carry their password: what a node downstream sees. */
const inClear = async ({ in: input }: HandlerArgs) =>
  (input.accounts as { password: string }[]).filter(one => one.password.startsWith('p-')).length;

describe("a map node's own report", () => {
  const noted = async () => 'noted';

  it('redacts its shared inputs, and each element of over where it arrives whole as a secret item field', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['m'],
      nodes: {
        m: {
          kind: 'map',
          handler: 'noted',
          over: { value: accounts() },
          in: { token: { value: 't-1' }, note: { value: 'hello' } },
          onItemFailure: 'fail',
          redact: { in: [['token'], ['item', 'password']] },
        },
      },
    };
    const report = await new Kernel({ noted }).run(spec, {});
    expect(report.nodes.m.in).toEqual({ token: SECRET, note: 'hello', over: redacted });
  });

  it('redacts each element of over where bind hands a field of it to a secret input', async () => {
    const owned = [
      { owner: 'ops', login: { name: 'ada', password: 'p-ada' } },
      { owner: 'dev', login: { name: 'bob', password: 'p-bob' } },
    ];
    const spec: KernelSpec = {
      name: 't',
      output: ['m'],
      nodes: {
        m: {
          kind: 'map',
          handler: 'noted',
          over: { value: owned },
          in: {},
          bind: { who: ['owner'], credential: ['login'] },
          onItemFailure: 'fail',
          redact: { in: [['credential', 'password']] },
        },
      },
    };
    const report = await new Kernel({ noted }).run(spec, {});
    expect(report.nodes.m.in?.over).toEqual([
      { owner: 'ops', login: { name: 'ada', password: SECRET } },
      { owner: 'dev', login: { name: 'bob', password: SECRET } },
    ]);
    expect(report.nodes.m.items?.[0].in).toEqual({ who: 'ops', credential: { name: 'ada', password: SECRET } });
  });

  it("redacts a collect map's answer under each element's value, and hands the next node the value", async () => {
    const one = async ({ in: input }: HandlerArgs) => {
      if (input.item === 2) throw new Refusal('missing', 'no second account');
      return { name: 'ada', password: 'p-ada' };
    };
    const spec: KernelSpec = {
      name: 't',
      output: ['m'],
      nodes: {
        m: {
          kind: 'map',
          handler: 'one',
          over: { value: [1, 2] },
          in: {},
          onItemFailure: 'collect',
          redact: { out: [['password']] },
        },
      },
    };
    const report = await new Kernel({ one }).run(spec, {});
    expect(report.nodes.m.out).toEqual([
      { ok: true, value: { name: 'ada', password: SECRET } },
      { ok: false, error: 'no second account', reason: 'missing' },
    ]);
    expect(report.output).toEqual([
      { ok: true, value: { name: 'ada', password: 'p-ada' } },
      { ok: false, error: 'no second account', reason: 'missing' },
    ]);
  });
});

describe('what a run answers', () => {
  const listed = async () => accounts();
  const listing: KernelSpec = {
    name: 'inner',
    output: ['listed'],
    nodes: { listed: { kind: 'call', handler: 'listed', in: {}, redact: { out: [['password']] } } },
  };

  it('is the value itself, while the report of the node that answered it is redacted', async () => {
    const report = await new Kernel({ listed }).run(listing, {});
    expect(report.nodes.listed.out).toEqual(redacted);
    expect(report.output).toEqual(accounts());
  });

  it('hangs a nested run on the node that ran it with its answer redacted, and hands the caller the value', async () => {
    /** A graph-bound operation as the compiler registers one: it runs the nested spec, attaches it, and answers. */
    const nested = async ({ ctx }: HandlerArgs) => {
      const tried = await new Kernel({ listed }).run(listing, {});
      ctx.attempted({ startedAt: 0, endedAt: 0, error: 'answer retried', sub: tried });
      const report = await new Kernel({ listed }).run(listing, {});
      ctx.attach(report);
      return report.output;
    };
    const spec: KernelSpec = {
      name: 'outer',
      output: ['counted'],
      nodes: {
        ran: { kind: 'call', handler: 'nested', in: {}, redact: { out: [['password']] } },
        counted: { kind: 'call', handler: 'inClear', in: { accounts: { ref: 'ran', path: [] } } },
      },
    };
    const report = await new Kernel({ nested, inClear }).run(spec, {});
    const ran = report.nodes.ran;
    expect(ran.out).toEqual(redacted);
    expect((ran.sub as Report).output).toEqual(redacted);
    expect(ran.attempts?.[0].sub?.output).toEqual(redacted);
    expect(report.output).toBe(2);
  });
});
