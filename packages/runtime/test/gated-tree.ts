/**
 * A tree with one gated trigger and two policies, built in a temporary directory: the fake guard that names a
 * caller, the decision graphs the policies fire, and the one effect the trigger runs. Everything happens in
 * process -- no directory, no token, no network -- so a case about what the gate did can be written without a
 * real identity provider, and both the record the embedder keeps and the trace `traceOf` says of it are read
 * from the same tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import { BUILTIN_PLUGINS } from '../src/index.js';
import { docsDir } from './example-harness.js';

/** The directories `gatedTree` has written, so a suite can remove every one it made when its case is over. */
const dirs: string[] = [];

/** Remove every tree `gatedTree` wrote: what a suite hands `afterEach`, so nothing it built outlives its case. */
export function forgetGatedTrees(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** What the fake guard answers on one fire: the context it establishes, or the reason it refuses. */
export type Identifies = { context: Record<string, unknown> } | { refuse: { reason: string; message: string } };

/** The fake plugin: the one effect the trigger fires, and the guard that names the caller. */
export function fakePlugin(identifies: () => Identifies): PluginModule {
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
export function gatedTree(identifies: () => Identifies) {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-gated-'));
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
