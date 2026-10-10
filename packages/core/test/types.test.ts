import { describe, expect, it } from 'vitest';
import {
  assignable,
  BLOB,
  conforms,
  fieldClass,
  generate,
  isBlobHandle,
  rng,
  show,
  TypeResolver,
  toJsonSchema,
  typeAt,
} from '../src/index.js';

const types = new TypeResolver(() => undefined);

describe('the blob type', () => {
  it('is a type of its own: named blob, assignable only to blob and unknown', () => {
    expect(types.ref('blob')).toEqual(BLOB);
    expect(show(types.ref('blob[]'))).toBe('blob[]');
    expect(assignable(BLOB, BLOB)).toBeNull();
    expect(assignable(BLOB, { kind: 'unknown' })).toBeNull();
    expect(assignable(BLOB, { kind: 'string' })).toBe('blob is not string');
    expect(
      assignable(
        types.inline({ fields: { id: { type: 'string' }, contentType: { type: 'string' }, size: { type: 'number' } } }),
        BLOB,
      ),
    ).toContain('is not blob');
  });
  it('a value of it is the handle -- id, contentType, size, an optional filename -- and nothing else passes', () => {
    expect(isBlobHandle({ id: 'x', contentType: 'text/csv', size: 3 })).toBe(true);
    expect(conforms({ id: 'x', contentType: 'text/csv', size: 3, filename: 'a.csv' }, BLOB)).toBeNull();
    expect(conforms('bytes', BLOB)).toBe('$: expected a blob (the handle of a stored file: id, contentType, size)');
    expect(conforms({ id: 'x' }, BLOB)).toContain('expected a blob');
  });
  it("reads into a blob see the handle's fields, so {{in.file.filename}} types as an optional string", () => {
    expect(typeAt(BLOB, ['filename'])).toEqual({ type: { kind: 'string' }, optional: true });
    expect(typeAt(BLOB, ['size'])).toEqual({ type: { kind: 'number' }, optional: false });
    expect(typeAt(BLOB, ['bytes'])).toBe("no field 'bytes' in blob");
  });
  it('generates a handle under a seed, and describes itself as the handle in JSON Schema', () => {
    expect(isBlobHandle(generate(BLOB, rng(7)))).toBe(true);
    expect(toJsonSchema(BLOB)).toMatchObject({ type: 'object', required: ['id', 'contentType', 'size'] });
  });
});

describe('a field the compiler provides', () => {
  it('types as its declared type, required, and carries provided; a field that says nothing carries nothing', () => {
    const site = types.field({ type: 'string', provided: 'site' });
    expect(site).toEqual({ type: { kind: 'string' }, required: true, secret: undefined, provided: 'site' });
    expect(types.field({ type: 'string' })).not.toHaveProperty('provided');
    expect(types.inline({ fields: { site: { type: 'string', provided: 'site' } } })).toMatchObject({
      kind: 'object',
      fields: { site: { provided: 'site' } },
    });
  });
});

describe('the class of a field, as a storage engine names it', () => {
  it('is one of six words: a shape is a shape and a list a list, whatever they hold', () => {
    const classOf = (ref: string) => fieldClass(types.ref(ref));
    expect(['string', 'number', 'boolean', 'unknown'].map(classOf)).toEqual(['string', 'number', 'boolean', 'unknown']);
    expect(fieldClass(types.inline({ fields: { id: { type: 'string' } } }))).toBe('shape');
    expect(['string[]', 'number[][]', 'blob[]'].map(classOf)).toEqual(['list', 'list', 'list']);
    expect(fieldClass({ kind: 'string', enum: ['open', 'closed'] })).toBe('string');
  });
  it('is nothing for a blob, which no engine keeps, nor for a type variable or a type', () => {
    expect(fieldClass(BLOB)).toBeUndefined();
    expect(fieldClass({ kind: 'var', name: '$T' })).toBeUndefined();
    expect(fieldClass({ kind: 'type' })).toBeUndefined();
  });
});
