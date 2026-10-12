/**
 * What `wilanis describe` says about what a place permits (RFC 0016, step 3): `describe project.json` prints a
 * `permits` row in each profile's block, below what it reaches and holds, and `describe <native port>` and
 * `describe <connection>` say which profiles' `permits` name them.
 *
 * The example's `production` writes the list; its other profiles write none and so permit everything. A child that
 * inherits production's list (RFC 0043) is planted, and its list is read as the checker reads it.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree, Scope, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc, type ProfileReach, permitsSaid, profilesOf } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedEditingAll, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const POSTGRES = '@connections/customers-postgres.connection.json';
const EMPLOYEES = '@connections/employees.connection.json';

/** One profile's block of `describe project.json`, from its heading to the line before the next blank one. */
function block(said: string, profile: string): string[] {
  const lines = said.split('\n');
  const start = lines.findIndex(line => line.startsWith(`profile ${profile}`));
  const end = lines.indexOf('', start);
  return lines.slice(start, end < 0 ? undefined : end);
}

/** The lines of `describe <ref>` over the example, or over another load of it. */
const said = (ref: string, load = example) => describeDoc(load, ref).split('\n');

/** The example loaded afresh with every profile's `permits` taken away, as a tree written before RFC 0016. */
function withoutPermits() {
  const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
  for (const profile of Object.values(load.registry.project?.doc.profiles ?? {})) delete profile.permits;
  return load;
}

describe('wilanis describe project.json: what each profile permits', () => {
  it('counts under production what its entries permit of the reach printed above them', () => {
    const production = block(describeDoc(example, 'project.json'), 'production');
    const permits = production.findIndex(line => line.startsWith('  permits'));
    expect(production[permits]).toBe('  permits    the 19 operations and 3 connections above, by 13 entries');
    // below what it reaches and what it holds, since the count covers both, and above what it starts
    expect(production.findIndex(line => line.startsWith('  holds'))).toBeLessThan(permits);
    expect(production.findIndex(line => line.startsWith('  starts'))).toBeGreaterThan(permits);
  });

  it('says a profile that writes no permits permits everything', () => {
    const project = describeDoc(example, 'project.json');
    for (const open of ['live', 'local'])
      expect(block(project, open)).toContain('  permits    everything (no permits)');
  });

  it("counts the list a profile that extends another writes as its own, not the parent's", () => {
    const project = describeDoc(example, 'project.json');
    for (const child of ['production-scheduler', 'production-worker'])
      expect(block(project, child)).toContain('  permits    the 9 operations and 1 connection above, by 7 entries');
  });

  it('counts from the same reach the block prints, and in the singular where there is one', () => {
    const scope = new Scope(example.registry, example.resolve);
    const production = profilesOf(scope).find(profile => profile.name === 'production');
    expect(production?.permits).toEqual(example.registry.project?.doc.profiles?.production.permits);
    const alone: ProfileReach = {
      name: 'alone',
      default: false,
      binds: [],
      standsIn: [],
      reaches: [],
      holds: [{ port: '@http/server.port.json', operations: ['listen'], connections: [POSTGRES] }],
      permits: ['@http/server.port.json#listen'],
      starts: [],
      needs: [],
    };
    expect(permitsSaid(alone)).toBe('the 1 operation and 1 connection above, by 1 entry');
  });
});

describe('wilanis describe <native port>: the profiles that permit it', () => {
  it('names each profile that permits it after granted by, with the operations it names where it names some', () => {
    const storage = said('@storage/storage.port.json');
    expect(storage[storage.findIndex(line => line.startsWith('granted by')) + 1]).toBe(
      'permitted by  production (#ensure), production-scheduler (#ensure), production-worker (#ensure)',
    );
    expect(said('@http/server.port.json')).toContain('permitted by  production (#listen)');
  });

  it('names a profile alone where it permits the port whole', () => {
    expect(said('@storage/store.port.json')).toContain(
      'permitted by  production, production-scheduler, production-worker',
    );
    expect(said('@blob/csv.port.json')).toContain('permitted by  production');
  });

  it('says no profile that writes permits names a port production does not permit', () => {
    expect(said('@http/http.port.json')).toContain('permitted by  no profile that writes permits');
    expect(said('@reload/watch.port.json')).toContain('permitted by  no profile that writes permits');
  });

  it('says nothing of a port no permit may name: a pure one, or a domain port', () => {
    expect(describeDoc(example, '@std/text.port.json')).not.toContain('permitted by');
    expect(describeDoc(example, '@auth/state.port.json')).not.toContain('permitted by');
    expect(describeDoc(example, '@customers/domain/customer.port.json')).not.toContain('permitted by');
  });
});

