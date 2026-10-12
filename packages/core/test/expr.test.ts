import { describe, expect, it } from 'vitest';
import { check, ExprError, evaluate, parse } from '../src/expr/index.js';
import { BOOLEAN, STRING, type Type } from '../src/types.js';

const principal: Type = {
  kind: 'object',
  fields: { realm: { type: STRING, required: true }, roles: { type: { kind: 'list', of: STRING }, required: true } },
  open: false,
};

describe('membership', () => {
  it('parses `x in list`, types it boolean, and evaluates it against the list', () => {
    const parsed = parse("'admin' in p.roles");
    expect(check(parsed, { p: { type: principal } })).toEqual(BOOLEAN);
    expect(evaluate(parsed, { p: { roles: ['admin', 'x'] } })).toBe(true);
    expect(evaluate(parsed, { p: { roles: ['x'] } })).toBe(false);
    expect(evaluate(parsed, { p: {} })).toBe(false);
  });
  it('refuses a non-list on the right and a value that could never be in the list', () => {
    expect(() => check(parse("'a' in p.realm"), { p: { type: principal } })).toThrow(ExprError);
    expect(() => check(parse('1 in p.roles'), { p: { type: principal } })).toThrow(/never in/);
  });
  it('keeps `in` as an input name: in.x is a path, `in` after a value is the operator', () => {
    const parsed = parse("'admin' in in.roles");
    expect(check(parsed, { in: { type: principal } })).toEqual(BOOLEAN);
    expect(evaluate(parsed, { in: { roles: ['admin'] } })).toBe(true);
  });
});

describe('contains', () => {
  const person: Type = {
    kind: 'object',
    fields: {
      email: { type: STRING, required: true },
      note: { type: STRING, required: false },
      age: { type: { kind: 'number' }, required: true },
      roles: { type: { kind: 'list', of: STRING }, required: true },
    },
    open: false,
  };
  const inputs = { p: { type: person } };

  it('parses `text contains word`, types it boolean, and evaluates it as the text holding the word', () => {
    const parsed = parse("p.email contains '@'");
    expect(parsed).toEqual({
      kind: 'bin',
      op: 'contains',
      left: { kind: 'path', path: ['p', 'email'] },
      right: { kind: 'lit', value: '@' },
    });
    expect(check(parsed, inputs)).toEqual(BOOLEAN);
    expect(evaluate(parsed, { p: { email: 'a@b' } })).toBe(true);
    expect(evaluate(parsed, { p: { email: 'ab' } })).toBe(false);
    expect(evaluate(parsed, { p: { email: 7 } })).toBe(false);
    expect(evaluate(parse("'Ada' contains 'ada'"), {})).toBe(false);
  });
  it('refuses a left that is not a text, and a word that is not a non-empty string written in the rule', () => {
    const refused = (src: string) => () => check(parse(src), inputs);
    expect(refused("p.roles contains 'a'")).toThrow(
      "contains looks into a string, not string[] -- 'x' in list asks whether a list holds a value",
    );
    expect(refused("p.age contains 'a'")).toThrow('contains looks into a string, not number');
    expect(refused('p.email contains p.note')).toThrow(
      "contains looks for a word written in the rule, as email contains '@', not for 'p.note'",
    );
    expect(refused('p.email contains 1')).toThrow('contains looks for a string, not number');
    expect(refused("p.email contains ''")).toThrow("contains '' holds for every text; write the word to look for");
  });
  it('keeps `contains` as an input name: contains.x is a path, `contains` after a value is the operator', () => {
    const parsed = parse("contains.x contains 'a'");
    expect(parsed).toMatchObject({ op: 'contains', left: { kind: 'path', path: ['contains', 'x'] } });
    const holder: Type = { kind: 'object', fields: { x: { type: STRING, required: true } }, open: false };
    expect(check(parsed, { contains: { type: holder } })).toEqual(BOOLEAN);
    expect(evaluate(parsed, { contains: { x: 'cat' } })).toBe(true);
  });
  it('types under ! and to the right of the has() that proved the text, and refuses a text that may be missing', () => {
    expect(check(parse("!(p.email contains '@')"), inputs)).toEqual(BOOLEAN);
    expect(evaluate(parse("!(p.email contains '@')"), { p: { email: 'ab' } })).toBe(true);
    expect(check(parse("has(p.note) && p.note contains 'x'"), inputs)).toEqual(BOOLEAN);
    expect(() => check(parse("p.note contains 'x'"), inputs)).toThrow(/may be missing/);
  });
});

describe('what has() proves', () => {
  it('a read through a value that may be missing is refused alone, and allowed to the right of the has() that proved it', () => {
    const inputs = { p: { type: principal, optional: true } };
    expect(() => check(parse("p.realm == 'employee'"), inputs)).toThrow(/may be missing/);
    expect(check(parse("has(p) && p.realm == 'employee'"), inputs)).toEqual(BOOLEAN);
    expect(check(parse("has(p) && 'admin' in p.roles"), inputs)).toEqual(BOOLEAN);
    // an || proves nothing: either side may be the one that held
    expect(() => check(parse("has(p) || p.realm == 'employee'"), inputs)).toThrow(/may be missing/);
    // and the proof does not travel leftward
    expect(() => check(parse("p.realm == 'employee' && has(p)"), inputs)).toThrow(/may be missing/);
  });
});
