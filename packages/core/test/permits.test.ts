/**
 * `profiles.<name>.permits` (RFC 0016): what a place allows the tree to reach, as operations, whole ports and
 * connections. The schema says only what an entry looks like and that none is written twice; what each one
 * names, and whether the profile reaches it, is the checker's (C021, C022, C023, R001).
 */
import { describe, expect, it } from 'vitest';
import { at, doc, refused } from './documents.js';

const permitting = (permits: unknown) => doc('project', { profiles: { production: { bindings: {}, permits } } });

describe('a profile permits', () => {
  it('operations as path#operation, ports and connections as path, or nothing at all', () => {
    const permits = ['@http/http.port.json#request', '@blob/csv.port.json', '@connections/api.connection.json'];
    expect(refused(permitting(permits))).toEqual([]);
    expect(refused(permitting([]))).toEqual([]);
  });
  it('refuses an entry that is neither, and one written twice', () => {
    // neither alternative matches, so each says what it would have taken
    expect(refused(permitting(['http.request']))).toEqual([
      at('profiles/production/permits/0', 'path#operation: one operation of a port'),
      at('profiles/production/permits/0', 'A document path from the root'),
    ]);
    const twice = refused(permitting(['@blob/csv.port.json', '@blob/csv.port.json']));
    expect(twice.map(([path]) => path)).toEqual(['profiles/production/permits']);
    expect(refused(permitting('@blob/csv.port.json')).map(([path]) => path)).toEqual(['profiles/production/permits']);
  });
});
