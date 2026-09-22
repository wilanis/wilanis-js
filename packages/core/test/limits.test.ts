/** What a document may say about how much a run takes (RFC 0012): the words, and the list bound the types judge. */
import { describe, expect, it } from 'vitest';
import { assignable, conforms, generate, rng, show, TypeResolver, toJsonSchema } from '../src/index.js';
import { NODE_MAP } from '../src/model.js';
import { at, doc, refused } from './documents.js';

describe('a document says how much', () => {
  const map = (extra: Record<string, unknown>) =>
    doc('graph', { nodes: [{ type: NODE_MAP, id: 'm', run: '@x/p.json#op', over: '{{in.list}}', ...extra }] });
  const shape = (ids: Record<string, unknown>) => doc('shape', { fields: { ids: { type: 'string[]', ...ids } } });

  it("a map's limit and concurrency are whole numbers of one or more", () => {
    expect(refused(map({ limit: 1, concurrency: 1 }))).toEqual([]);
    expect(refused(map({ limit: 0, concurrency: 0 }))).toEqual([
      at('nodes/m/limit', 'must be >= 1'),
      at('nodes/m/concurrency', 'must be >= 1'),
    ]);
    expect(refused(map({ concurrency: 2.5 }))).toEqual([at('nodes/m/concurrency', 'must be integer')]);
  });

  it("a field's maxItems is a whole number of one or more", () => {
    expect(refused(shape({ maxItems: 1 }))).toEqual([]);
    expect(refused(shape({ maxItems: 0 }))).toEqual([at('fields/ids/maxItems', 'must be >= 1')]);
    expect(refused(shape({ maxItems: '100' }))).toEqual([at('fields/ids/maxItems', 'must be integer')]);
  });

  it('a scenario may expect a cancelled run and name where it is cancelled, but not with an empty path', () => {
    const cancelled = doc('scenario', { cancelAt: 'op.asked', expect: { status: 'cancelled', nodes: {} } });
    expect(refused(cancelled)).toEqual([]);
    expect(refused(doc('scenario', { cancelAt: '' }))).toEqual([at('cancelAt', 'fewer than 1 characters')]);
    expect(refused(doc('scenario', { expect: { status: 'aborted', nodes: {} } }))).toEqual([
      at('expect/status', '"cancelled"'),
    ]);
  });
});

describe('a bounded list', () => {
  const types = new TypeResolver(() => undefined);
  const bounded = types.field({ type: 'string[]', maxItems: 2 }).type;
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `id${index}`);

  it('is a list with a most, set only where the field is a list', () => {
    expect(bounded).toEqual({ kind: 'list', of: { kind: 'string' }, max: 2 });
    expect(types.field({ type: 'string', maxItems: 2 }).type).toEqual({ kind: 'string' });
    expect(types.field({ type: 'string[]' }).type).toEqual({ kind: 'list', of: { kind: 'string' } });
  });

  it('conforms at its bound and is refused past it, at the path of the list', () => {
    expect(conforms(ids(2), bounded)).toBeNull();
    expect(conforms(ids(3), bounded)).toBe('$: at most 2 items');
    const body = types.inline({ fields: { ids: { type: 'string[]', maxItems: 100 } } });
    expect(conforms({ ids: ids(101) }, body)).toBe('$.ids: at most 100 items');
    expect(conforms({ ids: ids(100) }, body)).toBeNull();
  });

  it('is never generated past its bound', () => {
    const one = types.field({ type: 'string[]', maxItems: 1 }).type;
    for (let seed = 0; seed < 50; seed++) expect((generate(one, rng(seed)) as unknown[]).length).toBeLessThanOrEqual(1);
  });

  it('is assignable as any list is, is named as one, and says its bound in JSON Schema', () => {
    const plain = types.ref('string[]');
    expect(assignable(bounded, plain)).toBeNull();
    expect(assignable(plain, bounded)).toBeNull();
    expect(show(bounded)).toBe('string[]');
    expect(toJsonSchema(bounded)).toEqual({ type: 'array', items: { type: 'string' }, maxItems: 2 });
    expect(toJsonSchema(plain)).toEqual({ type: 'array', items: { type: 'string' } });
  });
});
