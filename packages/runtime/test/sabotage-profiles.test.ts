import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildEnv, reachOf } from '@wilanis/compiler';
import { Scope, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, loadedWith, plantedAll, sabotage, sabotageSaying } from './example-harness.js';

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
    expect(naming(['staging'])).toEqual(['B012']);
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
