/**
 * What the gate says as spans: the guard's identification, and every policy's decision -- the ones that allowed
 * as much as the one that did not. This is the part of a fire a report could never say, so it is the part a
 * trace is most worth having, and it is judged on its own tree rather than the example's: the tree is the one
 * `fired.test.ts` builds, with a fake guard and two policies deciding through real graphs, so nothing here
 * needs a directory, a token or a network to exercise a real gate.
 */
import { loadTree, type Trace } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { embedderFor, type Ran, Served, traceOf } from '../src/index.js';
import { forgetGatedTrees, gatedTree, type Identifies } from './gated-tree.js';

/** Every span of a trace, depth first, so a case can say which ones a run left and in what order. */
function spansOf(trace: Trace): Trace[] {
  return [trace, ...trace.children.flatMap(spansOf)];
}

/** The one span with this name, or nothing: what a case reaches for when the claim is about one of them. */
const spanNamed = (trace: Trace, name: string): Trace | undefined =>
  spansOf(trace).find(one => one.name === name || one.name.startsWith(`${name} `));

/**
 * Fire the gated tree's one trigger and say what it did as spans. The tree is the one `fired.test.ts` builds:
 * a fake guard that names a caller and two policies that decide through real graphs, so the gate a trace shows
 * is a gate that really ran -- and nothing here needs a directory, a token or a network to get one.
 */
async function gated(identifies: Identifies): Promise<Trace> {
  const built = gatedTree(() => identifies);
  const load = loadTree(built.dir, built.plugins);
  const emb = embedderFor(load);
  const heard: Ran[] = [];
  const served = new Served({ load, emb }, () => {});
  emb.serve(Object.assign(served, { ran: (what: Ran) => heard.push(what) }));
  const trigger = load.registry.get('trigger', '@features/gate/edge/greet.trigger.json');
  await emb.fire(trigger?.doc as never, undefined, { flags: { token: 'a-token' }, args: [], cwd: built.dir });
  return traceOf(heard[0], emb.scope, { level: 'full' });
}

describe('the gate, said as spans', () => {
  afterEach(forgetGatedTrees);

  it('shows identify and every policy the trigger attaches, the one that allowed included', async () => {
    // named, but without the role: the first policy allows and the second denies
    const trace = await gated({ context: { principal: { subject: 'bo', role: 'reader' } } });

    expect(spansOf(trace).map(one => one.name)).toEqual([
      'fire @features/gate/edge/greet.trigger.json',
      'identify (@fake)',
      'policy @features/gate/edge/signed-in.policy.json',
      '@features/gate/domain/signed-in.graph.json',
      'decide switch → granted',
      'granted @std/object.port.json#make',
      'denied',
      'policy @features/gate/edge/roled.policy.json',
      '@features/gate/domain/roled.graph.json',
      'decide switch → denied',
      'granted',
      'denied @std/outcome.port.json#refuse',
    ]);
  });

  it('says what each policy decided, and what the policy made of the refusal', async () => {
    const trace = await gated({ context: { principal: { subject: 'bo', role: 'reader' } } });
    const [allowed, refused] = spansOf(trace).filter(one => one.name.startsWith('policy '));

    expect(allowed.status).toBe('allowed');
    expect(allowed.attributes['wilanis.policy.outcome']).toBe('allowed');
    // the policy's outcomes table turns the reason the graph refused with into a denial, and the span says so
    expect(refused.status).toBe('denied: forbidden');
    expect(refused.attributes['wilanis.policy.outcome']).toBe('denied');
    expect(refused.attributes['wilanis.policy']).toBe('@features/gate/edge/roled.policy.json');
  });

  it('times identify and says whether the guard named anyone', async () => {
    const named = spanNamed(await gated({ context: { principal: { subject: 'bo', role: 'reader' } } }), 'identify');

    expect(named?.status).toBe('ok');
    expect(named?.attributes['wilanis.principal']).toBe('yes');
    // this guard hands no session, so the span says as much rather than leaving a reader to guess
    expect(named?.attributes['wilanis.session']).toBe('no');
    expect(named?.endedAt).toBeGreaterThanOrEqual(named?.startedAt as number);
  });

  it('says the reason the guard refused with, and shows no policy after it: the run ended there', async () => {
    const trace = await gated({ refuse: { reason: 'invalid_credential', message: 'that token does not verify' } });

    expect(spanNamed(trace, 'identify')?.status).toBe('refused: invalid_credential');
    expect(spanNamed(trace, 'identify')?.attributes['wilanis.principal']).toBe('no');
    expect(spansOf(trace).filter(one => one.name.startsWith('policy '))).toEqual([]);
    // no operation either: what the fire answered is the gate's own report
    expect(trace.children).toHaveLength(1);
  });

  it('runs the operation under the gate when every policy allowed', async () => {
    const trace = await gated({ context: { principal: { subject: 'bo', role: 'registrar' } } });
    const names = spansOf(trace).map(one => one.name);

    expect(trace.status).toBe('ok');
    expect(names.filter(name => name.startsWith('policy '))).toHaveLength(2);
    // the gate let it through, so the operation an author named is there, beneath the decisions
    expect(names).toContain('@features/gate/domain/gate.port.json#greet');
    expect(names).toContain('binding @features/gate/data/gate.binding.json#greet');
  });
});
