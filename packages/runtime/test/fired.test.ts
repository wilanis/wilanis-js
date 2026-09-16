/**
 * What `Embedder.fire` leaves behind: a `Fired` saying everything the gate did -- the guard's identification,
 * timed and with its outcome, and every policy's decision, the ones that allowed as much as the one that did
 * not -- the operation's run, and what the fire answered. The gate is the part a report could never say: it
 * kept only the refusal, so a run nothing refused read exactly like a run nothing guarded.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, correlationOf, embedderFor, type Fired, type Ran, rehearse, Served } from '../src/index.js';
import { docsDir } from './example-harness.js';

/** What the fake guard answers on one fire: the context it establishes, or the reason it refuses. */
type Identifies = { context: Record<string, unknown> } | { refuse: { reason: string; message: string } };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The fake plugin: the one effect the trigger fires, and the guard that names the caller. */
function fakePlugin(identifies: () => Identifies): PluginModule {
  return {
    root: '@fake',
    docs: docsDir({
      'plugin.json': {
        $schema: schemaRef('plugin'),
        description: 'the greeting behind the port, and the guard that names the caller',
        grants: { ports: ['@fake/greet.port.json'] },
        guard: {
          credentials: {
            token: { type: 'string', yields: ['principal'], description: 'whatever the caller presented' },
          },
          context: {
            fields: {
              principal: {
                type: { fields: { subject: { type: 'string' }, role: { type: 'string' } } },
                required: false,
                description: 'who the guard says is calling',
              },
            },
          },
          refuses: { invalid_credential: 'a credential was given and did not verify' },
        },
      },
      'greet.port.json': {
        $schema: schemaRef('port'),
        description: 'what the trigger fires',
        operations: { say: { description: 'the greeting itself', returns: 'string' } },
      },
    }),
    handlers: { '@fake/greet.port.json#say': async () => 'hello' },
    guard: { identify: async () => identifies(), challenge: async () => ({ message: '', detail: {} }) },
  };
}

/** A decision graph: allow whoever passes the rule, refuse everyone else with the one declared reason. */
const decisionGraph = (label: string, when: string, reason: string, message: string) => ({
  $schema: schemaRef('graph'),
  label,
  description: `${label}: the branch that allows, and the branch that refuses as ${reason}.`,
  in: '@features/gate/domain/Caller.shape.json',
  out: { type: '@features/gate/domain/Grant.shape.json', from: ['granted', 'denied'] },
  nodes: [
    {
      type: '@wilanis/node/switch.schema.json',
      id: 'decide',
      label: 'Who is it?',
      in: { principal: '{{in.principal}}' },
      rules: [{ when, to: 'granted' }],
      else: 'denied',
    },
    {
      type: '@wilanis/node/run.schema.json',
      id: 'granted',
      label: 'Allowed',
      run: '@std/object.port.json#make',
      in: { value: { allowed: true }, type: '@features/gate/domain/Grant.shape.json' },
    },
    {
      type: '@wilanis/node/run.schema.json',
      id: 'denied',
      label: 'Denied',
      run: '@std/outcome.port.json#refuse',
      in: { reason, message, type: '@features/gate/domain/Grant.shape.json' },
    },
  ],
});

/**
 * A tree with one gated cli trigger and two policies: the first allows whoever the guard named, the second
 * only a caller the guard gave the role. Both decide through a domain graph that switches and refuses, the
 * way the access tree's policies do, so the gate is exercised exactly as a real one is -- and everything
 * runs in process, with no directory and no token anywhere.
 */
