/**
 * `resolveProfile` (RFC 0043): what a profile that names another under `extends` means. Bindings and stand-ins are
 * the parent's under the child's own, one by one; permits are the parent's whole where the child writes none; and
 * a wrong `extends` still resolves, one step at most, for the checker to refuse.
 */
import { describe, expect, it } from 'vitest';
import type { AnyDoc, Kind, ProfileDoc } from '../src/model.js';
import { resolveProfile } from '../src/profiles.js';
import { Registry } from '../src/registry.js';
import { Scope } from '../src/scope.js';

// `@db/` is an alias of `@connections/`, and `@cust/` of `@customers/`: two spellings of one path meet as one.
const canon = (ref: string) => ref.replace(/^@db\//, '@connections/').replace(/^@cust\//, '@customers/');

const PORT = '@customers/domain/customer.port.json';
const AUTH = '@auth/domain/state.port.json';
const JOBS = '@connections/jobs.connection.json';
const HISTORY = '@connections/history.connection.json';
const SHARED = '@connections/customers-postgres.connection.json';

const production: ProfileDoc = {
  description: 'the place of record',
  default: true,
  bindings: { [PORT]: '@customers/data/sql.binding.json', [AUTH]: '@auth/data/sql.binding.json' },
  connections: { [JOBS]: SHARED },
  permits: ['@queue/queue.port.json#ensure', SHARED, HISTORY],
};

const resolve = (child: ProfileDoc, parent: ProfileDoc = production) =>
  resolveProfile({ production: parent, child }, 'child', canon);

describe('a profile that extends nothing', () => {
  it('resolves to itself, its keys canonical, inheriting nothing', () => {
    const written: ProfileDoc = { bindings: { '@cust/domain/customer.port.json': 'b.json' }, permits: [] };
    expect(resolveProfile({ production: written }, 'production', canon)).toEqual({
      bindings: { [PORT]: 'b.json' },
      connections: {},
      permits: [],
      alsoPermits: {},
      inherited: { bindings: [], connections: [], permits: false },
    });
    expect(resolveProfile({ production }, 'staging', canon)).toBeUndefined();
    expect(resolveProfile(undefined, 'production', canon)).toBeUndefined();
  });
});

describe('a child', () => {
  it("has the parent's bindings where it writes none, and replaces one port's binding while keeping the rest", () => {
    const bare = resolve({ extends: 'production' });
    expect(bare?.extends).toBe('production');
    expect(bare?.bindings).toEqual(production.bindings);
    expect(bare?.inherited.bindings).toEqual([PORT, AUTH]);
    const one = resolve({ extends: 'production', bindings: { [PORT]: '@customers/data/store.binding.json' } });
    expect(one?.bindings).toEqual({
      [PORT]: '@customers/data/store.binding.json',
      [AUTH]: production.bindings?.[AUTH],
    });
    expect(one?.inherited.bindings).toEqual([AUTH]);
  });
  it('meets a port written through two aliases as one port', () => {
    const aliased = resolve({ extends: 'production', bindings: { '@cust/domain/customer.port.json': 'store.json' } });
    expect(aliased?.bindings).toEqual({ [PORT]: 'store.json', [AUTH]: production.bindings?.[AUTH] });
    expect(aliased?.inherited.bindings).toEqual([AUTH]);
  });
  it("replaces the parent's stand-in for a connection with its own, and keeps the parent's others", () => {
    const other = '@connections/other.connection.json';
    const parent = { ...production, connections: { [JOBS]: SHARED, [HISTORY]: other } };
    const child = resolve(
      { extends: 'production', connections: { '@db/jobs.connection.json': 'jobs-staging.json' } },
      parent,
    );
    expect(child?.connections).toEqual({ [JOBS]: 'jobs-staging.json', [HISTORY]: other });
    expect(child?.inherited.connections).toEqual([HISTORY]);
  });
  it("has the parent's permits whole where it writes none, marked inherited", () => {
    const child = resolve({ extends: 'production' });
    expect(child?.permits).toEqual(production.permits);
    expect(child?.inherited.permits).toBe(true);
    expect(child?.alsoPermits).toEqual({});
  });
  it('has exactly its own permits where it writes a list, even an empty one', () => {
    const own = resolve({ extends: 'production', permits: ['@http/server.port.json#listen'] });
    expect(own?.permits).toEqual(['@http/server.port.json#listen']);
    expect(own?.inherited.permits).toBe(false);
    expect(resolve({ extends: 'production', permits: [] })?.permits).toEqual([]);
    const { permits: _, ...unlisted } = production;
    expect(resolve({ extends: 'production' }, unlisted)).not.toHaveProperty('permits');
  });
  it('never inherits default or description', () => {
    const child = resolve({ extends: 'production' });
    expect(child).not.toHaveProperty('default');
    expect(child).not.toHaveProperty('description');
    expect(resolve({ extends: 'production', description: 'a worker' })?.description).toBe('a worker');
  });
});

describe('an inherited permit for a connection the child stands in for', () => {
  const branch = '@connections/branch-history.connection.json';
  const staging = '@connections/jobs-staging.connection.json';

  it('carries the stand-in where the parent named the connection itself', () => {
    const child = resolve({ extends: 'production', connections: { [HISTORY]: '@db/branch-history.connection.json' } });
    expect(child?.alsoPermits).toEqual({ [HISTORY]: [branch] });
  });
  it('carries the stand-in where the parent named its own stand-in for it, the entry kept as it is written', () => {
    const child = resolve({ extends: 'production', connections: { [JOBS]: staging } });
    expect(child?.permits).toEqual(production.permits);
    expect(child?.alsoPermits).toEqual({ [SHARED]: [staging] });
  });
  it('carries nothing where the child stands in what the parent already reaches, or permits no list', () => {
    expect(resolve({ extends: 'production', connections: { [JOBS]: SHARED } })?.alsoPermits).toEqual({});
    const own = resolve({ extends: 'production', connections: { [HISTORY]: branch }, permits: [branch] });
    expect(own?.alsoPermits).toEqual({});
  });
  it('never reads an operation entry as a connection', () => {
    const parent = { ...production, permits: [`${HISTORY}#op`] };
    expect(resolve({ extends: 'production', connections: { [HISTORY]: branch } }, parent)?.alsoPermits).toEqual({});
  });
});

describe('a wrong extends', () => {
  it('names no declared profile, or the profile itself: resolves as if it extended nothing', () => {
    for (const named of ['staging', 'child', 'constructor']) {
      const child = resolve({ extends: named, bindings: {} });
      expect(child?.extends).toBeUndefined();
      expect(child?.bindings).toEqual({});
      expect(child?.inherited).toEqual({ bindings: [], connections: [], permits: false });
    }
  });
  it('names a profile that extends another: follows one step, as the parent is written, and never loops', () => {
    const profiles: Record<string, ProfileDoc> = {
      base: { bindings: { [AUTH]: 'base.json' }, permits: ['@base.json'] },
      middle: { extends: 'base', bindings: { [PORT]: 'middle.json' } },
      child: { extends: 'middle' },
      left: { extends: 'right' },
      right: { extends: 'left' },
    };
    const child = resolveProfile(profiles, 'child', canon);
    expect(child?.extends).toBe('middle');
    expect(child?.bindings).toEqual({ [PORT]: 'middle.json' });
    expect(child).not.toHaveProperty('permits');
    expect(resolveProfile(profiles, 'left', canon)?.extends).toBe('right');
    expect(resolveProfile(profiles, 'right', canon)?.bindings).toEqual({});
  });
});

describe('Scope.profile', () => {
  const Staging = '@connections/jobs-staging.connection.json';
  const registry = new Registry();
  const add = (kind: Kind, path: string, doc: Record<string, unknown>) =>
    registry.add({ kind, path, name: path, doc: doc as unknown as AnyDoc });
  const profiles = {
    production,
    worker: { extends: 'production', connections: { '@db/jobs.connection.json': Staging } },
  };
  add('project', '@project.json', { name: 'p', plugins: [], profiles });
  for (const binding of Object.values(production.bindings ?? {}))
    add('binding', binding, { port: PORT, operations: {} });
  for (const connection of [JOBS, SHARED, Staging]) add('connection', connection, { kind: '@k.json', settings: {} });
  const scope = new Scope(registry, canon);

  it("is what bindingFor and connectionFor read: a child's own choices over its parent's", () => {
    expect(scope.profile('worker')).toBe(scope.profile('worker'));
    expect(scope.profile('worker')?.extends).toBe('production');
    expect(scope.profile('staging')).toBeUndefined();
    const bound = scope.bindingFor(PORT, 'worker');
    expect(typeof bound === 'string' ? bound : bound.path).toBe('@customers/data/sql.binding.json');
    const reached = (profile: string) => {
      const found = scope.connectionFor('@db/jobs.connection.json', profile);
      return typeof found === 'string' ? found : found.path;
    };
    expect([reached('production'), reached('worker')]).toEqual([SHARED, Staging]);
  });
});
