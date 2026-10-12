/**
 * RFC 0026's manifest, steps 2 and 3: the profile blocks `manifestOf` answers beside the inventory, each what RFC
 * 0013's `reachOf` derives under one profile and what RFC 0016 has it permit, and `--profile`, which narrows them to
 * one. The inventory, its determinism and the command's other cases are in manifest.test.ts; this file holds the
 * per-profile half, the `--profile staging` case among it, since manifest.test.ts is at the house rules' length. A
 * block is of the profile resolved (RFC 0043): a planted child holds what it writes over what it extends.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LoadResult, loadTree, type Registry, schemaUrl } from '@wilanis/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProject, type Manifest, manifestOf, type ProjectLoad } from '../src/index.js';
import { codes, copyOfExample, EXAMPLE, INCLUDES, loadedEditingAll, PLUGINS } from './example-harness.js';

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

/** The same load with its registry's documents in the reverse order, as another walk of the disk might find them. */
function reversed(load: LoadResult): LoadResult {
  const registry = Object.assign(Object.create(Object.getPrototypeOf(load.registry)), load.registry, {
    files: [...load.registry.files].reverse(),
  }) as Registry;
  return { ...load, registry };
}

/** Make a copy's operator password hash read the database's variable: two secret keys, one variable. */
function shareOneVariable(dir: string): void {
  const path = join(dir, 'project.json');
  const project = read(path);
  project.secrets.operatorPasswordHash = project.secrets.customersDatabase;
  writeFileSync(path, JSON.stringify(project, null, 2));
}

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

  it('orders two keys that read one variable by key, whichever order the registry was walked in', () => {
    const dir = copyOfExample();
    try {
      shareOneVariable(dir);
      expect(codes(dir)).toEqual([]);
      const loaded = loadTree(dir, PLUGINS, INCLUDES);
      const needs = (load: LoadResult) =>
        manifestOf(load, { root: 'example', profile: 'production' }).profiles.production.needs;
      const shared = needs(loaded).filter(one => one.variable === 'CUSTOMERS_DATABASE_URL');
      expect(shared.map(one => one.key)).toEqual(['customersDatabase', 'operatorPasswordHash']);
      expect(needs(reversed(loaded))).toEqual(needs(loaded));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(access.profiles['']).toMatchObject({
      default: true,
      description: null,
      bindings: {},
      connections: {},
      permits: null,
    });
    expect(access.profiles[''].starts).toEqual(['Listen']);
    expect(valid(access)).toBe(true);
  });
});

describe('manifestOf: permits, what a profile permits', () => {
  it('is null under live, and under every profile that writes none, which permits everything', () => {
    expect(block('live').permits).toBeNull();
    for (const [name, profile] of Object.entries(example.registry.project?.doc.profiles ?? {}))
      if (profile.permits === undefined) expect(block(name).permits).toBeNull();
  });

  it('under production, is the list project.json writes, in code-unit order whatever order it is written in', () => {
    const written: string[] = read(join(EXAMPLE, 'project.json')).profiles.production.permits;
    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toEqual([...written].sort());
    expect(block('production').permits).toEqual([...written].sort());
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
    // RFC 0026 set `scheduled` aside: a scheduled job is a trigger of RFC 0010's kind
    expect(
      valid({ ...manifest, profiles: { ...manifest.profiles, production: { ...production, scheduled: [] } } }),
    ).toBe(false);
    const [first, ...rest] = production.reaches;
    const widened = { ...production, reaches: [{ ...first, raw: true }, ...rest] };
    expect(valid({ ...manifest, profiles: { ...manifest.profiles, production: widened } })).toBe(false);
  });

  it('requires permits on every block: a list of paths, or null', () => {
    const production = block('production');
    const permitting = (permits: unknown) => ({
      ...manifest,
      profiles: { ...manifest.profiles, production: { ...production, permits } },
    });
    expect(valid(permitting(production.permits))).toBe(true);
    expect(valid(permitting(null))).toBe(true);
    expect(valid(permitting([42]))).toBe(false);
    expect(valid(permitting('@http/server.port.json#listen'))).toBe(false);
    const { permits: _, ...unsaid } = production;
    expect(valid({ ...manifest, profiles: { ...manifest.profiles, production: unsaid } })).toBe(false);
  });
});

const JOBS = '@connections/jobs.connection.json';
const JOBS_STAGING = '@connections/jobs-staging.connection.json';
/** What production-worker permits, as the example writes it: its own list, since it reaches less than production. */
const WORKER_PERMITS = [
  '@storage/store.port.json',
  '@storage/storage.port.json#ensure',
  '@queue/queue.port.json#ensure',
  '@queue/worker.port.json#consume',
  '@auth/challenge.port.json#issue',
  '@otel/exporter.port.json#export',
  POSTGRES,
];

