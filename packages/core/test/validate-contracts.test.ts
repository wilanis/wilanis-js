/** The fields of a contract: where a type comes from (resolves), and what the compiler provides (provided). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateDocument } from '../src/validate.js';
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
  const Site = fileURLToPath(new URL('../../runtime/docs/std/Site.shape.json', import.meta.url));
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

  it('@std/Site.shape.json, the shape a provided site has, validates as a shape of two strings', () => {
    const site = JSON.parse(readFileSync(Site, 'utf8')) as { fields: Record<string, { type: string }> };
    expect(validateDocument(site, 'Site.shape.json')).toEqual({ kind: 'shape', refusals: [] });
    expect(Object.keys(site.fields)).toEqual(['file', 'at']);
    expect(Object.values(site.fields).map(field => field.type)).toEqual(['string', 'string']);
  });
});
