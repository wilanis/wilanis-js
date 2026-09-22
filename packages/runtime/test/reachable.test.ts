/**
 * What a trigger reaches, over the example. `operationsReachable`, `refusalsReachable` and `effectsReachable`
 * are one walk read three ways: from an operation, through the binding that meets it, into the graph it runs
 * or the operation it delegates to, and on through every domain call. The reasons are what T005 and A002 are
 * judged against; the operations are what an invariant over a port is (RFC 0007, step 2); the effects are the
 * native sites the walk ends at, which RFC 0011's retry rules and RFC 0015's A0n2 are judged over.
 *
 * The case the RFC states is `POST /customers.csv`: it fires `#import`, whose domain graph records every row
 * of the file through `#registerAll`, which is bound to a graph mapping `#submit`, which is bound to a graph
 * running `#register`. Nothing in the trigger names `#register`, and a rule that gates writes has to hold it to
 * the same gate anyway -- so the walk has to be transitive, and has to be made under each profile, since
 * which graph meets `#registerAll` is what a profile chooses.
 *
 * It lives here rather than in `packages/compiler/test` because the claim is about the example tree, and
 * loading that needs every plugin it names: the compiler depends on core and engine alone.
 */
import { effectsOfGraph, effectsReachable, operationsReachable, refusalsReachable } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const scope = new Scope(load.registry, load.resolve);

const MONITOR = '@features/customers/domain/customer.port.json';
const PROFILES = ['live', 'local', 'production'];

/** Every domain operation the tree declares, as `path#operation`: what a walk over the whole tree is made of. */
const EVERY_OPERATION = load.registry
  .all('port')
  .filter(port => !port.native)
  .flatMap(port => Object.keys(port.doc.operations).map(op => `${port.path}#${op}`));

/** The operations one operation reaches under one profile, named as a reader writes them: `#operation`. */
const reaches = (opRef: string, profile: string): string[] =>
  operationsReachable(scope, opRef, profile).map(one => one.key.replace(`${MONITOR}#`, '#'));

/** What one reached operation says it was reached through, or nothing where the walk started at it. */
const through = (opRef: string, target: string, profile: string): string | undefined =>
  operationsReachable(scope, opRef, profile)
    .find(one => one.key === `${MONITOR}#${target}`)
    ?.through?.replace(`${MONITOR}#`, '#');

describe('operationsReachable: what an operation calls', () => {
  it('answers the operation it was asked about, which is reached by being fired', () => {
    expect(reaches(`${MONITOR}#register`, 'local')).toContain('#register');
  });

  it.each(PROFILES)('reaches #register from #import transitively, under %s', profile => {
    // import -> import-customers.graph -> #registerAll -> register-all|register-each.graph -> #submit
    //        -> register-customer.graph -> #register. Three bindings deep, and no document of the edge names it.
    expect(reaches(`${MONITOR}#import`, profile)).toEqual([
      '#import',
      '#parseDrafts',
      '#registerAll',
      '#submit',
      '#register',
    ]);
  });

  it('says which operation #register was reached through, so a refusal need not be walked by hand', () => {
    expect(through(`${MONITOR}#import`, 'register', 'local')).toBe('#submit');
    expect(through(`${MONITOR}#import`, 'registerAll', 'local')).toBe('#import');
  });

  it('says nothing was reached through the operation the walk started at', () => {
    expect(through(`${MONITOR}#import`, 'import', 'local')).toBeUndefined();
  });

  it('follows the profile, since a profile chooses which graph meets an operation', () => {
    // #registerAll is bound to register-each under live and register-all under local: both map #submit, and the
    // walk arrives at #register either way. A rule about the port cannot be answered under one profile alone.
    expect(reaches(`${MONITOR}#registerAll`, 'live')).toEqual(['#registerAll', '#submit', '#register']);
    expect(reaches(`${MONITOR}#registerAll`, 'local')).toEqual(['#registerAll', '#submit', '#register']);
  });

  it('records no native operation: a native port is not a way into the domain', () => {
    // parse-drafts.graph runs @blob operations, and create-row.graph runs @http's #request
    const reached = operationsReachable(scope, `${MONITOR}#import`, 'live').map(one => one.key);
    expect(reached.every(key => key.startsWith(MONITOR))).toBe(true);
    expect(operationsReachable(scope, '@http/http.port.json#request', 'live')).toEqual([]);
  });

  it.each(PROFILES)('ends at a graph already walked rather than recurring, under %s', profile => {
    // every domain operation the tree declares: a walk that did not stop at a graph it had walked would
    // not return at all, so that this answers is the claim
    for (const opRef of EVERY_OPERATION) expect(() => operationsReachable(scope, opRef, profile)).not.toThrow();
    expect(EVERY_OPERATION.length).toBeGreaterThan(0);
  });
});

