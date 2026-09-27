/**
 * A pure operation answers a function of its inputs alone, so a pure node that read a secret and answers none of what
 * it read as one -- text filled or joined from it -- shows its answer as the marker whole, in its own report and in
 * every read of it. Where its answer holds what it read as a secret, that part is marked and the rest is shown, and an
 * operation that is not pure shows its answer by its own marks and what it hands back.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerArgs, KCall, KernelSpec, KMap, KSource } from '../src/index.js';
import { Kernel, readPath } from '../src/index.js';

const SECRET = '«secret»';
const FILL = '@std/text.port.json#fill';
const JOIN = '@std/text.port.json#join';
const MAKE = '@std/object.port.json#make';
const COUNT = '@std/list.port.json#count';

const account = { name: 'ada', password: 'p-ada' };
const shownIn = { in: { name: 'ada', password: SECRET } };

const handlers = {
  /** As `@std` fills a template: each {name} takes values.name. */
  [FILL]: async ({ in: input }: HandlerArgs) =>
    String(input.template).replace(/\{([a-z.]+)\}/g, (_, name: string) => String(readPath(input.values, [name]))),
  [JOIN]: async ({ in: input }: HandlerArgs) => (input.parts as unknown[]).map(String).join(String(input.separator)),
  [MAKE]: async ({ in: input }: HandlerArgs) => input.value,
  [COUNT]: async ({ in: input }: HandlerArgs) => (input.list as unknown[]).length,
  echo: async ({ in: input }: HandlerArgs) => input,
  /** An effect whose answer is not derived from what it is handed: what a server answers a call made with it. */
  fetch: async () => ({ status: 200, body: 'hello ada' }),
};

const read = (ref: string, ...path: string[]): KSource => ({ ref, path });
/** A call of a pure operation with these inputs, whose operation marks nothing. */
const pure = (handler: string, input: Record<string, KSource>): KCall => ({
  kind: 'call',
  handler,
  in: input,
  pure: true,
});
/** A fill of the account's password into a header. */
const basic = pure(FILL, {
  template: { value: 'Basic {password}' },
  values: { object: { password: read('in', 'password') } },
});

/** One run of the spec over the account as `in`, its password shown as the marker as a caller's report shows it. */
const run = (spec: KernelSpec) => new Kernel(handlers).run(spec, { initial: { in: { ...account } }, shown: shownIn });

describe('a pure operation that reads a secret', () => {
  it('fills a marked read into an answer shown as the marker, in its report and in every read of it', async () => {
    const spec: KernelSpec = {
      name: 't',
      output: ['sent'],
      nodes: { header: basic, sent: { kind: 'call', handler: 'echo', in: { auth: read('header') } } },
    };
    const report = await run(spec);
    expect(report.nodes.header.in).toEqual({ template: 'Basic {password}', values: { password: SECRET } });
    expect(report.nodes.header.out).toBe(SECRET);
    expect(report.nodes.sent.in).toEqual({ auth: SECRET });
    expect(report.nodes.sent.out).toEqual({ auth: SECRET });
    // the run hands on the value itself
    expect(report.output).toEqual({ auth: 'Basic p-ada' });
  });

  it('joins a marked read into an answer shown as the marker', async () => {
    const parts = { list: [read('in', 'name'), read('in', 'password')] };
    const spec: KernelSpec = {
      name: 't',
      output: ['joined'],
      nodes: { joined: pure(JOIN, { parts, separator: { value: ':' } }) },
    };
    const report = await run(spec);
    expect(report.nodes.joined.in).toEqual({ parts: ['ada', SECRET], separator: ':' });
    expect(report.nodes.joined.out).toBe(SECRET);
    expect(report.output).toBe('ada:p-ada');
  });

  it('counts a list with a marked field into an answer shown as the marker', async () => {
    const report = await run({
      name: 't',
      output: ['counted'],
      nodes: { counted: pure(COUNT, { list: { list: [read('in')] } }) },
    });
    expect(report.nodes.counted.in).toEqual({ list: [shownIn.in] });
    expect(report.nodes.counted.out).toBe(SECRET);
    expect(report.output).toBe(1);
  });

  it('is the marker whole where the operation itself marks what it is handed', async () => {
    const values = { object: { key: { value: 'k-1' } } };
    const filled: KCall = {
      ...pure(FILL, { template: { value: 'key={key}' }, values }),
      redact: { in: [['values', 'key']], out: [] },
    };
    const report = await new Kernel(handlers).run({ name: 't', output: ['filled'], nodes: { filled } }, {});
    expect(report.nodes.filled.out).toBe(SECRET);
    expect(report.output).toBe('key=k-1');
  });

  it('reports its answer where nothing it read is marked', async () => {
    const spec: KernelSpec = { name: 't', output: ['header'], nodes: { header: basic } };
    const report = await new Kernel(handlers).run(spec, { initial: { in: { ...account } } });
    expect(report.nodes.header.in).toEqual({ template: 'Basic {password}', values: { password: 'p-ada' } });
    expect(report.nodes.header.out).toBe('Basic p-ada');
  });

  it('shows the fields of a make that are not marked, where it hands back what it read as a secret', async () => {
    const value = { object: { name: read('in', 'name'), password: read('in', 'password') } };
    const report = await run({ name: 't', output: ['made'], nodes: { made: pure(MAKE, { value }) } });
    expect(report.nodes.made.out).toEqual({ name: 'ada', password: SECRET });
    expect(report.output).toEqual(account);
  });

  it('shows the fields of a make that are not marked, where its own type already marks what it hands back', async () => {
    const value = { object: { name: read('in', 'name'), password: read('in', 'password') } };
    const made: KCall = { ...pure(MAKE, { value }), redact: { out: [['password']] } };
    const report = await run({ name: 't', output: ['made'], nodes: { made } });
    expect(report.nodes.made.out).toEqual({ name: 'ada', password: SECRET });
  });
});

