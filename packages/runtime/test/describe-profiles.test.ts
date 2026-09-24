/**
 * What `wilanis describe` says about a profile (RFC 0013, step 5): `describe project.json` prints a block per
 * profile from `reachOf` -- binds, stands in, reaches, holds, starts, needs -- and `describe <connection>` says
 * what a connection stands in for, or what replaces it, and under which profile.
 *
 * The example says all of it as written: three profiles, `live` the default, `production` standing
 * `employees-production` in for the employee directory, and the watcher run under `live` and `local` alone.
 */
import { checkTree } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc, profilesOf } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const API = '@connections/customers-api.connection.json';
const EMPLOYEES = '@connections/employees.connection.json';
const OPERATOR = '@connections/employees-production.connection.json';
const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);

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
    expect(production[0]).toMatch(/^profile production {2}-- Behind the load balancer/);
    expect(production).toContain(
      '  binds      @customers/domain/customer.port.json  → @customers/data/customers-postgres.binding.json',
    );
    expect(production).toContain(
      '             @storage/store.port.json#find, #get, #newKey, #patch, #put, #remove  via @connections/customers-postgres.connection.json',
    );
    expect(production).toContain(
      `             @auth/identity.port.json#verify  via @connections/people.connection.json, ${OPERATOR}`,
    );
    expect(production).toContain('             @auth/token.port.json#issue, #refresh');
    expect(production.some(line => line.includes('@http/http.port.json#request'))).toBe(false);
    expect(production).toContain('  holds      @http/server.port.json#listen');
    expect(production.join('\n')).not.toContain('@reload/watch.port.json#watch');
    expect(production.find(line => line.startsWith('  starts'))).toMatch(
      /^ {2}starts {5}Prepare the customer store · /,
    );
    expect(production).toContain(
      '  needs      CUSTOMERS_DATABASE_URL (customersDatabase, read by @connections/customers-postgres.connection.json)',
    );
    expect(production).toContain('             CUSTOMERS_JWT_SECRET (jwt, read by @auth settings)');
    expect(production).toContain(
      `             CUSTOMERS_OPERATOR_PASSWORD_HASH (operatorPasswordHash, read by ${OPERATOR})`,
    );
  });

  it('marks the default on its first line, and no other profile', () => {
    const said = describeDoc(example, 'project.json');
    expect(block(said, 'live')[0]).toMatch(/^profile live {2}\(default\) {2}-- /);
    expect(block(said, 'local')[0]).not.toContain('(default)');
    expect(block(said, 'production')[0]).not.toContain('(default)');
  });

  it('says what a stand-in replaces, and reaches it in its place', () => {
    expect(checkTree(example).items).toEqual([]);
    const said = describeDoc(example, 'project.json');
    expect(block(said, 'production')).toContain(`  stands in  ${EMPLOYEES}  → ${OPERATOR}`);
    for (const laptop of ['live', 'local']) {
      expect(block(said, laptop).some(line => line.startsWith('  stands in'))).toBe(false);
      expect(block(said, laptop)).toContain(
        `             @auth/identity.port.json#verify  via @connections/people.connection.json, ${EMPLOYEES}`,
      );
    }
    expect(block(said, 'production').some(line => line.includes(`via ${EMPLOYEES}`))).toBe(false);
  });

  it('starts and holds under a profile only the steps that run there', () => {
    const said = describeDoc(example, 'project.json');
    for (const laptop of ['live', 'local']) {
      expect(block(said, laptop).find(line => line.startsWith('  starts'))).toContain('Watch for changes');
      expect(block(said, laptop)).toContain('             @reload/watch.port.json#watch');
    }
    expect(block(said, 'production').find(line => line.startsWith('  starts'))).not.toContain('Watch for changes');
    expect(said).toContain('(under live, local only)  -- Watch for changes');
  });

  it('prints the unnamed profile where the project declares none', () => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
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
    expect(describeDoc(example, OPERATOR).split('\n')).toContain(`stands in for ${EMPLOYEES} under production`);
  });

  it('says the named connection is replaced by the stand-in, under the profile', () => {
    expect(describeDoc(example, EMPLOYEES).split('\n')).toContain(`replaced by ${OPERATOR} under production`);
  });

  it('says neither of a connection no profile names', () => {
    const said = describeDoc(example, API);
    expect(said).not.toContain('stands in for');
    expect(said).not.toContain('replaced by');
  });
});