describe('operationsReachable: what it is not', () => {
  it('does not walk a policy, which is the gate and not a way in', () => {
    // POST /customers.csv attaches can-register, whose decide.run is @access/domain/access.port.json#requireRegistrar.
    // The walk is from what the trigger fires, so the policy's own operations are not among what it reaches.
    const reached = operationsReachable(scope, `${MONITOR}#import`, 'local').map(one => one.key);
    expect(reached.some(key => key.includes('access.port.json'))).toBe(false);

    // and asked about the policy's operation directly it answers that one, so what is left out is the
    // walking of it from a trigger, not the ability to walk it at all
    const policy = operationsReachable(scope, '@access/domain/access.port.json#requireRegistrar', 'local');
    expect(policy[0]?.key).toBe('@features/access/domain/access.port.json#requireRegistrar');
  });
});

describe('refusalsReachable: the same walk, read for reasons', () => {
  it('still answers what an import can refuse with, unchanged by the factoring', () => {
    const reasons = refusalsReachable(scope, `${MONITOR}#import`, 'live').map(one => one.reason);
    expect(reasons).toContain('upstream');
  });

  it('answers a native operation with nothing, as it did', () => {
    expect(refusalsReachable(scope, '@http/http.port.json#request', 'live')).toEqual([]);
  });
});

describe('effectsReachable: the same walk, read for what it ends at', () => {
  /** The native sites one operation reaches under one profile, named as a reader writes them. */
  const effects = (opRef: string, profile: string): string[] =>
    effectsReachable(scope, opRef, profile).map(one => one.key);

  it('answers the native sites an import reaches, and no domain operation among them', () => {
    // A domain operation is a way on, never an effect: what does the work is the native site its
    // bindings reach. #import, #parseDrafts, #registerAll, #submit and #register are what the walk passed
    // through, and none of them is here.
    const reached = effects(`${MONITOR}#import`, 'local');
    expect(reached).toContain('@storage/store.port.json#put');
    expect(reached.some(key => key.includes('customer.port.json'))).toBe(false);
  });

  it('answers what the profile binds, so the same operation reaches a different effect', () => {
    // The claim A0n2 rests on: which native site a run reaches is the profile's choice. Under live
    // #register is met by a graph calling the upstream API; under local by one writing the store.
    expect(effects(`${MONITOR}#import`, 'live')).toContain('@http/http.port.json#request');
    expect(effects(`${MONITOR}#import`, 'live')).not.toContain('@storage/store.port.json#put');
    expect(effects(`${MONITOR}#import`, 'local')).toContain('@storage/store.port.json#put');
    expect(effects(`${MONITOR}#import`, 'local')).not.toContain('@http/http.port.json#request');
  });

  it('carries the values given at the site, as the document writes them', () => {
    // What a rule about an effect reads: RFC 0015's collectionOf finds a scoped collection by the
    // static store and collection of a storage site, and RFC 0011's G0n2 an idempotency key the same way.
    const put = effectsReachable(scope, `${MONITOR}#register`, 'local').find(
      one => one.key === '@storage/store.port.json#put' && one.node === 'stored',
    );
    expect(put?.given).toMatchObject({
      store: '@customers/data/customers.store.json',
      collection: 'customers',
    });
  });

  it('names a different store under a profile that binds one, at the same node', () => {
    // The per-profile half of the same claim, on the values rather than the sites: the node is the one
    // document's, and what it is over is the profile's.
    const under = (profile: string): unknown =>
      effectsReachable(scope, `${MONITOR}#register`, profile).find(one => one.node === 'stored')?.given?.store;
    expect(under('local')).toBe('@customers/data/customers.store.json');
    expect(under('production')).toBe('@customers/data/customers-postgres.store.json');
  });

  it('says where each site is written and what it was reached through', () => {
    // A rule that names a profile names these too, so a refusal need not be walked by hand.
    const site = effectsReachable(scope, `${MONITOR}#import`, 'local').find(one => one.node === 'stored');
    expect(site?.file).toContain('store-and-latest.graph.json');
    expect(site?.through).toBe(`${MONITOR}#register`);
  });

  it('leaves through undefined where the walk started in the graph that holds the site', () => {
    // effectsOfGraph is for a reader who has the graph rather than the operation it answers -- it takes the
    // canonical path, as refusalsOfGraph does. Nothing led there, so nothing is named as having led there.
    const sites = effectsOfGraph(scope, scope.canon('@customers/data/store-and-latest.graph.json'), 'local');
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) expect(site.through).toBeUndefined();
  });

  it('answers a refusing site with nothing, since a refusal is a reason and not an effect', () => {
    // The two readings of the walk do not overlap: @std/refuse is where a reason is read, and it is
    // not something the run does to the world.
    const reached = effects(`${MONITOR}#import`, 'live');
    expect(reached.some(key => key.includes('refuse'))).toBe(false);
    expect(refusalsReachable(scope, `${MONITOR}#import`, 'live').map(one => one.reason)).toContain('upstream');
  });

  it.each(PROFILES)('answers every operation of the tree without throwing, under %s', profile => {
    for (const opRef of EVERY_OPERATION) expect(() => effectsReachable(scope, opRef, profile)).not.toThrow();
  });
});