describe('an operation that is not pure and reads a secret', () => {
  it('shows its answer by its own marks, since the answer is not derived from what it was handed', async () => {
    const auth = { concat: ['Bearer ', read('in', 'password')] };
    const report = await run({
      name: 't',
      output: ['fetched'],
      nodes: { fetched: { kind: 'call', handler: 'fetch', in: { auth } } },
    });
    expect(report.nodes.fetched.in).toEqual({ auth: SECRET });
    expect(report.nodes.fetched.out).toEqual({ status: 200, body: 'hello ada' });
  });
});

describe('a pure map that reads a secret', () => {
  const accounts = [account, { name: 'bob', password: 'p-bob' }];
  /** A fill of each account's password, the list marking each element's password as the operation does. */
  const headers: KMap = {
    kind: 'map',
    handler: FILL,
    over: read('in'),
    in: { template: { value: '{name}:{password}' } },
    bind: { values: [] },
    onItemFailure: 'fail',
    redact: { in: [['values', 'password']] },
    pure: true,
  };
  const spec: KernelSpec = { name: 't', output: ['headers'], nodes: { headers } };

  it('shows each element it filled from a marked read as the marker, and its answer so', async () => {
    const report = await new Kernel(handlers).run(spec, { initial: { in: accounts } });
    expect(report.nodes.headers.items?.map(item => item.out)).toEqual([SECRET, SECRET]);
    expect(report.nodes.headers.out).toEqual([SECRET, SECRET]);
    expect(report.output).toEqual(['ada:p-ada', 'bob:p-bob']);
  });

  it('shows each element as it would have shown it, where the map is seeded whole', async () => {
    const initial = { in: accounts, headers: ['ada:p-ada', 'bob:p-bob'] };
    const report = await new Kernel(handlers).run(spec, { initial });
    expect(report.nodes.headers).toEqual({ status: 'seeded', out: [SECRET, SECRET] });
  });

  it('shows an element as it would have shown it, where that element is seeded', async () => {
    const initial = { in: accounts, 'headers.0': 'ada:p-ada' };
    const report = await new Kernel(handlers).run(spec, { initial });
    expect(report.nodes.headers.items?.[0]).toMatchObject({ status: 'seeded', out: SECRET });
    expect(report.nodes.headers.out).toEqual([SECRET, SECRET]);
  });
});

describe('a seeded pure call', () => {
  it('is shown as the marker where what it reads is supplied and marked', async () => {
    const report = await new Kernel(handlers).run(
      { name: 't', output: ['header'], nodes: { header: basic } },
      { initial: { in: { ...account }, header: 'Basic p-ada' }, shown: shownIn },
    );
    expect(report.nodes.header).toEqual({ status: 'seeded', out: SECRET });
  });
});
