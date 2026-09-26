/**
 * What `describe` says a trigger reaches follows the profiles that serve it, as the checker's judgement of the
 * trigger does (#632): the triggers a store's scope counts (A006's list) and the ways into an access invariant
 * (I001's) are walked under the profiles that walk each trigger, so a reader is never told what a route reaches
 * under a profile that never listens. On the example as it ships the profiles that listen bind as the ones that
 * do not, so the output would not move; each case takes `local` out of the listener instead, and `local` is the
 * one profile that keeps the customers in memory. It still consumes the queue and runs the commands.
 */
import { describe, expect, it } from 'vitest';
import { describe as describeDoc } from '../src/index.js';
import { type Edits, scopedTree } from './scoping-harness.js';

const LISTEN = '@http/server.port.json#listen';
/** The example with `local` left out of the listener: its routes are served under live and production alone. */
const LOCAL_QUIET: Edits = {
  'project.json': (project: any) => {
    const listen = project.startup.find((step: any) => step.run === LISTEN);
    listen.profiles = listen.profiles.filter((one: string) => one !== 'local');
  },
};
/** The lines of one document's description, of a copy of the example with the edits a case asks for. */
const said = (path: string, edits: Edits) => scopedTree(load => describeDoc(load, path), edits).split('\n');

describe('describe: what a trigger reaches, under the profiles that serve it', () => {
  it("counts at a store's scope only the triggers that reach it where they are served", () => {
    // only local keeps the customers in memory, so once it opens no route the one trigger it serves that
    // reaches the collection is the queue's removal; the routes reach the other stores where they are served
    const scoped = (edits: Edits) =>
      said('@customers/data/customers.store.json', edits).filter(line => line.includes('guaranteed at'));
    expect(scoped({})).toEqual([
      '    scoped by   tenant ← {{tenant}}  (guaranteed at 9 trigger(s) by Employees only, Can register, Signed in)',
    ]);
    expect(scoped(LOCAL_QUIET)).toEqual([
      '    scoped by   tenant ← {{tenant}}  (guaranteed at 1 trigger(s) by Employees only, Can register)',
    ]);
  });

  it('names no way into an invariant that only a profile not serving the trigger reaches', () => {
    // local's store binding meets get with the update graph, which keeps the customer: the get route then reaches
    // #keep under local and nowhere else, so it is a way in only while local listens -- where I001 refuses it
    const getKeeps: Edits = {
      'features/customers/data/customers-store.binding.json': (doc: any) => {
        doc.operations.get = { graph: '@customers/domain/update-customer.graph.json' };
      },
    };
    const route = '@features/customers/edge/get-customer.trigger.json';
    const ways = (edits: Edits) =>
      said('@features/customers/domain/writes-are-for-registrars.invariant.json', edits).filter(line =>
        line.includes('.trigger.json  #'),
      );
    expect(ways(getKeeps)).toContain(`    ${route}  #keep (through #get)  -- met by nothing, which I001 refuses`);
    expect(ways({ ...getKeeps, ...LOCAL_QUIET }).some(line => line.includes(route))).toBe(false);
    expect(ways({ ...getKeeps, ...LOCAL_QUIET })).toHaveLength(6);
  });
});
