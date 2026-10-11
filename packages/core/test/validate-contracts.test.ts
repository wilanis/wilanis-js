/** The fields of a contract: where a type comes from (resolves), and what the compiler provides (provided). */
import { describe, expect, it } from 'vitest';
import { at, doc, refused } from './documents.js';

describe('a contract that says where a type comes from', () => {
  const port = (resolves: unknown) =>
    doc('port', {
      operations: {
        get: {
          description: 'one record of a collection',
          accepts: {
            store: { type: 'string', static: true, resolves },
            collection: { type: 'string', static: true },
          },
          returns: '$T',
        },
      },
    });

  it('a port document carrying resolves validates, with a substitution and without', () => {
    expect(refused(port({ $T: 'collections[collection].of' }))).toEqual([]);
    expect(refused(port({ $T: 'shape' }))).toEqual([]);
    expect(refused(port({ $T: 'collections[collection].of', $K: 'collections[collection].key' }))).toEqual([]);
  });

  it('a malformed path does not: the grammar is field names, a segment optionally taking a key', () => {
    const grammar = 'The path within the named document whose value is the type';
    expect(refused(port({ $T: 'collections[collection]of' }))).toEqual([
      at('operations/get/accepts/store/resolves/$T', grammar),
    ]);
    expect(refused(port({ $T: '.of' }))).toEqual([at('operations/get/accepts/store/resolves/$T', grammar)]);
    expect(refused(port({ $T: 'collections[Collection].of' }))).toEqual([
      at('operations/get/accepts/store/resolves/$T', grammar),
    ]);
    expect(refused(port({ $T: 'collections[collection][of]' }))).toEqual([
      at('operations/get/accepts/store/resolves/$T', grammar),
    ]);
    expect(refused(port({ $T: '' }))).toEqual([at('operations/get/accepts/store/resolves/$T', grammar)]);
  });

  it('what it binds is a type variable, and it binds at least one', () => {
    expect(refused(port({ T: 'collections[collection].of' }))).toEqual([
      at('operations/get/accepts/store/resolves', "property name 'T'"),
    ]);
    expect(refused(port({}))).toEqual([at('operations/get/accepts/store/resolves', 'fewer than 1 properties')]);
  });
});

describe('a field the compiler provides', () => {
  const port = (site: Record<string, unknown>) =>
    doc('port', {
      operations: {
        record: {
          description: 'one',
          accepts: { text: { type: 'string' }, site: { type: '@std/Site.shape.json', ...site } },
        },
      },
    });

  it('provided: "site" is accepted on a field of a native contract, and site is the one word it takes', () => {
    expect(refused(port({ provided: 'site' }))).toEqual([]);
    expect(refused(port({ provided: 'run' }))).toEqual([at('operations/record/accepts/site/provided', '"site"')]);
    expect(refused(port({ provided: true }))).toEqual([at('operations/record/accepts/site/provided', '"site"')]);
  });
});
