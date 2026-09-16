/**
 * What a trigger reaches, over the example. `operationsReachable` and `refusalsReachable` are one walk read
 * two ways: from an operation, through the binding that meets it, into the graph it runs or the operation it
 * delegates to, and on through every domain call. The reasons are what T005 and A002 are judged against; the
 * operations are what an invariant over a port will be (RFC 0007, step 2).
 *
 * The case the RFC states is `POST /monitor.csv`: it fires `#import`, whose domain graph records every row
 * of the file through `#recordAll`, which is bound to a graph mapping `#submit`, which is bound to a graph
 * running `#record`. Nothing in the trigger names `#record`, and a rule that gates writes has to hold it to
 * the same gate anyway -- so the walk has to be transitive, and has to be made under each profile, since
 * which graph meets `#recordAll` is what a profile chooses.
 *
 * It lives here rather than in `packages/compiler/test` because the claim is about the example tree, and
 * loading that needs every plugin it names: the compiler depends on core and engine alone.
 */
import { operationsReachable, refusalsReachable } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const scope = new Scope(load.registry, load.resolve);

const MONITOR = '@features/monitor/domain/monitor.port.json';
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
    expect(reaches(`${MONITOR}#record`, 'local')).toContain('#record');
  });

  it.each(PROFILES)('reaches #record from #import transitively, under %s', profile => {
    // import -> import-entries.graph -> #recordAll -> record-all|record-each.graph -> #submit
    //        -> record-entry.graph -> #record. Three bindings deep, and no document of the edge names it.
    expect(reaches(`${MONITOR}#import`, profile)).toEqual([
      '#import',
      '#parseDrafts',
      '#recordAll',
      '#submit',
      '#record',
    ]);
  });

  it('says which operation #record was reached through, so a refusal need not be walked by hand', () => {
    expect(through(`${MONITOR}#import`, 'record', 'local')).toBe('#submit');
    expect(through(`${MONITOR}#import`, 'recordAll', 'local')).toBe('#import');
  });

  it('says nothing was reached through the operation the walk started at', () => {
    expect(through(`${MONITOR}#import`, 'import', 'local')).toBeUndefined();
  });

  it('follows the profile, since a profile chooses which graph meets an operation', () => {
    // #recordAll is bound to record-each under live and record-all under local: both map #submit, and the
    // walk arrives at #record either way. A rule about the port cannot be answered under one profile alone.
    expect(reaches(`${MONITOR}#recordAll`, 'live')).toEqual(['#recordAll', '#submit', '#record']);
    expect(reaches(`${MONITOR}#recordAll`, 'local')).toEqual(['#recordAll', '#submit', '#record']);
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
    // POST /monitor.csv attaches can-record, whose decide.run is @access/domain/access.port.json#requireRecorder.
    // The walk is from what the trigger fires, so the policy's own operations are not among what it reaches.
    const reached = operationsReachable(scope, `${MONITOR}#import`, 'local').map(one => one.key);
    expect(reached.some(key => key.includes('access.port.json'))).toBe(false);

    // and asked about the policy's operation directly it answers that one, so what is left out is the
    // walking of it from a trigger, not the ability to walk it at all
    const policy = operationsReachable(scope, '@access/domain/access.port.json#requireRecorder', 'local');
    expect(policy[0]?.key).toBe('@features/access/domain/access.port.json#requireRecorder');
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
