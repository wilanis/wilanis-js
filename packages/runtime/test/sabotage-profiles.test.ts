import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildEnv, reachOf } from '@wilanis/compiler';
import { Scope, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE,
  loadedEditing,
  loadedWith,
  plantedAll,
  sabotage,
  sabotageHinting,
  sabotagePointing,
  sabotageSaying,
} from './example-harness.js';

/**
 * A profile is one place a tree runs (RFC 0013): at most one is the default, a connection may stand in for
 * another of its kind under it, and a startup step may say which profiles run it. The stand-in below is planted
 * under live, beside the one production already names (employees-production), so these cases own every line
 * they change.
 */
describe('sabotage: profiles, their stand-ins, and the steps they run', () => {
  const api = '@connections/customers-api.connection.json';
  const staging = '@connections/customers-api-staging.connection.json';
  const standIn = {
    'connections/customers-api-staging.connection.json': {
      $schema: schemaUrl('connection'),
      description: 'The customers API a staging cluster reaches, keyed by a variable the environment supplies.',
      kind: '@http/http.connection-kind.json',
      settings: { baseUrl: 'https://staging.invalid/api/v1', headers: { 'x-api-key': '{{secrets.customerKey}}' } },
    },
  };
  /** The example's project with the stand-in named under `live`, and whatever else the case changes. */
  const project = (edit: (doc: any) => void = () => {}) => {
    const doc = JSON.parse(readFileSync(join(EXAMPLE, 'project.json'), 'utf8'));
    doc.secrets.customerKey = 'CUSTOMERS_API_KEY';
    doc.profiles.live.connections = { [api]: staging };
    edit(doc);
    return doc;
  };
  const mapping = (to: string) => (doc: any) => {
    doc.profiles.live.connections = { [api]: to };
  };

  it('passes check with a stand-in of the same kind, and each place reaches what its profile chose', () => {
    expect(plantedAll({ ...standIn, 'project.json': project() })).toEqual([]);
    const { load, dir } = loadedWith({ ...standIn, 'project.json': project() });
    const scope = new Scope(load.registry, load.resolve);
    expect(reachOf(scope, 'live').connections).toContain(staging);
    expect(reachOf(scope, 'live').connections).not.toContain(api);
    expect(reachOf(scope, 'live').secrets.map(one => one.key)).toContain('customerKey');
    // a handler asks for the connection the documents name, and is handed the stand-in's settings
    const env = (profile: string) => (buildEnv(scope, { CUSTOMERS_API_KEY: 'k' }, profile).env.connections as any)[api];
    expect(env('live').settings).toEqual({ baseUrl: 'https://staging.invalid/api/v1', headers: { 'x-api-key': 'k' } });
    expect(env('local').settings.baseUrl).toContain('mockapi.io');
    rmSync(dir, { recursive: true, force: true });
  });
  it('a startup step naming its profiles is reached under those and no other', () => {
    const { load, dir } = loadedWith({
      'project.json': project(doc => {
        doc.startup.find((step: any) => step.run.startsWith('@reload/')).profiles = ['live'];
      }),
      ...standIn,
    });
    const scope = new Scope(load.registry, load.resolve);
    expect(reachOf(scope, 'live').holds).toContain('@reload/watch.port.json#watch');
    expect(reachOf(scope, 'local').holds).not.toContain('@reload/watch.port.json#watch');
    rmSync(dir, { recursive: true, force: true });
  });
  it('C017 two profiles each marked default', () => {
    const both = sabotage('project.json', doc => {
      doc.profiles.live.default = true;
      doc.profiles.production.default = true;
    });
    expect(both).toContain('C017');
    expect(sabotage('project.json', doc => (doc.profiles.live.default = true))).toEqual([]);
  });
  it('C018 a connection standing in for itself, or for one of another kind; R001 one that names nothing', () => {
    const codes = (to: string) => plantedAll({ ...standIn, 'project.json': project(mapping(to)) });
    expect(codes('@connections/employees.connection.json')).toContain('C018');
    expect(codes(api)).toContain('C018');
    expect(codes('@connections/nowhere.connection.json')).toContain('R001');
  });
  it('C019 a secret nothing reads', () => {
    expect(sabotage('project.json', doc => (doc.secrets.unused = 'UNUSED_SECRET'))).toEqual(['C019']);
  });
  it('B012 a startup step naming a profile the project does not declare', () => {
    const naming = (profiles: string[]) =>
      sabotage('project.json', doc => {
        doc.startup.at(-1).profiles = profiles;
      });
    // and production, which no longer listens, permits the listener for nothing (C022)
    expect(naming(['staging'])).toEqual(['C022', 'B012']);
    expect(naming(['live', 'production'])).toEqual([]);
  });
  it('B008 judged only under the profiles a step runs under', () => {
    const said = sabotageSaying('project.json', doc => {
      doc.startup[0].run = '@customers/domain/customer.port.json#register';
      doc.startup[0].in = { url: 'http://x', method: 'GET', agent: 'startup' };
      doc.startup[0].profiles = ['production'];
    }).filter(one => one.startsWith('B008'));
    expect(said.length).toBeGreaterThan(0);
    for (const one of said) expect(one).toContain("(profile 'production')");
    expect(said.some(one => one.includes("'live'") || one.includes("'local'"))).toBe(false);
  });
});

