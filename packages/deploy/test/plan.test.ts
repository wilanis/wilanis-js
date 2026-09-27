/**
 * RFC 0024's plan, step 3: `planOf` over a committed manifest of the example, so the package is tested without
 * loading a tree -- the golden plan, the same bytes however the manifest's arrays are ordered, more than one profile,
 * the two refusals, and no variable's value anywhere in the answer.
 *
 * The fixture is what `wilanis manifest example` prints, never written by hand. When the example changes,
 * regenerate it from the repository's root with
 *   npx wilanis manifest example > packages/deploy/test/fixtures/customers.manifest.json
 * and read the diff: it is a diff of what the tree is, and the golden below moves only where a plan does.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@wilanis/runtime';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import { type Plan, planOf, planText } from '../src/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const FIXTURE: Manifest = read(join(HERE, 'fixtures/customers.manifest.json'));
const RUNTIME = dirname(dirname(createRequire(import.meta.url).resolve('@wilanis/runtime')));
const manifestValid = new Ajv2020({ allErrors: true }).compile(read(join(RUNTIME, 'schemas/manifest.schema.json')));
const planValid = new Ajv2020({ allErrors: true }).compile(read(join(HERE, '../schemas/plan.schema.json')));

const IMAGE = 'customers:0.1.0';
const LISTEN = '@http/server.port.json#listen';
const plan = (manifest: Manifest, ...profiles: string[]): Plan => planOf(manifest, { profiles, image: IMAGE });
/** A copy of the fixture to change, so no case sees another's edit. */
const fixture = (): Manifest => structuredClone(FIXTURE);