function gatedTree(identifies: () => Identifies) {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-fired-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'features/gate/edge'), { recursive: true });
  mkdirSync(join(dir, 'features/gate/domain'), { recursive: true });
  mkdirSync(join(dir, 'features/gate/data'), { recursive: true });
  const put = (rel: string, doc: unknown) => writeFileSync(join(dir, rel), JSON.stringify(doc));

  put('project.json', {
    $schema: schemaUrl('project'),
    name: 'gate',
    description: 'one gated trigger, two policies',
    plugins: [{ use: '@std' }, { use: '@cli' }, { use: '@fake' }],
  });
  put('features/gate/feature.json', {
    $schema: schemaRef('feature'),
    description: 'the gated feature',
    effects: ['@fake/greet.port.json#say'],
  });
  put('features/gate/domain/Who.shape.json', {
    $schema: schemaRef('shape'),
    label: 'Who',
    description: 'who the guard says is calling',
    layer: 'core',
    fields: { subject: { type: 'string' }, role: { type: 'string' } },
  });
  put('features/gate/domain/Grant.shape.json', {
    $schema: schemaRef('shape'),
    label: 'Grant',
    description: 'a decision that allowed',
    layer: 'core',
    fields: { allowed: { type: 'boolean' } },
  });
  put('features/gate/domain/Caller.shape.json', {
    $schema: schemaRef('shape'),
    label: 'Caller',
    description: 'what a decision reads: the principal, absent for an anonymous caller',
    layer: 'core',
    fields: { principal: { type: '@features/gate/domain/Who.shape.json', required: false } },
  });
  put('features/gate/domain/gate.port.json', {
    $schema: schemaRef('port'),
    description: 'what the trigger and the policies fire',
    operations: {
      signedIn: {
        description: 'allow a caller the guard named; refuses as anonymous',
        accepts: { principal: { type: '@features/gate/domain/Who.shape.json', required: false } },
        returns: '@features/gate/domain/Grant.shape.json',
      },
      roled: {
        description: 'allow a caller holding the role; refuses as forbidden',
        accepts: { principal: { type: '@features/gate/domain/Who.shape.json', required: false } },
        returns: '@features/gate/domain/Grant.shape.json',
      },
      greet: { description: 'the greeting itself', returns: 'string' },
    },
  });
  put(
    'features/gate/domain/signed-in.graph.json',
    decisionGraph('Require a caller', 'has(principal)', 'anonymous', 'nobody is calling'),
  );
  put(
    'features/gate/domain/roled.graph.json',
    decisionGraph(
      'Require the role',
      "has(principal) && principal.role == 'recorder'",
      'forbidden',
      'the role is required',
    ),
  );
  put('features/gate/data/gate.binding.json', {
    $schema: schemaRef('binding'),
    description: 'the decisions by graph, the greeting by the fake plugin',
    port: '@features/gate/domain/gate.port.json',
    operations: {
      signedIn: { graph: '@features/gate/domain/signed-in.graph.json' },
      roled: { graph: '@features/gate/domain/roled.graph.json' },
      greet: { run: '@fake/greet.port.json#say' },
    },
  });
  put('features/gate/edge/signed-in.policy.json', {
    $schema: schemaRef('policy'),
    description: 'a caller the guard named',
    decide: { run: '@features/gate/domain/gate.port.json#signedIn', in: { principal: '{{request.principal}}' } },
    proves: ['request.principal'],
    outcomes: { anonymous: { effect: 'deny' } },
  });
  put('features/gate/edge/roled.policy.json', {
    $schema: schemaRef('policy'),
    description: 'a caller holding the role',
    decide: { run: '@features/gate/domain/gate.port.json#roled', in: { principal: '{{request.principal}}' } },
    outcomes: { forbidden: { effect: 'deny' } },
  });
  put('features/gate/edge/greet.trigger.json', {
    $schema: schemaRef('trigger'),
    label: 'greet',
    description: 'the one gated trigger',
    settings: { command: 'greet' },
    out: 'string',
    policies: [
      { policy: '@features/gate/edge/signed-in.policy.json', in: { token: '{{request.flags.token}}' } },
      '@features/gate/edge/roled.policy.json',
    ],
    kind: '@cli/cli.trigger-kind.json',
    fire: { run: '@features/gate/domain/gate.port.json#greet' },
  });
  return { dir, plugins: { ...BUILTIN_PLUGINS, '@fake': fakePlugin(identifies) } };
}

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
    const built = gatedTree(() => ({ context: { principal: { subject: 'bo', role: 'recorder' } } }));
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
    const built = gatedTree(() => ({ context: { principal: { subject: 'bo', role: 'recorder' } } }));
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
