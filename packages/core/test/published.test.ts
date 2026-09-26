import { describe, expect, it } from 'vitest';
import { IR_READ, irOfSchema, pageUrl, SCHEMA_BASE, schemaRef, schemaUrl } from '../src/published.js';

describe('the page of a refusal code', () => {
  it('a code of a checker family, or of a plugin this workspace ships, has one; anything else has none', () => {
    expect(pageUrl('L003')).toBe('https://github.com/wilanis/wilanis-js/blob/main/docs/refusals/L003.md');
    expect(pageUrl('X103')).toBe('https://github.com/wilanis/wilanis-js/blob/main/docs/refusals/X103.md');
    expect(pageUrl('Z001')).toBeUndefined();
    expect(pageUrl('L03')).toBeUndefined();
    expect(pageUrl('')).toBeUndefined();
  });

  it('an invariant code has one, as every other checker family does', () => {
    expect(pageUrl('I001')).toBe('https://github.com/wilanis/wilanis-js/blob/main/docs/refusals/I001.md');
    expect(pageUrl('I006')).toBe('https://github.com/wilanis/wilanis-js/blob/main/docs/refusals/I006.md');
  });
});

describe('the IR version a $schema names (RFC 0008)', () => {
  const at = (ref: string, kind: string) =>
    `https://raw.githubusercontent.com/wilanis/wilanis-js/${ref}/packages/core/schemas/${kind}.schema.json`;

  it('is the one this runtime reads for a kind under its base, and for the alias, which names none of its own', () => {
    expect(IR_READ).toBe('v1');
    expect(irOfSchema(schemaUrl('graph'))).toBe(IR_READ);
    expect(irOfSchema(schemaRef('graph'))).toBe(IR_READ);
    expect(schemaUrl('graph').startsWith(SCHEMA_BASE)).toBe(true);
  });

  it('is vN at the tag schemas-vN, whatever the kind, since another version may have kinds this one lacks', () => {
    expect(irOfSchema(at('schemas-v2', 'graph'))).toBe('v2');
    expect(irOfSchema(at('schemas-v2', 'workflow'))).toBe('v2');
    expect(irOfSchema(at('schemas-v1', 'graph'))).toBe('v1');
  });

  it('is none for what is not a wilanis schema: another host, another ref, a kind unknown under the base, no string', () => {
    expect(irOfSchema('https://example.com/port.schema.json')).toBeUndefined();
    expect(irOfSchema(at('some-branch', 'graph'))).toBeUndefined();
    expect(irOfSchema(schemaUrl('workflow' as never))).toBeUndefined();
    expect(irOfSchema(42)).toBeUndefined();
  });
});