describe('wilanis describe <connection>: the profiles that permit it', () => {
  it('names each profile that permits it after the kind line, what its engine can do and what the kind delivers', () => {
    const postgres = said(POSTGRES);
    const kind = postgres.findIndex(line => line.startsWith('kind  '));
    expect(postgres[kind + 1]).toMatch(/^capabilities {2}transactional DDL/);
    expect(postgres[kind + 2]).toMatch(/^delivery {2}at-least-once/);
    expect(postgres[kind + 3]).toBe('permitted by  production, production-scheduler, production-worker');
    const people = said('@connections/people.connection.json');
    expect(people[people.findIndex(line => line.startsWith('kind  ')) + 1]).toBe('permitted by  production');
  });

  it('says no profile that writes permits names a connection production replaces', () => {
    const employees = said(EMPLOYEES);
    expect(employees).toContain('permitted by  no profile that writes permits');
    expect(employees).toContain('replaced by @connections/employees-production.connection.json under production');
  });
});

const JOBS = '@connections/jobs.connection.json';
const JOBS_STAGING = '@connections/jobs-staging.connection.json';

/** A broker of the jobs' kind, for a staging place to stand in for the jobs connection. */
const STAGING = {
  'connections/jobs-staging.connection.json': {
    $schema: schemaUrl('connection'),
    description: 'The broker a staging place works its queue on, in its own process.',
    kind: '@queue-memory/memory.connection-kind.json',
    settings: {},
  },
};

/**
 * The example with `production-staging`, a child of `production` that writes no `permits` (RFC 0043) and stands
 * `jobs-staging` in for the jobs connection, running every step production runs; `away` binds its customers and
 * its auth state where they do not reach the customer database, so only the queue's stand-in is left of it.
 */
function staging(away = false) {
  return loadedEditingAll(STAGING, {
    'project.json': (doc: any) => {
      doc.profiles['production-staging'] = { extends: 'production', connections: { [JOBS]: JOBS_STAGING } };
      for (const step of doc.startup)
        if (step.profiles?.includes('production')) step.profiles.push('production-staging');
      if (!away) return;
      doc.profiles['production-staging'].bindings = {
        '@customers/domain/customer.port.json': '@customers/data/customers-store.binding.json',
        '@auth/state.port.json': '@features/state/data/auth-files.binding.json',
      };
      const memory = doc.startup.find((step: any) => step.run.startsWith('@features/state/domain/memory'));
      memory.profiles = memory.profiles.filter((one: string) => one !== 'production-staging');
    },
  });
}

describe('wilanis describe: permits a profile inherits (RFC 0043)', () => {
  it("counts the parent's entries, and says whose they are", () => {
    const { load, dir } = staging();
    try {
      const child = block(describeDoc(load, 'project.json'), 'production-staging');
      expect(child.find(line => line.startsWith('  permits'))).toMatch(/ above, by production's 13 entries$/);
      const parent = block(describeDoc(load, 'project.json'), 'production');
      expect(parent.find(line => line.startsWith('  permits'))).toMatch(/ above, by 13 entries$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a shared target: the entry for the database permits the stand-in, and the database the child still reaches', () => {
    const { load, dir } = staging();
    try {
      expect(checkTree(load).items).toEqual([]);
      expect(said(JOBS_STAGING, load)).toContain('permitted by  production-staging');
      expect(said(POSTGRES, load)).toContain(
        'permitted by  production, production-scheduler, production-worker, production-staging',
      );
      const child = profilesOf(new Scope(load.registry, load.resolve)).find(one => one.name === 'production-staging');
      expect(child?.permits).toEqual(expect.arrayContaining([POSTGRES, JOBS_STAGING]));
      expect(child?.permitsFrom).toEqual({ profile: 'production', entries: 13 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a shared target the child no longer reaches its own way: the entry permits jobs-staging alone', () => {
    const { load, dir } = staging(true);
    try {
      expect(checkTree(load).items.filter(refusal => refusal.code === 'C022')).toEqual([]);
      expect(said(JOBS_STAGING, load)).toContain('permitted by  production-staging');
      expect(said(POSTGRES, load)).toContain('permitted by  production, production-scheduler, production-worker');
      const child = profilesOf(new Scope(load.registry, load.resolve)).find(one => one.name === 'production-staging');
      expect(child?.permits).toContain(JOBS_STAGING);
      expect(child?.permits).not.toContain(POSTGRES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('wilanis describe, where no profile writes permits', () => {
  it('prints no permitted by line, and every block permits everything', () => {
    const load = withoutPermits();
    for (const ref of ['@storage/store.port.json', '@http/http.port.json', POSTGRES, EMPLOYEES])
      expect(describeDoc(load, ref)).not.toContain('permitted by');
    expect(block(describeDoc(load, 'project.json'), 'production')).toContain('  permits    everything (no permits)');
  });
});
