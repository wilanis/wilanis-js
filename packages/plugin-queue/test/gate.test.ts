/**
 * The gate over a message (RFC 0009, step 7), end to end against the real runtime: a credential rides in a
 * message's headers, the guard (`@auth`) verifies it before any graph runs, the trigger's policies allow or deny,
 * and `outcomes` says what each of the gate's reasons means to the message. The callers are the access tree's
 * fake directory, signed in through that tree's own route, as `packages/plugin-http/test/http.test.ts` signs in
 * over HTTP. Nothing here is the queue's: the embedder's gate runs over a message exactly as over a request.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import type { Trace } from '@wilanis/core';
import { runTrigger, start } from '@wilanis/runtime';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeBroker } from './fake-broker.js';
import { CAN_REGISTER, EMPLOYEES_ONLY, gated, loadGated, PARKED, REMOVE, SECRET } from './gated.js';
import { until } from './harness.js';
import { type Docs, JOBS, TRIGGER, written } from './tree.js';

const SIGN_IN_EMPLOYEE = '@access/edge/auth-employees.trigger.json';
const SIGN_IN_CUSTOMER = '@access/edge/auth-customers.trigger.json';
const REMOVALS = `@${TRIGGER}`;
/** A policy's span, which names it by its canonical path rather than the include's alias the trigger wrote. */
const spanOf = (policy: string) => `policy ${policy.replace(/^@access\//, '@features/access/')}`;
const EMPLOYEES = spanOf(EMPLOYEES_ONLY);
const REGISTRAR = spanOf(CAN_REGISTER);

let before: string | undefined;
const dirs: string[] = [];

beforeAll(() => {
  before = process.env.CUSTOMERS_JWT_SECRET;
  process.env.CUSTOMERS_JWT_SECRET = SECRET;
});

