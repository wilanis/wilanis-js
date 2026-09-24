/**
 * What `wilanis describe` says about a profile (RFC 0013, step 5): `describe project.json` prints a block per
 * profile from `reachOf` -- binds, stands in, reaches, holds, starts, needs -- and `describe <connection>` says
 * what a connection stands in for, or what replaces it, and under which profile.
 *
 * The example as written declares three profiles, `live` the default, and no stand-in, so a copy adds what it
 * lacks: a `staging` profile whose customers API is a stand-in reading a key of its own, and the watcher run under
 * `live` alone.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, profilesOf } from '../src/index.js';
import { copyOfExample, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const API = '@connections/customers-api.connection.json';
const STAGING_API = '@connections/customers-api-staging.connection.json';
const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

/** The example with a stand-in under `staging`, and a step run under `live` alone. */
function withStandIn(): string {
  const dir = copyOfExample();
  const api = JSON.parse(readFileSync(join(dir, 'connections/customers-api.connection.json'), 'utf8'));
  api.label = 'Customer API (staging)';
  api.settings = { ...api.settings, headers: { 'x-api-key': '{{secrets.customerKey}}' } };
  writeFileSync(join(dir, 'connections/customers-api-staging.connection.json'), JSON.stringify(api));
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  project.profiles.staging = {
    description: 'The live bindings against the staging API.',
    bindings: project.profiles.live.bindings,
    connections: { [API]: STAGING_API },
  };
  project.secrets.customerKey = 'CUSTOMERS_API_KEY';
  project.startup.find((step: any) => step.label === 'Watch for changes').profiles = ['live'];
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  return dir;
}

const dir = withStandIn();
const standing = loadTree(dir, PLUGINS, INCLUDES);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One profile's block of `describe project.json`, from its heading to the line before the next blank one. */
function block(said: string, profile: string): string[] {
  const lines = said.split('\n');
  const start = lines.findIndex(line => line.startsWith(`profile ${profile}`));
  const end = lines.indexOf('', start);
  return lines.slice(start, end < 0 ? undefined : end);
}

describe('wilanis describe project.json: a block per profile', () => {
  it('is found as project.json, the name every sentence about it uses', () => {
    expect(describeDoc(example, 'project.json').split('\n')[0]).toBe('project  @project.json');
  });

  it('says what production binds, reaches with which connection, holds, starts and needs', () => {
    const production = block(describeDoc(example, 'project.json'), 'production');
    expect(production[0]).toMatch(/^profile production {2}-- The customers in PostgreSQL/);
    expect(production).toContain(
      '  binds      @customers/domain/customer.port.json  → @customers/data/customers-postgres.binding.json',
    );
    expect(production).toContain(
      '             @storage/store.port.json#find, #get, #newKey, #patch, #put, #remove  via @connections/customers-postgres.connection.json',
    );
    expect(production).toContain(
      '             @auth/identity.port.json#verify  via @connections/people.connection.json, @connections/employees.connection.json',
    );
    expect(production).toContain('             @auth/token.port.json#issue, #refresh');
    expect(production.some(line => line.includes('@http/http.port.json#request'))).toBe(false);
    expect(production).toContain('  holds      @http/server.port.json#listen');
    expect(production.find(line => line.startsWith('  starts'))).toMatch(
      /^ {2}starts {5}Prepare the customer store · /,
    );
    expect(production).toContain(
      '  needs      CUSTOMERS_DATABASE_URL (customersDatabase, read by @connections/customers-postgres.connection.json)',
    );
    expect(production).toContain('             CUSTOMERS_JWT_SECRET (jwt, read by @auth settings)');
    expect(production.some(line => line.startsWith('  stands in'))).toBe(false);
  });

  it('marks the default on its first line, and no other profile', () => {
    const said = describeDoc(example, 'project.json');
    expect(block(said, 'live')[0]).toMatch(/^profile live {2}\(default\) {2}-- /);
    expect(block(said, 'local')[0]).not.toContain('(default)');
    expect(block(said, 'production')[0]).not.toContain('(default)');
  });

  it('says what a stand-in replaces, and reaches it in its place', () => {
    expect(checkTree(standing).items).toEqual([]);
    const said = describeDoc(standing, 'project.json');
    const staging = block(said, 'staging');
    expect(staging).toContain(`  stands in  ${API}  → ${STAGING_API}`);
    expect(staging).toContain(`             @http/http.port.json#request  via ${STAGING_API}`);
    expect(staging).toContain(`  needs      CUSTOMERS_API_KEY (customerKey, read by ${STAGING_API})`);
    expect(block(said, 'live')).toContain(`             @http/http.port.json#request  via ${API}`);
  });

  it('starts and holds under a profile only the steps that run there', () => {
    const said = describeDoc(standing, 'project.json');
    expect(block(said, 'live').find(line => line.startsWith('  starts'))).toContain('Watch for changes');
    expect(block(said, 'staging').find(line => line.startsWith('  starts'))).not.toContain('Watch for changes');
    expect(block(said, 'staging').join('\n')).not.toContain('@reload/watch.port.json#watch');
    expect(said).toContain('(under live only)  -- Watch for changes');
  });

  it('prints the unnamed profile where the project declares none', () => {
    const load = loadTree(dir, PLUGINS, INCLUDES);
    const scope = new Scope(load.registry, load.resolve);
    delete scope.project?.profiles;
    const said = describeDoc(load, 'project.json').split('\n');
    expect(said).toContain('profile  none declared: each port is met by its one binding');
    expect(said).toContain("  binds      each port's one binding");
    expect(profilesOf(scope)).toMatchObject([{ name: undefined, default: false, binds: [], standsIn: [] }]);
  });
});

describe('wilanis describe <connection>: what it stands in for, and what replaces it', () => {
  it('says the stand-in stands in for the connection the documents name, under the profile', () => {
    expect(describeDoc(standing, STAGING_API).split('\n')).toContain(`stands in for ${API} under staging`);
  });

  it('says the named connection is replaced by the stand-in, under the profile', () => {
    expect(describeDoc(standing, API).split('\n')).toContain(`replaced by ${STAGING_API} under staging`);
  });

  it('says neither of a connection no profile names', () => {
    const said = describeDoc(example, API);
    expect(said).not.toContain('stands in for');
    expect(said).not.toContain('replaced by');
  });
});
