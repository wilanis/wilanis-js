/** What `#` addresses in a reference: an operation of a port, or a resolver of a resolvers document. */
import { describe, expect, it } from 'vitest';
import { splitOp, splitRef } from '../src/registry.js';

describe('splitRef', () => {
  it('splits a port reference into the document and the operation it addresses', () => {
    expect(splitRef('@features/monitor/domain/monitor.port.json#record')).toEqual({
      path: '@features/monitor/domain/monitor.port.json',
      op: 'record',
    });
    expect(splitRef('@std/object.port.json#make')).toEqual({ path: '@std/object.port.json', op: 'make' });
  });
  it('splits a resolver reference the same way: the document, and the name within it', () => {
    expect(splitRef('@monitor/edge/request.resolvers.json#agent')).toEqual({
      path: '@monitor/edge/request.resolvers.json',
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
