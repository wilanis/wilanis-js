import { describe, expect, it } from 'vitest';
import { pageUrl } from '../src/published.js';

describe('the page of a refusal code', () => {
  it('a code of a checker family, or of a plugin this workspace ships, has one; anything else has none', () => {
    expect(pageUrl('L003')).toBe('https://github.com/wilanis/wilanis-js/blob/main/docs/refusals/L003.md');
    expect(pageUrl('X103')).toBe('https://github.com/wilanis/wilanis-js/blob/main/docs/refusals/X103.md');
    expect(pageUrl('Z001')).toBeUndefined();
    expect(pageUrl('L03')).toBeUndefined();
    expect(pageUrl('')).toBeUndefined();
  });
});
