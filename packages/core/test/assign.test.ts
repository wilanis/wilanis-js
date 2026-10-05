import { describe, expect, it } from 'vitest';
import { assignable, assignableTrimmed, TypeResolver } from '../src/index.js';

const types = new TypeResolver(() => undefined);
const idOnly = types.inline({ fields: { id: { type: 'string' } } });
const closed = types.inline({ fields: { id: { type: 'string' }, note: { type: 'string', required: false } } });
const open = types.inline({ fields: { id: { type: 'string' } }, open: true });
const wider = types.inline({ fields: { id: { type: 'string' }, createdAt: { type: 'string', required: false } } });

describe('assignability into a closed object', () => {
  it('refuses an open value, which may carry a field the closed object does not declare', () => {
    expect(assignable(open, idOnly)).toBe(
      '{id: string, ...} is open and may carry fields {id: string} does not declare',
    );
  });
  it('refuses a closed value declaring a field the closed object does not', () => {
    expect(assignable(wider, closed)).toBe("field 'createdAt' is not declared in {id: string, note?: string}");
  });
  it('refuses the same below a list and a field, where the closed object sits deeper', () => {
    expect(assignable({ kind: 'list', of: open }, { kind: 'list', of: idOnly })).toContain('is open');
    const holding = (row: typeof idOnly) => ({ ...idOnly, fields: { row: { type: row, required: true } } });
    expect(assignable(holding(open), holding(idOnly))).toBe(
      "field 'row': {id: string, ...} is open and may carry fields {id: string} does not declare",
    );
  });
  it('takes a closed value of its own fields, or of fewer where none it requires is missing', () => {
    expect(assignable(idOnly, closed)).toBeNull();
    expect(assignable(closed, closed)).toBeNull();
  });
  it('leaves an open object as it was: width subtyping, extras fitting what it is open to', () => {
    const openWider = types.inline({ fields: { id: { type: 'string' }, extra: { type: 'number' } }, open: true });
    expect(assignable(openWider, open)).toBeNull();
    expect(assignable(closed, open)).toBeNull();
  });
});

describe('assignability where the run trims to what a closed object declares', () => {
  it('takes an open or wider value, since what the closed object does not declare is dropped', () => {
    expect(assignableTrimmed(open, idOnly)).toBeNull();
    expect(assignableTrimmed(wider, closed)).toBeNull();
    expect(assignableTrimmed({ kind: 'list', of: open }, { kind: 'list', of: idOnly })).toBeNull();
  });
  it('still holds every field the closed object declares', () => {
    const numbered = types.inline({ fields: { id: { type: 'number' }, extra: { type: 'string' } } });
    expect(assignableTrimmed(numbered, idOnly)).toBe("field 'id': number is not string");
    expect(assignableTrimmed(types.inline({ fields: {}, open: true }), idOnly)).toBe("missing required field 'id'");
  });
});