/** Exactly what `production-worker` reaches: production's storage and queue, the consumer, and no listener. */
const WORKER = [
  '@storage/store.port.json',
  '@storage/storage.port.json#ensure',
  '@queue/queue.port.json#ensure',
  '@queue/worker.port.json#consume',
  '@auth/challenge.port.json#issue',
  '@otel/exporter.port.json#export',
  '@connections/customers-postgres.connection.json',
];

/** Exactly what `production-scheduler` reaches: production's storage and queue, the scheduler, and no listener. */
const SCHEDULER = [...WORKER.filter(entry => !entry.startsWith('@queue/worker')), '@schedule/scheduler.port.json#run'];

/** One profile as a child of another (RFC 0043): it writes its description, its own permits, and what `extra` adds. */
const extending =
  (name: string, permits: string[], extra: Record<string, unknown> = {}) =>
  (doc: any) => {
    const { description } = doc.profiles[name];
    doc.profiles[name] = { description, extends: 'production', permits, ...extra };
  };

/**
 * A profile that names another under `extends` (RFC 0043) means the parent's choices with its own over them. The
 * worker below is planted as such a child: it writes its own `permits`, since it reaches less than production.
 */
describe('sabotage: a profile that extends another', () => {
  const worker = (extra: Record<string, unknown> = {}) => extending('production-worker', WORKER, extra);

  it("passes check with the worker extending production, and follows production's bindings with no copy", () => {
    expect(sabotage('project.json', worker())).toEqual([]);
    const { load, dir } = loadedEditing('project.json', doc => {
      worker()(doc);
      doc.profiles.production.bindings['@customers/domain/customer.port.json'] =
        '@customers/data/customers-store.binding.json';
    });
    const scope = new Scope(load.registry, load.resolve);
    const bound = reachOf(scope, 'production-worker').operations.map(site => site.binding);
    // the drift a copy would keep: production's binding changed, and the worker follows it with no edit of its own
    expect(bound).toContain('@features/customers/data/customers-store.binding.json');
    expect(bound).not.toContain('@features/customers/data/customers-postgres.binding.json');
    rmSync(dir, { recursive: true, force: true });
  });
  it('C024 a profile extending one the project does not declare, itself, or one that extends another', () => {
    const naming = (parent: string) => (doc: any) => {
      doc.profiles['production-worker'].extends = parent;
    };
    const at = 'C024 @project.json#profiles/production-worker/extends';
    expect(sabotage('project.json', naming('staging'))).toEqual(['C024']);
    expect(sabotagePointing('project.json', naming('staging'))).toEqual([at]);
    expect(sabotagePointing('project.json', naming('production-worker'))).toEqual([at]);
    expect(sabotageSaying('project.json', naming('staging'))).toEqual([
      "C024 profile 'production-worker' extends 'staging', which the project does not declare",
    ]);
    expect(sabotageHinting('project.json', naming('production-worker'))).toEqual([
      'C024 name another declared profile: live, local, production, production-scheduler',
    ]);
    // the worker keeps its own choices: a chain resolves one step, to the scheduler as it is written
    const chain = (doc: any) => {
      extending('production-scheduler', SCHEDULER)(doc);
      naming('production-scheduler')(doc);
      doc.profiles['production-worker'].permits = WORKER;
    };
    expect(sabotagePointing('project.json', chain)).toEqual([at]);
    expect(sabotageSaying('project.json', chain)).toEqual([
      "C024 profile 'production-worker' extends 'production-scheduler', which extends 'production'; a profile extends one that extends nothing",
    ]);
    expect(sabotageHinting('project.json', chain)).toEqual([
      "C024 extend 'production' directly and write what 'production-scheduler' changes, or remove extends from 'production-scheduler'",
    ]);
  });
  it('C024 two profiles that extend each other, each at its own extends, each told to remove one', () => {
    const cycle = (doc: any) => {
      doc.profiles['production-worker'].extends = 'production-scheduler';
      doc.profiles['production-scheduler'].extends = 'production-worker';
    };
    expect(new Set(sabotagePointing('project.json', cycle))).toEqual(
      new Set([
        'C024 @project.json#profiles/production-worker/extends',
        'C024 @project.json#profiles/production-scheduler/extends',
      ]),
    );
    expect(new Set(sabotageSaying('project.json', cycle))).toEqual(
      new Set([
        "C024 profile 'production-worker' extends 'production-scheduler', which extends 'production-worker'; a profile extends one that extends nothing",
        "C024 profile 'production-scheduler' extends 'production-worker', which extends 'production-scheduler'; a profile extends one that extends nothing",
      ]),
    );
    expect(new Set(sabotageHinting('project.json', cycle))).toEqual(
      new Set([
        "C024 remove extends from 'production-worker', or remove extends from 'production-scheduler'",
        "C024 remove extends from 'production-scheduler', or remove extends from 'production-worker'",
      ]),
    );
  });
  it('C018 a child mapping an inherited stand-in to itself, refused once, at its own line', () => {
    const employees = '@connections/employees.connection.json';
    expect(sabotagePointing('project.json', worker({ connections: { [employees]: employees } }))).toEqual([
      'C018 @project.json#profiles/production-worker/connections',
    ]);
  });
});
