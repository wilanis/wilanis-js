/**
 * Which type changes this engine attempts, and what counting one asks the database (RFC 0017 leaves the pairs
 * to the implementation and says the suite judges them). Pure, so it runs without a database: what is under
 * test is the table itself, and `migrate.test.ts` proves the counts it leads to against a real one.
 *
 * The distinction worth pinning is the one a plan is read on: a cast that carries every value asks the
 * database nothing and the step is destructive but possible; a pair this engine refuses asks nothing either
 * and the step is refused with every value at stake. They are not the same answer.
 */
import type { FieldType } from '@wilanis/plugin-storage';
import { describe, expect, it } from 'vitest';
import { attempts, castTo, columnFor } from '../src/casts.js';

const TYPES: FieldType[] = ['string', 'number', 'boolean', 'json'];

describe('the casts a retype attempts, and the ones it refuses', () => {
  it('a type never casts to itself: there is no step at all where nothing changed', () => {
    for (const type of TYPES) expect(attempts(type, type)).toBe(false);
  });

  it('every type widens to string, and the cast carries every value, so nothing is counted', () => {
    for (const was of TYPES.filter(one => one !== 'string')) expect(castTo(was, 'string')).toBe('carries');
  });

  it('a string narrows to a number or a boolean, and the values that will not parse are counted', () => {
    expect(castTo('string', 'number')).toBe('double precision');
    expect(castTo('string', 'boolean')).toBe('boolean');
    expect(castTo('string', 'json')).toBe('jsonb');
  });

  it('a scalar reads as json, since it is one', () => {
    expect(castTo('number', 'json')).toBe('jsonb');
    expect(castTo('boolean', 'json')).toBe('jsonb');
  });

  it('json does not narrow to a scalar, and a number and a boolean do not read as each other', () => {
    expect(castTo('json', 'number')).toBe('refused');
    expect(castTo('json', 'boolean')).toBe('refused');
    expect(castTo('number', 'boolean')).toBe('refused');
    expect(castTo('boolean', 'number')).toBe('refused');
  });

  it('every type has the column this engine keeps it in, and the four are distinct', () => {
    const columns = TYPES.map(columnFor);
    expect(columns).toEqual(['text', 'double precision', 'boolean', 'jsonb']);
    expect(new Set(columns).size).toBe(4);
  });
});
