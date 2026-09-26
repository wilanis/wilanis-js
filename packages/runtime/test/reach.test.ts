import { buildEnv, type Reach, reachOf } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { unsetSecrets } from '../src/index.js';
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
      '@connections/employees.connection.json',
      '@connections/people.connection.json',
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
      '@connections/jobs.connection.json',
      '@connections/people.connection.json',
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
    // today it refuses every declared one -- CUSTOMERS_DATABASE_URL on a laptop that keeps its customers in memory
    const said = (profile: string) =>
      reach(profile)
        .secrets.map(one => `${one.variable} (${one.key}, read by ${one.readBy})`)
        .sort();
    expect(said('local')).toEqual(['CUSTOMERS_JWT_SECRET (jwt, read by @auth settings)']);
    expect(said('production')).toEqual([
      'CUSTOMERS_DATABASE_URL (customersDatabase, read by @connections/customers-postgres.connection.json)',
      'CUSTOMERS_JWT_SECRET (jwt, read by @auth settings)',
      'CUSTOMERS_OPERATOR_PASSWORD_HASH (operatorPasswordHash, read by @connections/employees-production.connection.json)',
    ]);
    // because the connection behind the customers is what the binding changes
    expect(reach('local').connections).toContain('@connections/customers.connection.json');
    expect(reach('production').connections).toContain('@connections/customers-postgres.connection.json');
    expect(reach('local').connections).not.toContain('@connections/customers-postgres.connection.json');
    // and nothing a profile does not run is walked: live prepares with a request, the two stores with ensure
    expect(keys(reach('live'))).not.toContain('@storage/storage.port.json#ensure');
    expect(keys(reach('local'))).toContain('@storage/storage.port.json#ensure');
  });

  it("walks only the triggers a profile serves: the workers never read the operator's hash, which only routes read", () => {
    // production-worker and production-scheduler bind what production binds, but open no port, so the sign-in
    // routes that verify the operator against employees-production run nowhere there (#703)
    const production = reach('production');
    for (const name of ['production-worker', 'production-scheduler']) {
      const quiet = reach(name);
      expect(quiet.secrets.map(one => one.variable).sort()).toEqual(['CUSTOMERS_DATABASE_URL', 'CUSTOMERS_JWT_SECRET']);
      for (const route of [
        '@auth/identity.port.json#verify',
        '@auth/token.port.json#issue',
        '@blob/csv.port.json#parse',
        '@queue/queue.port.json#publish',
      ]) {
        expect(keys(production)).toContain(route);
        expect(keys(quiet)).not.toContain(route);
      }
      expect(quiet.connections).not.toContain('@connections/employees-production.connection.json');
      // what still runs there: the steps, the guard's memory, and the commands `wilanis run` fires anywhere
      expect(keys(quiet)).toContain('@storage/store.port.json#get');
      expect(keys(quiet)).toContain('@auth/challenge.port.json#issue');
    }
    // and the worker still reaches what the queue trigger it consumes for reaches: the removal, in the store
    const worker = reach('production-worker').operations.filter(one => one.root.kind === 'trigger');
    expect(worker.map(one => one.root.file)).toContain('@features/customers/edge/remove-queued.trigger.json');
    expect(worker.map(one => one.root.file)).not.toContain('@features/customers/edge/get-customer.trigger.json');
  });

  it('asks start for only the variables the profile reaches: production-worker starts without the hash', () => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    const scope = new Scope(load.registry, load.resolve);
    const env = { CUSTOMERS_DATABASE_URL: 'postgres://customers@localhost/customers', CUSTOMERS_JWT_SECRET: 'jwt' };
    expect(unsetSecrets(scope, 'production-worker', env)).toEqual([]);
    expect(unsetSecrets(scope, 'production', env)).toEqual([
      'CUSTOMERS_OPERATOR_PASSWORD_HASH (operatorPasswordHash, read by @connections/employees-production.connection.json)',
    ]);
  });

  it('walks a route under every profile where no profile listens, so a tree that serves nowhere is walked whole', () => {
    // #632's fallback, kept: with the Listen step gone no profile serves a route, and each is walked everywhere
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    const scope = new Scope(load.registry, load.resolve);
    const project = scope.project;
    if (project?.startup)
      project.startup = project.startup.filter(step => step.run !== '@http/server.port.json#listen');
    const worker = reachOf(scope, 'production-worker');
    expect(keys(worker)).toContain('@auth/identity.port.json#verify');
    expect(worker.secrets.map(one => one.variable)).toContain('CUSTOMERS_OPERATOR_PASSWORD_HASH');
  });

  it('production reaches the operator directory in place of the employees, and watches nothing', () => {
    // the example's own stand-in: every document still names employees.connection.json, and production reaches
    // the connection that stands in for it -- the directories verify reaches are the only thing it changes there
    const production = reach('production');
    expect(via(production, '@auth/identity.port.json#verify')).toEqual([
      '@connections/employees-production.connection.json',
      '@connections/people.connection.json',
    ]);
    expect(production.connections).not.toContain('@connections/employees.connection.json');
    for (const laptop of ['live', 'local']) {
      expect(reach(laptop).connections).toContain('@connections/employees.connection.json');
      expect(reach(laptop).holds).toContain('@reload/watch.port.json#watch');
    }
    // the watcher is a laptop's step; what production holds open is what serves and reports, nothing that reloads
    // and nothing that schedules, which is production-scheduler's alone, and that one opens no port (RFC 0010)
    // and nothing that works the queue, which is production-worker's, and that one opens no port either (RFC 0009)
    expect(production.holds).toEqual(['@otel/exporter.port.json#export', '@http/server.port.json#listen']);
    expect(reach('production-scheduler').holds).toEqual([
      '@schedule/scheduler.port.json#run',
      '@otel/exporter.port.json#export',
    ]);
    expect(reach('production-worker').holds).toEqual([
      '@otel/exporter.port.json#export',
      '@queue/worker.port.json#consume',
    ]);
    // a handler asks for the connection by the name the documents use, and is handed the stand-in's settings
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    const scope = new Scope(load.registry, load.resolve);
    const variables = { CUSTOMERS_OPERATOR_PASSWORD_HASH: 'scrypt:salt:hash' };
    const users = (profile: string) =>
      (buildEnv(scope, variables, profile).env.connections as any)['@connections/employees.connection.json'].settings
        .users;
    expect(users('production')).toEqual([
      { username: 'operator', passwordHash: 'scrypt:salt:hash', name: 'Operator', groups: ['registrar'] },
    ]);
    expect(users('live').map((one: any) => one.username)).toEqual(['bo', 'cy']);
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
