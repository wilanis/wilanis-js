/**
 * RFC 0026's manifest, step 1: the inventory `manifestOf` answers over the example, the same bytes however the tree
 * was walked, the published schema it validates against, and the command that prints it. The command's cases sit
 * here rather than in tools.test.ts, which is at the house rules' length.
 *
 * The golden beside this file is generated, never written by hand. When the example changes, regenerate it with
 *   npx vitest run packages/runtime/test/manifest.test.ts -u
 * and read the diff: it is a diff of what the tree is.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LoadResult, loadTree, type Registry, type ResolvedInclude } from '@wilanis/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject, type Manifest, manifestOf, type ProjectLoad } from '../src/index.js';
import { keySorted } from '../src/manifest-rows.js';
import { copyOfExample, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const RUNTIME = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const VERSION: string = read(join(RUNTIME, 'package.json')).version;
const ACCESS_VERSION: string = read(join(INCLUDES[0].dir, 'package.json')).version;
const valid = new Ajv2020({ allErrors: true }).compile(read(join(RUNTIME, 'schemas/manifest.schema.json')));
const conforms = (manifest: unknown) => (valid(manifest) ? [] : valid.errors);

/** The manifest as the command prints it. */
const printed = (manifest: Manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

/** A copy's include as the runtime would resolve it, version and all: a copy has no node_modules to find it in. */
const VERSIONED: ResolvedInclude[] = INCLUDES.map(include => ({ ...include, version: ACCESS_VERSION }));

/** The same load with its registry's documents in the reverse order, as another walk of the disk might find them. */
function reversed(load: ProjectLoad): ProjectLoad {
  const registry = Object.assign(Object.create(Object.getPrototypeOf(load.registry)), load.registry, {
    files: [...load.registry.files].reverse(),
  }) as Registry;
  return { ...load, registry };
}

let example: ProjectLoad;
let manifest: Manifest;
beforeAll(async () => {
  example = await loadProject(EXAMPLE);
  manifest = manifestOf(example, { root: 'example' });
});

describe('manifestOf: the inventory of the example', () => {
  it('matches the golden, which is generated from the code', async () => {
    await expect(printed(manifest)).toMatchFileSnapshot('./manifest.golden.json');
  });

  it('opens with the envelope: format 1, the runtime, the schema version, the name and the root as given', () => {
    expect(manifest).toMatchObject({ format: 1, runtime: VERSION, ir: 'v1', name: 'customers', root: 'example' });
  });

  it('names every plugin with the version it was resolved at, the builtins at the runtime’s own', () => {
    const uses = manifest.plugins.map(plugin => plugin.use);
    expect(uses).toEqual(example.registry.project?.doc.plugins.map(use => use.use).sort());
    expect(manifest.plugins.filter(plugin => plugin.guard).map(plugin => plugin.use)).toEqual(['@auth']);
    expect(manifest.plugins.find(plugin => plugin.use === '@std')).toEqual({
      use: '@std',
      from: null,
      version: VERSION,
      guard: false,
    });
    const http = read(join(RUNTIME, '../plugin-http/package.json'));
    expect(manifest.plugins.find(plugin => plugin.use === '@http')).toMatchObject({
      from: http.name,
      version: http.version,
    });
    for (const plugin of manifest.plugins) expect(plugin.version).toEqual(expect.any(String));
  });

  it('lists the include once with its version, and its documents inline, marked with the package', () => {
    expect(manifest.includes).toEqual([{ from: '@wilanis/access', version: ACCESS_VERSION, features: ['access'] }]);
    expect(manifest.documents).toContainEqual({
      path: '@features/access/edge/auth-employees.trigger.json',
      kind: 'trigger',
      feature: 'access',
      layer: 'edge',
      included: '@wilanis/access',
    });
    expect(manifest.features.find(feature => feature.name === 'access')?.included).toBe('@wilanis/access');
    expect(manifest.features.find(feature => feature.name === 'customers')?.included).toBeNull();
    expect(manifest.documents).toHaveLength(example.registry.files.length);
  });

  it('says which triggers are public and which policies gate the rest, in the order attached', () => {
    const trigger = (name: string) => manifest.triggers.find(one => one.path.endsWith(`/${name}.trigger.json`));
    const doc = read(join(EXAMPLE, 'features/customers/edge/delete-customers.trigger.json'));
    expect(trigger('delete-customers')).toEqual({
      path: '@features/customers/edge/delete-customers.trigger.json',
      kind: '@http/http.trigger-kind.json',
      settings: keySorted(doc.settings),
      fires: '@features/customers/domain/customer.port.json#removeMany',
      policies: ['@features/access/edge/employees-only.policy.json', '@features/access/edge/can-register.policy.json'],
      public: false,
      included: null,
    });
    expect(trigger('auth-employees')).toMatchObject({ public: true, policies: [], included: '@wilanis/access' });
    const gate = manifest.policies.find(one => one.path === '@features/access/edge/employees-only.policy.json');
    expect(gate?.gates).toContain('@features/customers/edge/delete-customers.trigger.json');
    expect(gate?.included).toBe('@wilanis/access');
  });

  it('says who fires each domain operation and who binds each port, and what a native operation promises', () => {
    const customers = manifest.ports.domain.find(port => port.path === '@features/customers/domain/customer.port.json');
    expect(customers?.operations.find(op => op.name === 'removeMany')).toEqual({
      name: 'removeMany',
      firedBy: ['@features/customers/edge/delete-customers.trigger.json'],
      public: false,
    });
    expect(customers?.bindings).toContain('@features/customers/data/customers-rest.binding.json');
    expect(customers?.feature).toBe('customers');
    expect(manifest.ports.domain.find(port => port.path === '@auth/state.port.json')?.feature).toBeNull();
    expect(manifest.ports.native.find(port => port.path === '@http/server.port.json')).toEqual({
      path: '@http/server.port.json',
      grantedBy: '@http',
      operations: [{ name: 'listen', pure: false, holds: true }],
    });
  });

  it('prints a connection’s settings as written and the secret keys they read, never a value', () => {
    const connection = (name: string) => manifest.connections.find(one => one.path === `@connections/${name}`);
    const api = read(join(EXAMPLE, 'connections/customers-api.connection.json'));
    expect(connection('customers-api.connection.json')).toEqual({
      path: '@connections/customers-api.connection.json',
      kind: api.kind,
      settings: keySorted(api.settings),
      secrets: [],
    });
    expect(connection('customers-postgres.connection.json')).toMatchObject({
      settings: { url: '{{secrets.customersDatabase}}' },
      secrets: ['customersDatabase'],
    });
    // keys in code-unit order at every depth, whatever order the document wrote them in; arrays keep theirs
    expect(Object.keys(api.settings)).not.toEqual(Object.keys(api.settings).sort());
    expect(Object.keys(connection('customers-api.connection.json')?.settings ?? {})).toEqual(
      Object.keys(api.settings).sort(),
    );
    expect(keySorted({ b: [{ d: 1, c: 2 }, 'z', 'a'], a: null })).toEqual({ a: null, b: [{ c: 2, d: 1 }, 'z', 'a'] });
    expect(JSON.stringify(keySorted({ b: { d: 1, c: 2 }, a: 1 }))).toBe('{"a":1,"b":{"c":2,"d":1}}');
    expect(manifest.secrets).toEqual(example.registry.project?.doc.secrets);
    expect(Object.keys(manifest.secrets)).toEqual(Object.keys(manifest.secrets).sort());
  });

  it('keeps the startup steps in the order declared, required defaulted to true', () => {
    const declared = example.registry.project?.doc.startup ?? [];
    expect(manifest.startup.map(step => step.label)).toEqual(declared.map(step => step.label));
    expect(manifest.startup[0]).toEqual({
      label: 'Prepare the customer store',
      run: '@features/customers/domain/customer.port.json#prepare',
      required: true,
      profiles: null,
    });
    const watch = manifest.startup.find(step => step.run === '@reload/watch.port.json#watch');
    expect(watch).toMatchObject({ required: true, profiles: ['live', 'local'] });
  });
});

describe('manifestOf: determinism', () => {
  const probe = 'manifest-probe-value-314';
  const probed = ['CUSTOMERS_JWT_SECRET', 'WILANIS_MANIFEST_PROBE', 'WILANIS_PROFILE'];
  const saved = Object.fromEntries(probed.map(name => [name, process.env[name]]));
  beforeAll(() => {
    process.env.CUSTOMERS_JWT_SECRET = probe;
    process.env.WILANIS_MANIFEST_PROBE = probe;
    process.env.WILANIS_PROFILE = 'production';
  });
  afterAll(() => {
    for (const name of probed) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('answers the same string twice, and whichever order the registry was walked in', () => {
    const again = printed(manifestOf(example, { root: 'example' }));
    expect(again).toBe(printed(manifest));
    expect(printed(manifestOf(reversed(example), { root: 'example' }))).toBe(again);
  });

  it('holds no timestamp and no value of the environment, and ignores WILANIS_PROFILE', () => {
    const text = printed(manifestOf(example, { root: 'example' }));
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(text).not.toContain(probe);
    expect(text).toBe(printed(manifest));
  });

  it('prints a copy, loaded with its include handed in, with the include’s version and not the copy’s place', () => {
    const dir = copyOfExample();
    try {
      const loaded: LoadResult = loadTree(dir, PLUGINS, VERSIONED);
      const copied = manifestOf({ ...loaded, resolved: { plugins: {}, includes: VERSIONED } }, { root: 'example' });
      expect(copied.includes).toEqual(manifest.includes);
      expect(copied.documents).toEqual(manifest.documents);
      // a module handed in has no package to read a version from, and the manifest says so rather than guess
      expect(copied.plugins.find(plugin => plugin.use === '@http')?.version).toBeNull();
      expect(copied.plugins.find(plugin => plugin.use === '@cli')?.version).toBe(VERSION);
      expect(printed(copied)).not.toContain(dir);
      expect(conforms(copied)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('manifestOf: a copy, never the tree', () => {
  it('hands back settings a caller may edit without editing the loaded documents', () => {
    const own = manifestOf(example, { root: 'example' });
    const trigger = own.triggers.find(one => one.path.endsWith('/delete-customers.trigger.json'));
    const connection = own.connections.find(one => one.path === '@connections/customers-api.connection.json');
    if (!trigger || !connection) throw new Error('the example lost its delete trigger or its API connection');
    trigger.settings.route = '/edited';
    (connection.settings.throttle as Record<string, unknown>).concurrency = 99;
    const loaded = (path: string) => example.registry.any(path)?.doc as { settings: Record<string, any> };
    expect(loaded(trigger.path).settings.route).toBe('/customers');
    expect(loaded(connection.path).settings.throttle.concurrency).toBe(4);
    expect(printed(manifestOf(example, { root: 'example' }))).toBe(printed(manifest));
  });
});

describe('manifest.schema.json', () => {
  it('accepts what manifestOf answers', () => {
    expect(conforms(manifest)).toEqual([]);
  });

  it('refuses a key it does not name, on the envelope and on a row', () => {
    expect(valid({ ...manifest, counts: {} })).toBe(false);
    const [first, ...rest] = manifest.plugins;
    expect(valid({ ...manifest, plugins: [{ ...first, extra: true }, ...rest] })).toBe(false);
    const [port, ...ports] = manifest.ports.native;
    const widened = { ...port, operations: port.operations.map(op => ({ ...op, raw: true })) };
    expect(valid({ ...manifest, ports: { ...manifest.ports, native: [widened, ...ports] } })).toBe(false);
  });
});

/** The CLI from the built runtime, run in `dir`: its exit code and what it wrote on each stream. */
function wilanis(dir: string, ...args: string[]) {
  const ran = spawnSync(process.execPath, [join(RUNTIME, 'bin/wilanis.js'), ...args], { cwd: dir, encoding: 'utf8' });
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

describe('wilanis manifest', () => {
  it('prints the manifest of an accepted tree as JSON on stdout and exits 0', { timeout: 60_000 }, () => {
    const ran = wilanis(join(EXAMPLE, '..'), 'manifest', 'example');
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe(printed(manifest));
  });

  it('prints the refusals of a tree that fails check, as check does, and no JSON, and exits 1', {
    timeout: 60_000,
  }, () => {
    const dir = copyOfExample();
    try {
      symlinkSync(join(EXAMPLE, '../node_modules'), join(dir, 'node_modules'));
      const feature = join(dir, 'features/customers/feature.json');
      const doc = read(feature);
      doc.effects = doc.effects.filter((one: string) => one !== '@http/http.port.json#request');
      writeFileSync(feature, JSON.stringify(doc, null, 2));
      const ran = wilanis(dir, 'manifest', '.');
      expect(ran.code).toBe(1);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toMatch(/^L003 {2}/);
      expect(ran.stderr).toMatch(/\d+ refusal\(s\)\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
