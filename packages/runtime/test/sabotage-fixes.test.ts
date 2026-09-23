/**
 * Sabotage: the fixes a refusal offers, proved by applying them (RFC 0019). A fix is offered only where
 * applying it to the sabotaged example removes the refusal; the cases below prove it rule by rule, and the
 * every-rule guard holds it for every sabotage the other suites make: each suite is run again here with the
 * checker wrapped, so every refusal any of them earns that carries `fixes` has each fix applied to a copy
 * of its tree and re-checked.
 */
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadResult, Refusal } from '@wilanis/core';
import { describe, expect, it, vi } from 'vitest';
import { codes } from './example-harness.js';
import {
  afterFixing,
  type Check,
  editing,
  readDoc,
  refusalsAfter,
  unrepaired,
  unrepairedAfter,
} from './fixes-harness.js';

/** What the wrapped checker hands the guard: whom to ask, how many fixes it saw, and what it found unrepaired. */
const guard = vi.hoisted(() => ({
  judge: undefined as undefined | ((load: LoadResult, refusals: Refusal[], check: Check) => string[]),
  offered: 0,
  unrepaired: [] as string[],
}));

vi.mock('@wilanis/compiler', async importOriginal => {
  const real = await importOriginal<typeof import('@wilanis/compiler')>();
  const checkTree = (load: LoadResult) => {
    const out = real.checkTree(load);
    const offering = out.items.filter(refusal => refusal.fixes?.length);
    if (guard.judge && offering.length) {
      guard.offered += offering.length;
      guard.unrepaired.push(...guard.judge(load, offering, real.checkTree));
    }
    return out;
  };
  return { ...real, checkTree };
});

guard.judge = unrepaired;

const FEATURE = '@features/customers/feature.json';
const REQUEST = '@http/http.port.json#request';
const ALLOW_REQUEST = { file: FEATURE, at: 'effects', add: REQUEST };

/** The customers feature without the one effect its data graphs reach over HTTP. */
const withoutRequest = editing('features/customers/feature.json', feature => {
  feature.effects = feature.effects.filter((effect: string) => effect !== REQUEST);
});

describe('sabotage: fixes', () => {
  it('L003 offers the effect added to the feature, on every refusal, graph node and binding alike', () => {
    const refusals = refusalsAfter(withoutRequest);
    expect(refusals.map(one => one.code)).toEqual(Array(9).fill('L003'));
    expect(refusals.filter(one => one.file.endsWith('.binding.json')).map(one => one.at)).toEqual([
      'operations/prepare/run',
    ]);
    for (const refusal of refusals) expect(refusal.fixes).toEqual([ALLOW_REQUEST]);
  });
  it('L003 applying the first refusal’s fix leaves nothing refused', () => {
    expect(afterFixing(withoutRequest, refusals => refusals[0].fixes?.slice(0, 1) ?? [], codes)).toEqual([]);
  });
  it('L003 applying all nine adds the effect once', () => {
    const effects = afterFixing(
      withoutRequest,
      refusals => refusals.flatMap(one => one.fixes ?? []),
      dir => readDoc(dir, FEATURE).effects,
    );
    expect(effects.filter((effect: string) => effect === REQUEST)).toHaveLength(1);
  });
  it('the guard names a fix that leaves its refusal behind', () => {
    const wrong = { file: FEATURE, at: 'effects', add: '@blob/csv.port.json#parse' };
    const said = unrepairedAfter(withoutRequest, refusals => [{ ...refusals[0], fixes: [wrong] }]);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^L003 @features\/customers\/data\/.*#nodes\/.* offers .*, which leaves it behind$/);
  });
});

describe('every rule: a fix offered in any sabotage suite repairs its refusal', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const suites = readdirSync(here).filter(
    name => /^(example|sabotage-?.*)\.test\.ts$/.test(name) && name !== 'sabotage-fixes.test.ts',
  );
  for (const suite of suites) await import(`./${suite}`);
});

describe('every rule: the guard', () => {
  it('saw fixes offered, and every one it saw repaired its refusal', () => {
    expect(guard.offered).toBeGreaterThan(0);
    expect(guard.unrepaired).toEqual([]);
  });
});
