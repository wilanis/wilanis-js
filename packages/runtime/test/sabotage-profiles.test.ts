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
    // and production, which no longer listens, permits the listener for nothing (C022); and with no profile
    // listening, every profile walks every route, so the two that extend production and write their own permits
    // miss what the routes reach (C021)
    const codes = naming(['staging']);
    expect(codes.filter(code => code !== 'C021')).toEqual(['C022', 'B012']);
    expect(codes).toContain('C021');
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

/**
 * A profile that names another under `extends` (RFC 0043) means the parent's choices with its own over them. The
 * example's production-worker and production-scheduler extend production: each has production's bindings and
 * stand-ins, and writes its own `permits`, since each reaches less than production and one thing production does not.
 */
describe('sabotage: a profile that extends another', () => {
  /** The example with production-worker naming `parent` under `extends`. */
  const naming = (parent: string) => (doc: any) => {
    doc.profiles['production-worker'].extends = parent;
  };
  /**
   * The C024 lines alone. A wrong `extends` resolves as if it were absent, or to the parent as written, and the
   * worker writes no bindings, so what it then leaves unmet or unpermitted is refused too (B002, C021, C022).
   */
  const c024 = (lines: string[]) => lines.filter(one => /^C024\b/.test(one));

  it("passes check with the worker extending production, and follows production's bindings with no copy", () => {
    expect(sabotage('project.json', () => {})).toEqual([]);
    const { load, dir } = loadedEditing('project.json', doc => {
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
    const at = 'C024 @project.json#profiles/production-worker/extends';
    expect(sabotage('project.json', naming('staging'))).toContain('B002');
    expect(c024(sabotage('project.json', naming('staging')))).toEqual(['C024']);
    expect(c024(sabotagePointing('project.json', naming('staging')))).toEqual([at]);
    expect(c024(sabotagePointing('project.json', naming('production-worker')))).toEqual([at]);
    expect(c024(sabotageSaying('project.json', naming('staging')))).toEqual([
      "C024 profile 'production-worker' extends 'staging', which the project does not declare",
    ]);
    // the profiles it may extend are those that extend nothing, so not production-scheduler
    expect(c024(sabotageHinting('project.json', naming('production-worker')))).toEqual([
      'C024 name another declared profile: live, local, production',
    ]);
    // a chain resolves one step, to the scheduler as it is written
    const chain = naming('production-scheduler');
    expect(c024(sabotagePointing('project.json', chain))).toEqual([at]);
    expect(c024(sabotageSaying('project.json', chain))).toEqual([
      "C024 profile 'production-worker' extends 'production-scheduler', which extends 'production'; a profile extends one that extends nothing",
    ]);
    expect(c024(sabotageHinting('project.json', chain))).toEqual([
      "C024 extend 'production' directly and write what 'production-scheduler' changes, or remove extends from 'production-scheduler'",
    ]);
  });
  it('C024 two profiles that extend each other, each at its own extends, each told to remove one', () => {
    const cycle = (doc: any) => {
      doc.profiles['production-worker'].extends = 'production-scheduler';
      doc.profiles['production-scheduler'].extends = 'production-worker';
    };
    const each = (lines: string[]) => new Set(c024(lines));
    expect(each(sabotagePointing('project.json', cycle))).toEqual(
      new Set([
        'C024 @project.json#profiles/production-worker/extends',
        'C024 @project.json#profiles/production-scheduler/extends',
      ]),
    );
    expect(each(sabotageSaying('project.json', cycle))).toEqual(
      new Set([
        "C024 profile 'production-worker' extends 'production-scheduler', which extends 'production-worker'; a profile extends one that extends nothing",
        "C024 profile 'production-scheduler' extends 'production-worker', which extends 'production-scheduler'; a profile extends one that extends nothing",
      ]),
    );
    expect(each(sabotageHinting('project.json', cycle))).toEqual(
      new Set([
        "C024 remove extends from 'production-worker', or remove extends from 'production-scheduler'",
        "C024 remove extends from 'production-scheduler', or remove extends from 'production-worker'",
      ]),
    );
  });
  it('C018 a child mapping an inherited stand-in to itself, refused once, at its own line', () => {
    const employees = '@connections/employees.connection.json';
    const mapped = (doc: any) => {
      doc.profiles['production-worker'].connections = { [employees]: employees };
    };
    expect(sabotagePointing('project.json', mapped)).toEqual([
      'C018 @project.json#profiles/production-worker/connections',
    ]);
  });
});
