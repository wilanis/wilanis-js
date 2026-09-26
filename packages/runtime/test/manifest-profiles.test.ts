/**
 * RFC 0026's manifest, step 2: the profile blocks `manifestOf` answers beside the inventory, each what RFC 0013's
 * `reachOf` derives under one profile, and `--profile`, which narrows them to one. The inventory, its determinism
 * and the command's other cases are in manifest.test.ts; this file holds the per-profile half, the `--profile
 * staging` case among it, since manifest.test.ts is at the house rules' length.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree } from '@wilanis/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProject, type Manifest, manifestOf, type ProjectLoad } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const RUNTIME = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const valid = new Ajv2020({ allErrors: true }).compile(read(join(RUNTIME, 'schemas/manifest.schema.json')));
const STAGING =
  "no profile 'staging'; project.json declares: live (default), local, production, production-scheduler, production-worker";

const WATCH = '@reload/watch.port.json#watch';
const REQUEST = '@http/http.port.json#request';
const VERIFY = '@auth/identity.port.json#verify';
const TEST_API = '@connections/customers-api.connection.json';
const EMPLOYEES = '@connections/employees.connection.json';
const STAND_IN = '@connections/employees-production.connection.json';
const POSTGRES = '@connections/customers-postgres.connection.json';

let example: ProjectLoad;
let manifest: Manifest;
beforeAll(async () => {
  example = await loadProject(EXAMPLE);
  manifest = manifestOf(example, { root: 'example' });
});

/** One profile's block of the example's manifest, failing the test where the example lost the profile. */
function block(name: string) {
  const found = manifest.profiles[name];
  if (!found) throw new Error(`the example no longer declares the profile '${name}'`);
  return found;
}
const via = (name: string, operation: string) => block(name).reaches.find(one => one.operation === operation)?.via;
const everyVia = (name: string) => block(name).reaches.flatMap(one => one.via);

describe('manifestOf: one block per profile', () => {
  it('holds every profile project.json declares, by name, and never an empty key', () => {
    expect(Object.keys(manifest.profiles)).toEqual(Object.keys(example.registry.project?.doc.profiles ?? {}).sort());
    expect(manifest.profiles['']).toBeUndefined();
  });

  it('under live, reaches watch and the test API, marks live the default, and holds what the laptop holds', () => {
    const live = block('live');
    expect(live.default).toBe(true);
    expect(live.description).toEqual(example.registry.project?.doc.profiles?.live.description);
    expect(via('live', WATCH)).toEqual([]);
    expect(via('live', REQUEST)).toEqual([TEST_API]);
    expect(live.holds).toContain(WATCH);
    expect(live.holds).toContain('@http/server.port.json#listen');
    expect(live.connections).toEqual({});
    expect(live.bindings['@features/customers/domain/customer.port.json']).toBe(
      '@features/customers/data/customers-rest.binding.json',
    );
  });

  it('under production, holds no watch, reaches the stand-in in place of what it stands in for, and not the test API', () => {
    const production = block('production');
    expect(production.default).toBe(false);
    expect(production.reaches.map(one => one.operation)).not.toContain(WATCH);
    expect(production.holds).not.toContain(WATCH);
    expect(via('production', VERIFY)).toContain(STAND_IN);
    expect(everyVia('production')).not.toContain(EMPLOYEES);
    expect(everyVia('production')).not.toContain(TEST_API);
    expect(everyVia('production')).toContain(POSTGRES);
    // the profile's maps as written, canonical on both sides: the alias @customers is never printed
    expect(production.connections).toEqual({
      [EMPLOYEES]: STAND_IN,
      '@connections/jobs.connection.json': POSTGRES,
    });
    expect(production.bindings['@features/customers/domain/customer.port.json']).toBe(
      '@features/customers/data/customers-postgres.binding.json',
    );
  });

  it('under production, needs the database and the signing key by variable, and names who reads each', () => {
    const needs = block('production').needs;
    expect(needs.map(one => one.variable)).toEqual(
      expect.arrayContaining(['CUSTOMERS_DATABASE_URL', 'CUSTOMERS_JWT_SECRET']),
    );
    expect(needs.find(one => one.variable === 'CUSTOMERS_JWT_SECRET')).toEqual({
      variable: 'CUSTOMERS_JWT_SECRET',
      key: 'jwt',
      readBy: ['@auth settings'],
    });
    expect(needs.find(one => one.key === 'customersDatabase')?.readBy).toEqual([POSTGRES]);
    expect(block('live').needs.map(one => one.variable)).not.toContain('CUSTOMERS_DATABASE_URL');
  });

  it('starts the labels of the steps that run under each profile, in the order declared', () => {
    const declared = example.registry.project?.doc.startup ?? [];
    const under = (name: string) =>
      declared.filter(step => !step.profiles || step.profiles.includes(name)).map(step => step.label);
    expect(block('production').starts).toEqual(under('production'));
    expect(block('production').starts).not.toContain('Watch for changes');
    expect(block('production').starts.at(-1)).toBe('Listen');
    expect(block('production-worker').starts).not.toContain('Listen');
    expect(block('live').starts).toContain('Watch for changes');
  });

  it('writes the unnamed profile of a tree that declares none under "", as the default', () => {
    const access = manifestOf(loadTree(INCLUDES[0].dir, PLUGINS), { root: 'access' });
    expect(Object.keys(access.profiles)).toEqual(['']);
    expect(access.profiles['']).toMatchObject({ default: true, description: null, bindings: {}, connections: {} });
    expect(access.profiles[''].starts).toEqual(['Listen']);
    expect(valid(access)).toBe(true);
  });
});

describe('manifestOf: --profile', () => {
  it('narrows the blocks to the one named, the inventory unchanged', () => {
    const narrowed = manifestOf(example, { root: 'example', profile: 'production' });
    expect(Object.keys(narrowed.profiles)).toEqual(['production']);
    expect(narrowed.profiles.production).toEqual(block('production'));
    expect({ ...narrowed, profiles: {} }).toEqual({ ...manifest, profiles: {} });
    expect(valid(narrowed)).toBe(true);
  });

  it('refuses a name no profile has with RFC 0013’s message', () => {
    expect(() => manifestOf(example, { root: 'example', profile: 'staging' })).toThrow(STAGING);
  });
});

describe('manifest.schema.json: the profile block', () => {
  it('refuses a key it does not name, on a block and on a reach row', () => {
    const production = block('production');
    expect(
      valid({ ...manifest, profiles: { ...manifest.profiles, production: { ...production, permits: null } } }),
    ).toBe(false);
    const [first, ...rest] = production.reaches;
    const widened = { ...production, reaches: [{ ...first, raw: true }, ...rest] };
    expect(valid({ ...manifest, profiles: { ...manifest.profiles, production: widened } })).toBe(false);
  });
});

describe('wilanis manifest --profile', () => {
  it('exits 1 with RFC 0013’s message where no profile has the name, and prints no JSON', { timeout: 60_000 }, () => {
    const ran = spawnSync(
      process.execPath,
      [join(RUNTIME, 'bin/wilanis.js'), 'manifest', 'example', '--profile', 'staging'],
      { cwd: join(EXAMPLE, '..'), encoding: 'utf8' },
    );
    expect(ran.status).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr.trim()).toBe(STAGING);
  });
});
