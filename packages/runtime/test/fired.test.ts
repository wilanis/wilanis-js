/**
 * What `Embedder.fire` leaves behind: a `Fired` saying everything the gate did -- the guard's identification,
 * timed and with its outcome, and every policy's decision, the ones that allowed as much as the one that did
 * not -- the operation's run, and what the fire answered. The gate is the part a report could never say: it
 * kept only the refusal, so a run nothing refused read exactly like a run nothing guarded.
 */
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { correlationOf, embedderFor, type Fired, type Ran, rehearse, Served } from '../src/index.js';
import { forgetGatedTrees, gatedTree } from './gated-tree.js';

afterEach(forgetGatedTrees);

/**
 * Fire the tree's one gated trigger and answer what it did, and everything the embedder handed the server.
 * The observers are the server's, so the test takes them there and never on the embedder: a reload builds a
 * fresh embedder and would drop anything left on the old one.
 */
async function fired(
  built: ReturnType<typeof gatedTree>,
  flags: Record<string, string>,
  clock?: () => number,
): Promise<{ report: unknown; heard: Ran[] }> {
  const load = loadTree(built.dir, built.plugins);
  expect(checkTree(load).items).toEqual([]);
  const emb = embedderFor(load, { clock });
  const heard: Ran[] = [];
  const served = new Served({ load, emb }, () => {});
  emb.serve(Object.assign(served, { ran: (what: Ran) => heard.push(what) }));
  const trigger = load.registry.get('trigger', '@features/gate/edge/greet.trigger.json');
  const report = await emb.fire(trigger?.doc as never, undefined, { flags, args: [], cwd: built.dir });
  return { report, heard };
}

describe('what one fire leaves behind', () => {
  it('keeps the decision that allowed as well as the one that denied, and times identify', async () => {
    let now = 100;
    // the guard names the caller, but without the role: the first policy allows and the second denies
    const built = gatedTree(() => ({ context: { principal: { subject: 'bo', role: 'reader' } } }));
    const { heard } = await fired(built, { token: 'a-token' }, () => (now += 5));

    expect(heard).toHaveLength(1);
    const one = heard[0] as Fired;
    expect(one.trigger).toBe('@features/gate/edge/greet.trigger.json');
    expect(one.kind).toBe('@cli/cli.trigger-kind.json');
    // both decisions are kept, and the gate says which allowed and which did not
    expect(one.decisions.map(each => [each.policy, each.report.status, each.effect])).toEqual([
      ['@features/gate/edge/signed-in.policy.json', 'done', undefined],
      ['@features/gate/edge/roled.policy.json', 'failed', 'deny'],
    ]);
    // identify is timed and says what it added to the context, which no report has ever carried
    expect(one.identify?.added).toEqual(['principal']);
    expect(one.identify?.refused).toBeUndefined();
    expect(one.identify?.endedAt).toBeGreaterThan(one.identify?.startedAt as number);
    // the gate ended the run, so there is no operation to report and the answer is the gate's own
    expect(one.run).toBeUndefined();
    expect(one.answer.graph).toBe('@features/gate/edge/roled.policy.json');
  });

  it('records the guard that refused, and the decisions that never happened as none', async () => {
    const built = gatedTree(() => ({
      refuse: { reason: 'invalid_credential', message: 'that token does not verify' },
    }));
    const { heard } = await fired(built, { token: 'a-bad-token' });

    const one = heard[0] as Fired;
    expect(one.identify?.refused).toBe('invalid_credential');
    expect(one.identify?.added).toEqual([]);
    // the guard ended it before any policy ran, so nothing decided and nothing ran
    expect(one.decisions).toEqual([]);
    expect(one.run).toBeUndefined();
  });

  it('keeps the operation beside every decision when the gate let the run through', async () => {
    const built = gatedTree(() => ({ context: { principal: { subject: 'bo', role: 'registrar' } } }));
    const { report, heard } = await fired(built, { token: 'a-token' });

    const one = heard[0] as Fired;
    expect(one.decisions.map(each => each.report.status)).toEqual(['done', 'done']);
    expect(one.run?.status).toBe('done');
    // what fire answered is the run's own report, and the record says so rather than keeping a second copy
    expect(one.answer).toBe(report);
    expect(one.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(one.endedAt).toBeGreaterThanOrEqual(one.startedAt);
  });

  it('carries no correlation from a kind that declares none, and reads the one a kind does declare', async () => {
    const built = gatedTree(() => ({ context: { principal: { subject: 'bo', role: 'registrar' } } }));
    const { heard } = await fired(built, { token: 'a-token' });
    // a command line has no caller trace, so its kind declares no correlation and a fire of it carries none
    expect((heard[0] as Fired).correlation).toBeUndefined();

    // what the http kind declares -- "headers.traceparent" -- read off a context the way a fire reads it
    const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(correlationOf({ headers: { traceparent: parent } }, 'headers.traceparent')).toBe(parent);
    // a path the context does not hand, and an empty value, correlate nothing rather than an empty string
    expect(correlationOf({ headers: {} }, 'headers.traceparent')).toBeUndefined();
    expect(correlationOf({ headers: { traceparent: '' } }, 'headers.traceparent')).toBeUndefined();
  });

  it('a stubbed run records nothing: the gate never runs, and nobody registered with it', async () => {
    const built = gatedTree(() => {
      throw new Error('a rehearsal must never reach the guard');
    });
    const load = loadTree(built.dir, built.plugins);
    const heard: Ran[] = [];
    const emb = embedderFor(load, { seed: 7 });
    emb.serve(Object.assign(new Served({ load, emb }, () => {}), { ran: (what: Ran) => heard.push(what) }));

    // a rehearsal builds a stubbed embedder of its own, which nothing is serving: the gate is skipped whole
    // and no observer is registered, so a run that never left the process leaves no record either
    await rehearse(load, { seed: 7 });
    expect(heard).toEqual([]);
  });
});
