/**
 * A broker standing in for another under a profile (RFC 0009 step 10, C018). The example's queue is written
 * against `jobs.connection.json`, the in-process broker, and under production and production-scheduler that
 * connection stands for `customers-postgres.connection.json`, the table broker of the customer database: a
 * different kind, admitted because both kinds deliver at least once, so what was judged of the queue trigger and
 * the publishing graph still holds of the connection they reach. Each case changes one thing and says the rule
 * still refuses a stand-in that would not deliver as the connection it replaces does.
 */
import { rmSync } from 'node:fs';
import { buildEnv } from '@wilanis/compiler';
import { Scope } from '@wilanis/core';
import postgres from '@wilanis/plugin-storage-postgres';
import { describe, expect, it } from 'vitest';
import { codes, EXAMPLE, loadedWith, sabotage, sabotageSaying, withBrokenPluginDoc } from './example-harness.js';

const JOBS = '@connections/jobs.connection.json';
const API = '@connections/customers-api.connection.json';
const POSTGRES_KIND = '@storage-postgres/postgres.connection-kind.json';

describe('sabotage: a broker standing in for another (C018)', () => {
  it('checks clean as written, and production reaches the table broker under the name the documents use', () => {
    expect(codes(EXAMPLE)).toEqual([]);
    const { load, dir } = loadedWith({});
    const scope = new Scope(load.registry, load.resolve);
    const kindUnder = (profile: string) =>
      (buildEnv(scope, { CUSTOMERS_DATABASE_URL: 'postgres://x' }, profile).env.connections as any)[JOBS].kind;
    expect(kindUnder('production')).toBe(POSTGRES_KIND);
    expect(kindUnder('production-scheduler')).toBe(POSTGRES_KIND);
    expect(kindUnder('local')).toBe('@queue-memory/memory.connection-kind.json');
    rmSync(dir, { recursive: true, force: true });
  });

  it('C018 the broker standing in for a connection that delivers nothing', () => {
    const said = sabotageSaying('project.json', doc => {
      doc.profiles.production.connections[JOBS] = API;
    });
    expect(said.map(one => one.split(' ')[0])).toEqual(['C018']);
    expect(said[0]).toContain('which delivers nothing, where the other delivers at-least-once');
  });

  it('C018 the broker standing in for a connection whose kind delivers otherwise', () => {
    const { codes: found } = withBrokenPluginDoc(postgres, 'postgres.connection-kind.json', kind => {
      kind.delivery = 'at-most-once';
    });
    expect(found.filter(code => code === 'C018')).toHaveLength(2);
  });

  it('C018 still refuses a connection that delivers nothing standing in for one of another kind', () => {
    expect(
      sabotage('project.json', doc => {
        doc.profiles.production.connections[API] = '@connections/customers-postgres.connection.json';
      }),
    ).toEqual(['C018']);
  });

  it('C018 a broker standing in for the store: a connection marked storage is judged as written, so it keeps its kind', () => {
    const said = sabotageSaying('project.json', doc => {
      doc.profiles.production.connections['@connections/customers-postgres.connection.json'] = JOBS;
    });
    expect(said.map(one => one.split(' ')[0])).toEqual(['C018']);
    expect(said[0]).toContain('marked storage and leases too');
  });
});
