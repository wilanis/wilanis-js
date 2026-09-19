/**
 * `reads`: what a data graph or a binding takes from the request. Each entry is a local name bound to the
 * resolver that declares it, as `@feature/edge/file.resolvers.json#name`, so a name's origin is one openable
 * path above its use. It replaces the `resolvers` header, which named a document and left the reader to
 * search it (RFC 0029).
 */
import { describe, expect, it } from 'vitest';
import { at, doc, refused } from './documents.js';

const KINDS = ['graph', 'binding'] as const;
const REF = '@features/f/edge/request.resolvers.json#agent';

describe('reads', () => {
  it.each(KINDS)('%s: each read is named by the resolver that declares it', kind => {
    expect(refused(doc(kind, { reads: { agent: REF } }))).toEqual([]);
    // two features' resolvers in one document, which the header it replaces could not say
    expect(refused(doc(kind, { reads: { agent: REF, who: '@features/g/edge/session.resolvers.json#sid' } }))).toEqual(
      [],
    );
    // the local name is usually the resolver's own, and need not be
    expect(refused(doc(kind, { reads: { caller: REF } }))).toEqual([]);
  });

  it.each(KINDS)('%s: the resolvers header it replaces is gone', kind => {
    expect(refused(doc(kind, { resolvers: '@features/f/edge/request.resolvers.json' }))).toEqual([
      at(undefined, "unknown property 'resolvers'"),
    ]);
  });

  it.each(KINDS)('%s: a value addresses one resolver, never a document', kind => {
    // without #, the entry says which document but not which of its names is meant
    expect(refused(doc(kind, { reads: { agent: '@features/f/edge/request.resolvers.json' } }))).toEqual([
      at('reads/agent', 'the resolver'),
    ]);
    // a request path is what a resolver declares, not what a reader of one writes
    expect(refused(doc(kind, { reads: { agent: "request.headers['user-agent']" } }))).toEqual([
      at('reads/agent', 'the resolver'),
    ]);
  });

  it.each(KINDS)('%s: an empty reads is a header that says nothing', kind => {
    expect(refused(doc(kind, { reads: {} }))).toEqual([at('reads', 'must NOT have fewer than 1 properties')]);
  });

  it.each(KINDS)('%s: the local name is an identifier and the value a string', kind => {
    expect(refused(doc(kind, { reads: { 'not an ident': REF } }))).toEqual([
      at('reads', "property name 'not an ident'"),
    ]);
    expect(refused(doc(kind, { reads: { agent: 3 } }))).toEqual([at('reads/agent', 'must be string')]);
  });
});
