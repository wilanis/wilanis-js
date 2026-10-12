/**
 * A path within a bound type, as a port's page shows it (RFC 0039): a native field marked `within` is tagged with
 * the variable it is a path within and the type the path reaches, and the tag says that the checker holds it (G028).
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PAGE } from './page-harness.js';

describe("a port's page and a field that is a path within a bound type", () => {
  it('tags the field with the variable and the type it reaches', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(
      /if \(f\.within\) \{ const b = el\('span', 'tag', 'a path within ' \+ f\.within \+ \(f\.reaches \? ' to ' \+ showType\(f\.reaches\) : ''\)\);/,
    );
    expect(page).toMatch(/b\.title = 'the value is a dotted path within the type ' \+ f\.within[^\n]*\(G028\)'/);
  });
});