/** A broker of the jobs' kind, for a staging place to stand in for the jobs connection. */
const BROKER = {
  'connections/jobs-staging.connection.json': {
    $schema: schemaUrl('connection'),
    description: 'The broker a staging place works its queue on, in its own process.',
    kind: '@queue-memory/memory.connection-kind.json',
    settings: {},
  },
};

/**
 * One profile's block of the manifest of a copy of the example, edited, and the copy removed after. The copy is
 * held to the codes `refused` lists, none by default: the manifest is of a tree the checker accepts.
 */
function blockAfter(
  name: string,
  edit: (doc: any) => void,
  docs: Record<string, unknown> = {},
  refused: string[] = [],
) {
  const { load, dir } = loadedEditingAll(docs, { 'project.json': edit });
  try {
    expect(new Set(codes(dir))).toEqual(new Set(refused));
    const narrowed = manifestOf(load, { root: 'example', profile: name });
    expect(valid(narrowed)).toBe(true);
    return narrowed.profiles[name];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `production-staging`, a child of production with no permits of its own, standing jobs-staging in for the jobs. */
const staging = (away: boolean) => (doc: any) => {
  doc.profiles['production-staging'] = { extends: 'production', connections: { [JOBS]: JOBS_STAGING } };
  for (const step of doc.startup) if (step.profiles?.includes('production')) step.profiles.push('production-staging');
  if (!away) return;
  // its customers and its auth state kept where they do not reach the customer database
  doc.profiles['production-staging'].bindings = {
    '@customers/domain/customer.port.json': '@customers/data/customers-store.binding.json',
    '@auth/state.port.json': '@features/state/data/auth-files.binding.json',
  };
  const memory = doc.startup.find((step: any) => step.run.startsWith('@features/state/domain/memory'));
  memory.profiles = memory.profiles.filter((one: string) => one !== 'production-staging');
};

describe('manifestOf: a profile that extends another (RFC 0043)', () => {
  it('says extends: production on the two blocks that extend it, and null on every other', () => {
    const children = ['production-scheduler', 'production-worker'];
    for (const name of children) expect(block(name).extends).toBe('production');
    for (const name of Object.keys(manifest.profiles).filter(one => !children.includes(one)))
      expect(block(name).extends).toBeNull();
  });

  it("holds the child's extends and production's bindings and stand-ins, resolved and canonical", () => {
    const worker = block('production-worker');
    expect(worker.extends).toBe('production');
    expect(worker.bindings).toEqual(block('production').bindings);
    expect(worker.connections).toEqual(block('production').connections);
    expect(worker.description).toEqual(example.registry.project?.doc.profiles?.['production-worker'].description);
    expect(worker.permits).toEqual([...WORKER_PERMITS].sort());
  });

  it('a shared target: the inherited entry gives the stand-in, and the database the child still reaches', () => {
    const child = blockAfter('production-staging', staging(false), BROKER);
    expect(child.extends).toBe('production');
    expect(child.connections[JOBS]).toBe(JOBS_STAGING);
    expect(child.permits).toEqual(expect.arrayContaining([JOBS_STAGING, POSTGRES]));
    expect(child.permits?.length).toBe((block('production').permits?.length ?? 0) + 1);
  });

  it('a shared target the child no longer reaches its own way: the inherited entry gives jobs-staging alone', () => {
    // the bindings it moves to reach what production does not permit (C021), but no inherited entry is dead (C022)
    const child = blockAfter('production-staging', staging(true), BROKER, ['C021']);
    expect(child.permits).toContain(JOBS_STAGING);
    expect(child.permits).not.toContain(POSTGRES);
    expect(child.permits?.length).toBe(block('production').permits?.length);
  });
});

describe('manifest.schema.json: extends on the profile block', () => {
  it('requires it on every block: a profile name, or null', () => {
    const production = block('production');
    const extending = (value: unknown) => ({
      ...manifest,
      profiles: { ...manifest.profiles, production: { ...production, extends: value } },
    });
    expect(valid(extending(null))).toBe(true);
    expect(valid(extending('live'))).toBe(true);
    expect(valid(extending(42))).toBe(false);
    const { extends: _, ...unsaid } = production;
    expect(valid({ ...manifest, profiles: { ...manifest.profiles, production: unsaid } })).toBe(false);
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
