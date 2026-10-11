/**
 * A literal `[]` (issue #903): it types as the empty list, which feeds a list of any type, while a literal list
 * with items keeps the type of its members and a mixed one stays a list of unknown.
 */
import { describe, expect, it } from 'vitest';
import { assignable, edges, generate, rng, substitute, TypeResolver, typeOfValue, unify } from '../src/index.js';
import { EMPTY_LIST, NUMBER, STRING, type Type, UNKNOWN } from '../src/types.js';
import { valueRead } from '../src/value-reads.js';

const types = new TypeResolver(() => undefined);
const account = types.inline({ fields: { id: { type: 'string' } } });
const accounts: Type = { kind: 'list', of: account };
const literal = (value: unknown) => valueRead(value, () => ({ type: STRING, optional: false }));
const typed = (value: unknown) => {
  const read = literal(value);
  if (typeof read !== 'object') throw new Error(`not typed: ${read}`);
  return read.type;
};

describe('the type of a literal empty list', () => {
  it('is the empty list, read as a value or as a literal a document writes', () => {
    expect(typeOfValue([])).toEqual(EMPTY_LIST);
    expect(typed([])).toEqual(EMPTY_LIST);
  });
  it('feeds a list of a shape, of a scalar, and of lists, at any depth', () => {
    expect(assignable(typed([]), accounts)).toBeNull();
    expect(assignable(typed([]), { kind: 'list', of: NUMBER })).toBeNull();
    expect(assignable(typed([[]]), { kind: 'list', of: accounts })).toBeNull();
    const holding: Type = { kind: 'object', fields: { users: { type: accounts, required: true } }, open: false };
    expect(assignable(typed({ users: [] }), holding)).toBeNull();
  });
  it('still feeds only a list', () => {
    expect(assignable(typed([]), account)).toBe('unknown[] is not {id: string}');
    expect(assignable(typed([]), STRING)).toBe('unknown[] is not string');
  });
  it('is fed by nothing but an empty list, since its one value has no items', () => {
    expect(assignable(accounts, EMPTY_LIST)).toBe('{id: string}[] is not an empty list');
    expect(assignable(EMPTY_LIST, EMPTY_LIST)).toBeNull();
  });
});

describe('the type of a literal list with items', () => {
  it('keeps the type of its members, and a mixed one stays a list of unknown', () => {
    expect(typeOfValue([1, 2])).toEqual({ kind: 'list', of: NUMBER });
    expect(typeOfValue(['a', 'b'])).toEqual({ kind: 'list', of: STRING });
    expect(typeOfValue([1, 'a'])).toEqual({ kind: 'list', of: UNKNOWN });
    expect(assignable(typeOfValue([1, 'a']), accounts)).toBe('unknown cannot feed {id: string}');
    expect(assignable(typed([{ id: 'a' }]), accounts)).toBeNull();
    expect(assignable(typed([{ id: 1 }]), accounts)).toBe("field 'id': number is not string");
  });
  it('takes its type from a member that is not an empty list', () => {
    expect(typeOfValue([[], [1]])).toEqual({ kind: 'list', of: { kind: 'list', of: NUMBER } });
    expect(typed([[], ['{{x}}']])).toEqual({ kind: 'list', of: { kind: 'list', of: STRING } });
    expect(assignable(typed([[], [1]]), { kind: 'list', of: { kind: 'list', of: STRING } })).toBe(
      'number is not string',
    );
    expect(typeOfValue([[], []])).toEqual({ kind: 'list', of: EMPTY_LIST });
  });
});

describe('an empty list where a contract has a variable', () => {
  const list = (of: Type): Type => ({ kind: 'list', of });
  const variable: Type = { kind: 'var', name: '$T' };
  it('binds nothing through a list of the variable, so another argument binds it', () => {
    const subst: Record<string, Type> = {};
    expect(unify(list(variable), EMPTY_LIST, subst)).toBeNull();
    expect(subst).toEqual({});
    expect(unify(list(variable), accounts, subst)).toBeNull();
    expect(substitute(list(variable), subst)).toEqual(accounts);
  });
  it('gives way to a list with items where the variable is the whole list', () => {
    const first: Record<string, Type> = {};
    expect(unify(variable, EMPTY_LIST, first)).toBeNull();
    expect(unify(variable, accounts, first)).toBeNull();
    expect(first.$T).toEqual(accounts);
    const second: Record<string, Type> = {};
    expect(unify(variable, accounts, second)).toBeNull();
    expect(unify(variable, EMPTY_LIST, second)).toBeNull();
    expect(second.$T).toEqual(accounts);
  });
});

describe('generating a value of the empty list', () => {
  it('generates no item, and takes no edge with one', () => {
    for (let seed = 1; seed < 20; seed++) expect(generate(EMPTY_LIST, rng(seed))).toEqual([]);
    expect(edges(EMPTY_LIST).map(edge => edge.name)).toEqual(['empty']);
  });
});
