/**
 * What `wilanis describe` says about a profile (RFC 0013, step 5): `describe project.json` prints a block per
 * profile from `reachOf` -- binds, stands in, reaches, holds, starts, needs -- and `describe <connection>` says
 * what a connection stands in for, or what replaces it, and under which profile.
 *
 * The example says all of it as written: three profiles, `live` the default, `production` standing
 * `employees-production` in for the employee directory, and the watcher run under `live` and `local` alone. A
 * profile that extends another (RFC 0043) is planted, since the example's profiles extend none.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc, profilesOf } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedEditing, PLUGINS } from './example-harness.js';

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
      '             @storage/store.port.json#find, #get, #newKey, #put, #remove  via @connections/customers-postgres.connection.json',
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

  it('says under production-worker what the triggers it serves reach: no sign-in, so no operator hash', () => {
    // it binds what production binds, but opens no port: the routes that sign the operator in never run there
    const worker = block(describeDoc(example, 'project.json'), 'production-worker');
    expect(worker).toContain(`  stands in  ${EMPLOYEES}  → ${OPERATOR}`);
    expect(worker.some(line => line.includes('@auth/identity.port.json#verify'))).toBe(false);
    expect(worker.some(line => line.includes('@blob/csv.port.json'))).toBe(false);
    expect(worker).toContain(
      '             @storage/store.port.json#find, #get, #put, #remove  via @connections/customers-postgres.connection.json',
    );
    expect(worker.filter(line => line.includes('CUSTOMERS_'))).toEqual([
      '  needs      CUSTOMERS_DATABASE_URL (customersDatabase, read by @connections/customers-postgres.connection.json)',
      '             CUSTOMERS_JWT_SECRET (jwt, read by @auth settings)',
    ]);
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

const PRODUCTION_BINDS = [
  '@customers/domain/customer.port.json  → @customers/data/customers-postgres.binding.json',
  '@access/domain/identity.port.json  → @features/directories/data/identity.binding.json',
];
const STATE = '@auth/state.port.json  → @features/state/data/auth-storage.binding.json';
const JOBS = '@connections/jobs.connection.json';
const POSTGRES = '@connections/customers-postgres.connection.json';

/**
 * The example with `production-worker` made a child of `production` (RFC 0043): it writes its description, its own
 * `permits` (it reaches less than production) and one binding of its own, and takes every other choice from
 * production. Answers the load and the directory to remove.
 */
function workerExtending() {
  return loadedEditing('project.json', doc => {
    const { description } = doc.profiles['production-worker'];
    doc.profiles['production-worker'] = {
      description,
      extends: 'production',
      bindings: { '@auth/state.port.json': '@features/state/data/auth-storage.binding.json' },
      permits: [
        '@storage/store.port.json',
        '@storage/storage.port.json#ensure',
        '@queue/queue.port.json#ensure',
        '@queue/worker.port.json#consume',
        '@auth/challenge.port.json#issue',
        '@otel/exporter.port.json#export',
        POSTGRES,
      ],
    };
  });
}

describe('wilanis describe: a profile that extends another (RFC 0043)', () => {
  it('names the parent on the first line, after the name and before what it says of itself', () => {
    const { load, dir } = workerExtending();
    try {
      expect(checkTree(load).items).toEqual([]);
      const said = describeDoc(load, 'project.json');
      expect(block(said, 'production-worker')[0]).toMatch(/^profile production-worker {2}extends production {2}-- A /);
      for (const alone of ['live', 'local', 'production', 'production-scheduler'])
        expect(block(said, alone)[0]).not.toContain('extends');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints the resolved choices: its own binding unmarked, every other row ending (from production)', () => {
    const { load, dir } = workerExtending();
    try {
      const said = describeDoc(load, 'project.json');
      const worker = block(said, 'production-worker');
      expect(worker.slice(1, 6)).toEqual([
        `  binds      ${STATE}`,
        ...PRODUCTION_BINDS.map(row => `             ${row}  (from production)`),
        `  stands in  ${EMPLOYEES}  → ${OPERATOR}  (from production)`,
        `             ${JOBS}  → ${POSTGRES}  (from production)`,
      ]);
      // the parent prints its own rows unmarked, and the child's reach follows the stand-ins it inherits
      expect(block(said, 'production')).toContain(`  binds      ${PRODUCTION_BINDS[0]}`);
      expect(worker.some(line => line.includes(`via ${EMPLOYEES}`) || line.includes(`via ${JOBS}`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks each inherited row with the parent in what the viewer reads, and the profile it extends', () => {
    const { load, dir } = workerExtending();
    try {
      const worker = profilesOf(new Scope(load.registry, load.resolve)).find(one => one.name === 'production-worker');
      expect(worker?.extends).toBe('production');
      expect(worker?.binds).toEqual([
        { port: '@auth/state.port.json', binding: '@features/state/data/auth-storage.binding.json' },
        {
          port: '@customers/domain/customer.port.json',
          binding: '@customers/data/customers-postgres.binding.json',
          from: 'production',
        },
        {
          port: '@access/domain/identity.port.json',
          binding: '@features/directories/data/identity.binding.json',
          from: 'production',
        },
      ]);
      expect(worker?.standsIn.map(one => one.from)).toEqual(['production', 'production']);
      expect(worker?.permitsFrom).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says of a connection what replaces it under the child too, where the stand-in is inherited', () => {
    const { load, dir } = workerExtending();
    try {
      const employees = describeDoc(load, EMPLOYEES).split('\n');
      expect(employees).toContain(`replaced by ${OPERATOR} under production`);
      expect(employees).toContain(`replaced by ${OPERATOR} under production-worker`);
      expect(describeDoc(load, OPERATOR).split('\n')).toContain(`stands in for ${EMPLOYEES} under production-worker`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
