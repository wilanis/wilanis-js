/**
 * What `wilanis describe` says about what a place permits (RFC 0016, step 3): `describe project.json` prints a
 * `permits` row in each profile's block, below what it reaches and holds, and `describe <native port>` and
 * `describe <connection>` say which profiles' `permits` name them.
 *
 * The example's `production` writes the list; its other profiles write none and so permit everything.
 */
import { loadTree, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc, type ProfileReach, permitsSaid, profilesOf } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

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
    for (const open of ['live', 'local', 'production-scheduler', 'production-worker'])
      expect(block(project, open)).toContain('  permits    everything (no permits)');
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
  it('names production after granted by, with the operations it names where it names some', () => {
    const storage = said('@storage/storage.port.json');
    expect(storage[storage.findIndex(line => line.startsWith('granted by')) + 1]).toBe(
      'permitted by  production (#ensure)',
    );
    expect(said('@http/server.port.json')).toContain('permitted by  production (#listen)');
  });

  it('names production alone where it permits the port whole', () => {
    expect(said('@storage/store.port.json')).toContain('permitted by  production');
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
  it('names production after the kind line and what the kind delivers', () => {
    const postgres = said(POSTGRES);
    const kind = postgres.findIndex(line => line.startsWith('kind  '));
    expect(postgres[kind + 1]).toMatch(/^delivery {2}at-least-once/);
    expect(postgres[kind + 2]).toBe('permitted by  production');
    const people = said('@connections/people.connection.json');
    expect(people[people.findIndex(line => line.startsWith('kind  ')) + 1]).toBe('permitted by  production');
  });

  it('says no profile that writes permits names a connection production replaces', () => {
    const employees = said(EMPLOYEES);
    expect(employees).toContain('permitted by  no profile that writes permits');
    expect(employees).toContain('replaced by @connections/employees-production.connection.json under production');
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