afterAll(() => {
  if (before === undefined) delete process.env.CUSTOMERS_JWT_SECRET;
  else process.env.CUSTOMERS_JWT_SECRET = before;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tree written into a directory this file removes once the case is done. */
function writtenOnce(docs: Docs): string {
  const dir = written(docs);
  dirs.push(dir);
  return dir;
}

/** Sign in through the access tree's own route, fired from the command line, and answer the access token. */
async function signIn(dir: string, route: string, username: string): Promise<string> {
  const body = JSON.stringify({ username, password: `${username}-pass` });
  const { report } = await runTrigger(
    loadGated(dir, new FakeBroker()),
    route,
    { flags: { in: body } },
    { log: () => {} },
  );
  const token = (report.output as { accessToken?: unknown }).accessToken;
  if (typeof token !== 'string') throw new Error(`signing in as ${username} answered ${report.status}`);
  return token;
}

/** A tree started with its consume step, the traces of every fire it ran, and the broker its queue is on. */
async function started(dir: string) {
  const broker = new FakeBroker();
  const traces: Trace[] = [];
  const logs: string[] = [];
  const served = await start(loadGated(dir, broker), {
    log: line => logs.push(line),
    observe: trace => traces.push(trace),
  });
  /** The fires of the queue trigger, in the order they ran. */
  const fires = () => traces.filter(trace => trace.attributes['wilanis.trigger'] === REMOVALS);
  return { broker, logs, served, fires };
}

type Started = Awaited<ReturnType<typeof started>>;

/** Publish one message carrying these headers, and wait until the worker has answered it `times` times. */
async function delivered(at: Started, headers: Record<string, string>, times = 1) {
  const { id } = await at.broker.publish(JOBS, 'removals', { body: { id: 'golf' }, headers });
  const answers = () => at.broker.answers.filter(one => one.id === id);
  const fired = at.fires().length;
  expect(await until(() => answers().length === times && at.fires().length === fired + times)).toBe(true);
  return { answers: answers(), traces: at.fires().slice(fired) };
}

/** What ran under one fire, in order: the guard, each policy, the operation, each with how it ended. */
const steps = (trace: Trace) => trace.children.map(child => `${child.name} → ${child.status}`);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('the gate over a queue message', () => {
  it('checks: the gate words are mapped, and the token is read from what the kind hands', () => {
    const dir = writtenOnce(gated());
    expect(checkTree(loadGated(dir, new FakeBroker())).items).toEqual([]);
    // the table is held like a route's: drop a word the gate can reach and T005 says so
    const { forbidden: _, ...unmapped } = PARKED;
    const docs = gated();
    (docs[TRIGGER] as any).settings.outcomes = { missing: 'ack', upstream: 'retry', ...unmapped };
    const codes = checkTree(loadGated(writtenOnce(docs), new FakeBroker())).items.map(one => one.code);
    expect(codes).toEqual(['T005']);
  });

  it("lets the registrar through: the guard names the caller from the message's headers, both policies allow, the operation runs", async () => {
    const dir = writtenOnce(gated());
    const token = await signIn(dir, SIGN_IN_EMPLOYEE, 'bo');
    const at = await started(dir);
    try {
      const { answers, traces } = await delivered(at, bearer(token));
      expect(answers.map(one => one.outcome)).toEqual(['ack']);
      expect(steps(traces[0])).toEqual([
        'identify (@auth) → ok',
        `${EMPLOYEES} → allowed`,
        `${REGISTRAR} → allowed`,
        `${REMOVE} → ok`,
      ]);
      expect(traces[0].children[0].attributes['wilanis.principal']).toBe('yes');
    } finally {
      await at.served.stop();
    }
  }, 15_000);

  it('parks every caller the gate refuses, as the table says, and no graph behind the trigger runs', async () => {
    const dir = writtenOnce(gated());
    const viewer = await signIn(dir, SIGN_IN_EMPLOYEE, 'cy');
    const customer = await signIn(dir, SIGN_IN_CUSTOMER, 'ana');
    const at = await started(dir);
    try {
      // cy is an employee without the registrar role: the first policy allows, the second denies
      const denied = await delivered(at, bearer(viewer));
      expect(denied.answers.map(one => one.outcome)).toEqual(['dead']);
      expect(steps(denied.traces[0])).toEqual([
        'identify (@auth) → ok',
        `${EMPLOYEES} → allowed`,
        `${REGISTRAR} → denied: forbidden`,
      ]);
      // ana holds a perfectly valid token, and is a customer: the first policy denies
      const other = await delivered(at, bearer(customer));
      expect(other.answers.map(one => one.outcome)).toEqual(['dead']);
      expect(steps(other.traces[0])).toEqual(['identify (@auth) → ok', `${EMPLOYEES} → denied: forbidden`]);
      // no token at all: the guard names nobody and the policy refuses the anonymous caller
      const anonymous = await delivered(at, {});
      expect(anonymous.answers.map(one => one.outcome)).toEqual(['dead']);
      expect(steps(anonymous.traces[0])).toEqual(['identify (@auth) → ok', `${EMPLOYEES} → denied: anonymous`]);
      expect(anonymous.traces[0].children[0].attributes['wilanis.principal']).toBe('no');
      // a token that does not verify: the guard refuses before any policy decides
      const forged = await delivered(at, bearer(`${viewer.slice(0, -4)}AAAA`));
      expect(forged.answers.map(one => one.outcome)).toEqual(['dead']);
      expect(steps(forged.traces[0])).toEqual(['identify (@auth) → refused: invalid_credential']);

      expect(at.broker.parked(JOBS, 'removals')).toHaveLength(4);
      expect(at.broker.waiting(JOBS, 'removals')).toEqual([]);
      expect(at.logs.some(line => line.includes('→ dead') && line.includes('refused forbidden'))).toBe(true);
      expect(at.logs.some(line => line.includes('→ dead') && line.includes('refused invalid_credential'))).toBe(true);
    } finally {
      await at.served.stop();
    }
  }, 15_000);

  it('means what outcomes says: a refused caller acknowledged, another retried and gated again on every delivery', async () => {
    const outcomes = { forbidden: 'ack', anonymous: 'retry', invalid_credential: 'retry' };
    const dir = writtenOnce(gated(outcomes, { maxAttempts: 2, backoffMs: 5 }));
    const viewer = await signIn(dir, SIGN_IN_EMPLOYEE, 'cy');
    const at = await started(dir);
    try {
      const acked = await delivered(at, bearer(viewer));
      expect(acked.answers.map(one => one.outcome)).toEqual(['ack']);

      const retried = await delivered(at, {}, 2);
      expect(retried.answers.map(one => `${one.attempt}:${one.outcome}`)).toEqual(['1:retry', '2:dead']);
      for (const trace of retried.traces) expect(steps(trace).at(-1)).toBe(`${EMPLOYEES} → denied: anonymous`);

      const forged = await delivered(at, { authorization: 'Bearer not-a-token' }, 2);
      expect(forged.answers.map(one => `${one.attempt}:${one.outcome}`)).toEqual(['1:retry', '2:dead']);
      for (const trace of forged.traces)
        expect(steps(trace)).toEqual(['identify (@auth) → refused: invalid_credential']);

      expect(at.broker.parked(JOBS, 'removals')).toHaveLength(2);
    } finally {
      await at.served.stop();
    }
  }, 15_000);

  it('gates nothing where the trigger attaches no policy: the message is public to whoever can publish', async () => {
    // the outcomes keep only the graph's own reasons: the gate's words are unreachable here, and T006 would say so
    const docs = gated({});
    delete (docs[TRIGGER] as any).policies;
    const dir = writtenOnce(docs);
    expect(checkTree(loadGated(dir, new FakeBroker())).items).toEqual([]);
    const at = await started(dir);
    try {
      for (const headers of [{}, { authorization: 'Bearer not-a-token' }]) {
        const { answers, traces } = await delivered(at, headers);
        expect(answers.map(one => one.outcome)).toEqual(['ack']);
        expect(steps(traces[0])).toEqual([`${REMOVE} → ok`]);
      }
    } finally {
      await at.served.stop();
    }
  }, 15_000);
});
