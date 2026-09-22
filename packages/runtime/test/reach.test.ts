import { type Reach, reachOf } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

describe('the reach of a profile', () => {
  // RFC 0013: what the tree does where it runs, derived from the profile's bindings and nothing else
  const reach = (profile: string) => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    return reachOf(new Scope(load.registry, load.resolve), profile);
  };
  const keys = (found: Reach) => new Set(found.operations.map(one => one.key));
  const via = (found: Reach, key: string) =>
    [...new Set(found.operations.filter(one => one.key === key).map(one => one.connection))].sort();

  it('holds what live runs: the upstream API, the directories, the tokens, the files, the CSV, and what it holds open', () => {
    const live = reach('live');
    expect(via(live, '@http/http.port.json#request')).toEqual(['@connections/customers-api.connection.json']);
    expect(via(live, '@auth/identity.port.json#verify')).toEqual([
      '@connections/customers.connection.json',
      '@connections/employees.connection.json',
    ]);
    for (const key of ['@auth/token.port.json#issue', '@auth/token.port.json#refresh']) {
      expect(keys(live)).toContain(key);
    }
    for (const key of ['@blob/csv.port.json#parse', '@blob/csv.port.json#write']) expect(keys(live)).toContain(key);
    // the guard's memory, through the binding the profile chose for the port @auth requires (RFC 0005)
    const files = [...keys(live)].filter(key => key.startsWith('@auth/files.port.json#')).sort();
    expect(files).toEqual(['@auth/files.port.json#get', '@auth/files.port.json#put', '@auth/files.port.json#remove']);
    expect(live.holds).toContain('@http/server.port.json#listen');
    expect(live.holds).toContain('@reload/watch.port.json#watch');
    // a pure operation is no effect, and the connections are the ones those sites named, each once
    expect([...keys(live)].some(key => key.startsWith('@std/'))).toBe(false);
    expect(live.connections).toEqual([
      '@connections/customers-api.connection.json',
      '@connections/customers.connection.json',
      '@connections/employees.connection.json',
    ]);
    // and each site says where it was reached from and through, for the message that names it
    const request = live.operations.find(one => one.key === '@http/http.port.json#request');
    expect(request?.binding).toBe('@features/customers/data/customers-rest.binding.json');
    expect(request?.root.kind).toBe('trigger');
    const listen = live.operations.find(one => one.key === '@http/server.port.json#listen');
    expect(listen?.root).toEqual({ kind: 'startup', file: '@project.json', run: '@http/server.port.json#listen' });
    expect(listen?.binding).toBeUndefined();
  });

  it('reads the database secret under production alone, and the token secret everywhere', () => {
    // the reason this walk exists: `start` will refuse the variables the profile reaches and no other, where
    // today it refuses every declared one -- MONITOR_DATABASE_URL on a laptop that keeps its entries in memory
    const said = (profile: string) =>
      reach(profile)
        .secrets.map(one => `${one.variable} (${one.key}, read by ${one.readBy})`)
        .sort();
    expect(said('local')).toEqual(['MONITOR_JWT_SECRET (jwt, read by @auth settings)']);
    expect(said('production')).toEqual([
      'MONITOR_DATABASE_URL (entriesDatabase, read by @connections/customers-postgres.connection.json)',
      'MONITOR_JWT_SECRET (jwt, read by @auth settings)',
    ]);
    // because the connection behind the entries is what the binding changes
    expect(reach('local').connections).toContain('@connections/customers.connection.json');
    expect(reach('production').connections).toContain('@connections/customers-postgres.connection.json');
    expect(reach('local').connections).not.toContain('@connections/customers-postgres.connection.json');
    // and nothing a profile does not run is walked: live prepares with a request, the two stores with ensure
    expect(keys(reach('live'))).not.toContain('@storage/storage.port.json#ensure');
    expect(keys(reach('local'))).toContain('@storage/storage.port.json#ensure');
  });

  it('roots the guard at its manifest and the routes at their triggers, and answers the same twice', () => {
    // the guard's memory is reached from the manifest that requires the port, not from any document of the tree;
    // the example's policies reach nothing effectful -- their graphs read the principal and refuse -- so they
    // leave no trace here, which is what a reach of non-pure operations should say of them
    const live = reach('live');
    const roots = new Set(live.operations.map(one => `${one.root.kind} ${one.root.file}`));
    expect(roots).toContain('required @auth/plugin.json');
    expect(roots).toContain('trigger @features/customers/edge/list-customers.trigger.json');
    expect([...roots].some(one => one.startsWith('policy '))).toBe(false);
    // the same tree, the same profile, the same answer: the walk is pure over the loaded documents
    expect(reach('live')).toEqual(live);
  });
});
