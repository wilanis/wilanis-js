/** What `#` addresses in a reference: an operation of a port, or a resolver of a resolvers document. */
import { describe, expect, it } from 'vitest';
import { splitOp, splitRef } from '../src/registry.js';

describe('splitRef', () => {
  it('splits a port reference into the document and the operation it addresses', () => {
    expect(splitRef('@features/customers/domain/customer.port.json#register')).toEqual({
      path: '@features/customers/domain/customer.port.json',
      op: 'register',
    });
    expect(splitRef('@std/object.port.json#make')).toEqual({ path: '@std/object.port.json', op: 'make' });
  });
  it('splits a resolver reference the same way: the document, and the name within it', () => {
    expect(splitRef('@customers/edge/request.resolvers.json#agent')).toEqual({
      path: '@customers/edge/request.resolvers.json',
      op: 'agent',
    });
    expect(splitRef('@access/edge/session.resolvers.json#sid')).toEqual({
      path: '@access/edge/session.resolvers.json',
      op: 'sid',
    });
  });
  it('splits at the last #, so a path that carries one keeps it', () => {
    expect(splitRef('@a/b#c.port.json#op')).toEqual({ path: '@a/b#c.port.json', op: 'op' });
  });
  it('answers a bare path with an empty name, which is how a caller asks for the document alone', () => {
    expect(splitRef('@a/b.port.json#')).toEqual({ path: '@a/b.port.json', op: '' });
  });
  it('still answers as splitOp, the name its callers use until they are renamed', () => {
    expect(splitOp).toBe(splitRef);
    expect(splitOp('@a/b.port.json#op')).toEqual({ path: '@a/b.port.json', op: 'op' });
  });
});
