/**
 * L010 over a stand-in (#653). Under the production profiles `jobs.connection.json` stands for
 * `customers-postgres.connection.json`, so an atomic graph that writes the customers and publishes a removal to
 * jobs falls on one connection there: the walk counts a connection as the one the profile reaches, as the
 * environment a handler reads keys it, since both ask `connectionUnder`. Take the stand-in away and the same graph
 * falls on two, and L010 says so under the profile that runs it.
 *
 * X405 stays in both cases, and is not this rule's: the queue plugin judges a publish in an atomic graph under the
 * tree as written as well as under every profile, and as written jobs is the in-process broker, which cannot join
 * a transaction.
 */
import { describe, expect, it } from 'vitest';
import { plantedEditingAllSaying } from './example-harness.js';
import { BOUND, BOUND_APART, PLANTED } from './stand-in-tree.js';

const CODES = (said: string[]) => said.map(one => one.split(' ')[0]);

describe('sabotage: an atomic graph whose connections a profile stands in for one another (L010)', () => {
  it('is one connection where production stands jobs in for the customer database', () => {
    const said = plantedEditingAllSaying(PLANTED, BOUND);
    expect(CODES(said)).toEqual(['X405']);
  });

  it('L010 where production keeps jobs apart, naming both connections and the profile that runs the graph', () => {
    const said = plantedEditingAllSaying(PLANTED, BOUND_APART);
    expect(said.filter(one => one.startsWith('L010'))).toEqual([
      "L010 atomic graph reaches effects on 2 connections (@connections/customers-postgres.connection.json, @connections/jobs.connection.json) (profile 'production')",
    ]);
    // and production's permits do not list the in-process broker it now reaches (C021)
    expect(CODES(said)).toEqual(['C021', 'L010', 'X405']);
  });
});