/** The same value with every array, at every depth, in the reverse order, and every object's keys reversed. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed).reverse();
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, inner]) => [key, reversed(inner)]),
  );
}

describe('the fixture', () => {
  it('is a manifest, as the runtime’s published schema reads one', () => {
    expect(manifestValid(FIXTURE) ? [] : manifestValid.errors).toEqual([]);
  });
});

describe('planOf: the golden plan of the example', () => {
  const production = plan(FIXTURE, 'production');

  it('is the Guide’s plan for production, field for field', () => {
    expect(production).toEqual({
      format: 1,
      name: 'customers',
      node: null,
      image: { context: '.', dockerfile: 'deploy/Dockerfile', reference: 'customers:0.1.0' },
      workloads: [
        {
          profile: 'production',
          description: FIXTURE.profiles.production.description,
          command: ['wilanis', 'start', '.', '--profile', 'production'],
          listens: [{ operation: LISTEN, host: null, port: 8099 }],
          holds: [LISTEN, '@otel/exporter.port.json#export'],
          needs: [
            {
              variable: 'CUSTOMERS_DATABASE_URL',
              key: 'customersDatabase',
              readBy: ['@connections/customers-postgres.connection.json'],
            },
            { variable: 'CUSTOMERS_JWT_SECRET', key: 'jwt', readBy: ['@auth settings'] },
            {
              variable: 'CUSTOMERS_OPERATOR_PASSWORD_HASH',
              key: 'operatorPasswordHash',
              readBy: ['@connections/employees-production.connection.json'],
            },
          ],
          replicas: 1,
          probe: { tcp: 8099 },
        },
      ],
      requires: [],
    });
  });

  it('prints its keys in the Guide’s order, the envelope’s and a workload’s', () => {
    expect(Object.keys(production)).toEqual(['format', 'name', 'node', 'image', 'workloads', 'requires']);
    expect(Object.keys(production.workloads[0])).toEqual([
      'profile',
      'description',
      'command',
      'listens',
      'holds',
      'needs',
      'replicas',
      'probe',
    ]);
  });

  it('validates against the published schema, which refuses a key it does not name', () => {
    expect(planValid(production) ? [] : planValid.errors).toEqual([]);
    expect(planValid({ ...production, runtime: '0.1.0' })).toBe(false);
    const [workload] = production.workloads;
    expect(planValid({ ...production, workloads: [{ ...workload, replicas: 2 }] })).toBe(false);
    const unfixed = { ...workload, listens: [{ operation: LISTEN, host: null, port: null }] };
    expect(planValid({ ...production, workloads: [unfixed] })).toBe(false);
  });

  it('probes nothing for a profile that holds open but listens on nothing', () => {
    const [worker] = plan(FIXTURE, 'production-worker').workloads;
    expect(worker.listens).toEqual([]);
    expect(worker.holds).toEqual(['@otel/exporter.port.json#export', '@queue/worker.port.json#consume']);
    expect(worker.probe).toBeNull();
  });

  it('starts the unnamed profile of a tree that declares none without naming one', () => {
    const unnamed = fixture();
    unnamed.profiles = { '': unnamed.profiles.production };
    const [workload] = plan(unnamed, '').workloads;
    expect(workload.profile).toBe('');
    expect(workload.command).toEqual(['wilanis', 'start', '.']);
  });
});

describe('planOf: the same bytes however it was asked', () => {
  it('answers equal strings for two calls, for profiles asked in either order, and for a reversed manifest', () => {
    const once = planText(plan(FIXTURE, 'live', 'production', 'production-worker'));
    expect(planText(plan(FIXTURE, 'live', 'production', 'production-worker'))).toBe(once);
    expect(planText(plan(FIXTURE, 'production-worker', 'production', 'live'))).toBe(once);
    expect(planText(plan(reversed(FIXTURE) as Manifest, 'live', 'production', 'production-worker'))).toBe(once);
  });

  it('plans a profile asked for twice once', () => {
    expect(plan(FIXTURE, 'live', 'live').workloads.map(one => one.profile)).toEqual(['live']);
  });
});

describe('planOf: more than one profile', () => {
  it('answers one workload per profile, by name, and requires what any of them reaches', () => {
    const both = plan(FIXTURE, 'production', 'live');
    expect(both.workloads.map(one => one.profile)).toEqual(['live', 'production']);
    expect(both.requires).toEqual([
      {
        connection: '@connections/customers-api.connection.json',
        kind: '@http/http.connection-kind.json',
        endpoint: 'https://6aa009e23e0d88d3d7e5525d.mockapi.io/api/v1',
        reachedBy: ['live'],
      },
    ]);
    expect(planValid(both) ? [] : planValid.errors).toEqual([]);
  });

  it('carries every profile that reaches a required connection in its reachedBy, by name', () => {
    // live and production both reach the people directory; give its kind an endpoint and it is required of both
    const dialled = fixture();
    const people = dialled.connections.find(one => one.path === '@connections/people.connection.json');
    if (!people) throw new Error('the fixture has no people directory');
    people.endpoint = 'ldaps://people.internal';
    const requires = plan(dialled, 'production', 'live').requires;
    expect(requires.map(one => one.connection)).toEqual([
      '@connections/customers-api.connection.json',
      '@connections/people.connection.json',
    ]);
    expect(requires[1]).toEqual({
      connection: '@connections/people.connection.json',
      kind: '@auth/directory.connection-kind.json',
      endpoint: 'ldaps://people.internal',
      reachedBy: ['live', 'production'],
    });
  });
});

describe('planOf: what it refuses', () => {
  it('refuses a profile that holds nothing, naming it, in the words start refuses a variable in', () => {
    const idle = fixture();
    idle.profiles['production-worker'].holds = [];
    expect(() => plan(idle, 'production-worker')).toThrow(
      new Error(
        "profile 'production-worker' holds nothing: every startup step it runs answers and ends\n" +
          '→ a deployed profile keeps something running; deploy a profile whose startup opens a listener, a ' +
          'consumer or a scheduler, and run a one-shot profile with wilanis start',
      ),
    );
  });

  it('refuses an address whose port the tree does not fix, naming the operation and both places to write one', () => {
    const unfixed = fixture();
    unfixed.profiles.production.listens = [{ operation: LISTEN, host: null, port: null }];
    expect(() => plan(unfixed, 'production')).toThrow(
      new Error(
        `'${LISTEN}' listens on a port this tree does not fix under profile 'production': neither the 'Listen' ` +
          'step\'s "in" nor the @http plugin\'s settings give it as a number\n' +
          "→ write the port as a number in the 'Listen' step's \"in\", or in the @http plugin's settings; wilanis " +
          'describe @http/server.port.json names the key each is read from',
      ),
    );
  });

  it('says every refusal at once, a profile’s before the next, and plans nothing', () => {
    const broken = fixture();
    broken.profiles['production-worker'].holds = [];
    broken.profiles.production.listens = [{ operation: LISTEN, host: null, port: null }];
    broken.profiles[''] = { ...broken.profiles['production-worker'] };
    const refused = (() => {
      try {
        plan(broken, 'production-worker', 'production', 'live', '');
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    const heads = refused.split('\n\n').map(one => one.split('\n')[0]);
    expect(heads).toEqual([
      'the unnamed profile holds nothing: every startup step it runs answers and ends',
      `'${LISTEN}' listens on a port this tree does not fix under profile 'production': neither the 'Listen' step's "in" nor the @http plugin's settings give it as a number`,
      "profile 'production-worker' holds nothing: every startup step it runs answers and ends",
    ]);
  });

  it('refuses a profile the manifest holds no block for, naming those it holds', () => {
    expect(() => plan(FIXTURE, 'staging')).toThrow(
      "the manifest holds no profile 'staging'; it holds live, local, production, production-scheduler, " +
        'production-worker',
    );
  });
});

describe('planOf: no value of the environment', () => {
  const set: string[] = [];
  afterEach(() => {
    for (const variable of set.splice(0)) delete process.env[variable];
  });

  it('names every variable a profile needs and prints no value set for one', () => {
    const variables = [
      ...new Set(Object.values(FIXTURE.profiles).flatMap(block => block.needs.map(need => need.variable))),
    ];
    for (const [at, variable] of variables.entries()) {
      process.env[variable] = `value-that-must-never-be-printed-${at}`;
      set.push(variable);
    }
    const text = planText(plan(FIXTURE, ...Object.keys(FIXTURE.profiles)));
    for (const variable of variables) expect(text).toContain(`"variable": "${variable}"`);
    expect(text).not.toContain('value-that-must-never-be-printed');
  });
});
