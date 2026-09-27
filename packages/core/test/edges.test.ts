/**
 * `edges` (RFC 0018): the fixed edge cases of a type, in field order, that `wilanis fuzz --edges` fires a trigger
 * with one at a time.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  conforms,
  type Edge,
  edges,
  LONG_EDGE,
  NUMBER,
  STRING,
  type Type,
  TypeResolver,
  typeAt,
} from '../src/index.js';

const types = new TypeResolver(() => undefined);
const EXAMPLE = fileURLToPath(new URL('../../../example/features/customers/edge/', import.meta.url));
const shapeOf = (name: string) => {
  const shape = JSON.parse(readFileSync(`${EXAMPLE}${name}.shape.json`, 'utf8'));
  return types.inline({ fields: shape.fields, open: shape.open });
};

/** Each edge as `<dotted field>.<edge>`, the way a file is named after it. */
const named = (found: Edge[]) => found.map(edge => [...edge.at, edge.name].join('.'));

describe('edges: the fixed edge cases of a type', () => {
  it("answers a string field's empty, one-character and long values", () => {
    const found = edges(shapeOf('IdRequest'));
    expect(named(found)).toEqual(['id.empty', 'id.one', 'id.long']);
    expect(found.map(edge => edge.value)).toEqual(['', 'x', 'x'.repeat(LONG_EDGE)]);
    expect(LONG_EDGE).toBe(256);
  });

  it('answers each member of an enum with no cap, and absent beside an optional field', () => {
    expect(named(edges(shapeOf('RegisterRequest')))).toEqual([
      'name.empty',
      'name.one',
      'name.long',
      'email.empty',
      'email.one',
      'email.long',
      'tier.enum.bronze',
      'tier.enum.silver',
      'tier.enum.gold',
    ]);
    expect(named(edges(shapeOf('ListRequest')))).toEqual([
      'tier.enum.bronze',
      'tier.enum.silver',
      'tier.enum.gold',
      'tier.absent',
    ]);
    const members = Array.from({ length: 40 }, (_, at) => `m${at}`);
    expect(edges({ kind: 'string', enum: members })).toHaveLength(40);
  });

  it("answers the table's rows in field order: an enum, an optional number, a boolean and a list", () => {
    const shape = types.inline({
      fields: {
        method: { type: 'string', enum: ['GET', 'POST'] },
        limit: { type: 'number', required: false },
        active: { type: 'boolean' },
        tags: { type: 'string[]', maxItems: 5 },
      },
    });
    const found = edges(shape);
    expect(found.map(edge => [edge.at.join('.'), edge.name, edge.value])).toEqual([
      ['method', 'enum.GET', 'GET'],
      ['method', 'enum.POST', 'POST'],
      ['limit', 'zero', 0],
      ['limit', 'negative', -1],
      ['limit', 'fraction', 0.5],
      ['limit', 'max', Number.MAX_SAFE_INTEGER],
      ['limit', 'absent', undefined],
      ['active', 'true', true],
      ['active', 'false', false],
      ['tags', 'empty', []],
      ['tags', 'one', [expect.any(String)]],
    ]);
    // every edge but absent is a value of the field's type, so a run fired with it is judged as any input is
    for (const edge of found.filter(one => one.name !== 'absent')) {
      const read = typeAt(shape, edge.at);
      expect(typeof read === 'string' ? read : conforms(edge.value, read.type)).toBeNull();
    }
    // a list that may hold nothing has no edge of one element
    expect(named(edges({ kind: 'list', of: { kind: 'string' }, max: 0 }))).toEqual(['empty']);
  });

  it('goes one level of object down, dotted, and leaves an object deeper than that to its absent', () => {
    const geo: Type = { kind: 'object', fields: { lat: { type: NUMBER, required: true } }, open: false };
    const address: Type = {
      kind: 'object',
      fields: { city: { type: STRING, required: true }, geo: { type: geo, required: false } },
      open: false,
    };
    // the extra keys an open object takes are not varied
    const shape: Type = { kind: 'object', fields: { address: { type: address, required: false } }, open: STRING };
    expect(named(edges(shape))).toEqual([
      'address.city.empty',
      'address.city.one',
      'address.city.long',
      'address.geo.absent',
      'address.absent',
    ]);
  });

  it("answers none for a type whose values are not the caller's to choose, and a type's own at the top", () => {
    const none: Type[] = [{ kind: 'unknown' }, { kind: 'blob' }, { kind: 'type' }, { kind: 'var', name: 'T' }];
    for (const type of none) expect(edges(type)).toEqual([]);
    expect(named(edges(shapeOf('CsvUpload')))).toEqual([]);
    expect(edges({ kind: 'boolean' })).toEqual([
      { at: [], name: 'true', value: true },
      { at: [], name: 'false', value: false },
    ]);
  });

  it('is the same every time: fixed values, and a generated element under one fixed seed', () => {
    const row: Type = { kind: 'object', fields: { id: { type: STRING, required: true } }, open: false };
    const shape: Type = {
      kind: 'object',
      fields: { rows: { type: { kind: 'list', of: row }, required: true } },
      open: false,
    };
    const [, one] = edges(shape);
    expect(one).toMatchObject({ at: ['rows'], name: 'one', value: [{ id: expect.any(String) }] });
    expect(JSON.stringify(edges(shape))).toBe(JSON.stringify(edges(shape)));
  });
});
