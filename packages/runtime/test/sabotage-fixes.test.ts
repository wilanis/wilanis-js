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
  planting,
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

const GET_ROW = '@features/customers/data/get-row.graph.json';
const REST = '@features/customers/data/customers-rest.binding.json';
const WRITES = '@features/customers/domain/writes-are-for-registrars.invariant.json';

/** `get-row`'s `fetched` node running `run` where it runs `@http/http.port.json#request`. */
const fetching = (run: string) =>
  editing(GET_ROW, graph => {
    graph.nodes.find((node: { id: string }) => node.id === 'fetched').run = run;
  });

/** The R001 refusals a broken copy answers: the one refusal whose fix is the claim, whatever else it cascades into. */
const r001After = (change: (dir: string) => void) => refusalsAfter(change).filter(one => one.code === 'R001');

/** A port of the customers feature whose two operations are one edit apart, so a name one edit from both is a guess. */
const KV = {
  $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/port.schema.json',
  label: 'Kv',
  description: 'Two operations one edit apart.',
  operations: { get: { description: 'Read.' }, set: { description: 'Write.' } },
};

/** The REST binding's `prepare` delegating to a misspelled `request`. */
const misdelegated = editing(REST, binding => {
  binding.operations.prepare.run = '@http/http.port.json#requet';
});

/** The registrar invariant covering a misspelled `submit`, through the alias the example writes it with. */
const miscovered = editing(WRITES, invariant => {
  invariant.access.over[4] = '@customers/domain/customer.port.json#submt';
});

describe('sabotage: R001 fixes', () => {
  for (const typo of ['requst', 'reqeust']) {
    it(`R001 '#${typo}' offers the one operation of the port within two edits, spelled as written`, () => {
      const refusals = refusalsAfter(fetching(`@http/http.port.json#${typo}`));
      const r001 = refusals.filter(one => one.code === 'R001');
      expect(r001.map(one => [one.file, one.at])).toEqual([[GET_ROW, 'nodes/fetched/run']]);
      expect(r001[0].fixes).toEqual([{ file: GET_ROW, at: 'nodes/fetched/run', set: REQUEST }]);
      expect(refusals.filter(one => !one.fixes).map(one => one.code)).toContain('G011');
    });
    it(`R001 applying the fix for '#${typo}' leaves nothing refused, the G011s with it`, () => {
      const pick = (refusals: Refusal[]) => refusals.find(one => one.code === 'R001')?.fixes ?? [];
      expect(afterFixing(fetching(`@http/http.port.json#${typo}`), pick, codes)).toEqual([]);
    });
  }
  it('R001 offers the same fix where a binding delegates, and where an invariant covers an operation', () => {
    const [delegated] = r001After(misdelegated);
    expect(delegated.fixes).toEqual([{ file: REST, at: 'operations/prepare/run', set: REQUEST }]);
    const [covered] = r001After(miscovered);
    expect(covered.fixes).toEqual([
      { file: WRITES, at: 'access/over/4', set: '@customers/domain/customer.port.json#submit' },
    ]);
  });
  it('R001 applying the fix at a binding or an invariant leaves nothing refused', () => {
    const first = (refusals: Refusal[]) => refusals.find(one => one.code === 'R001')?.fixes ?? [];
    expect(afterFixing(misdelegated, first, codes)).toEqual([]);
    expect(afterFixing(miscovered, first, codes)).toEqual([]);
  });
  it('R001 offers nothing when no operation is near, when two are, or when the port is unknown', () => {
    expect(r001After(fetching('@http/http.port.json#xyz'))[0].fixes).toBeUndefined();
    const kv = planting(
      { 'features/customers/domain/kv.port.json': KV },
      fetching('@customers/domain/kv.port.json#sit'),
    );
    const sit = r001After(kv).filter(one => one.file === GET_ROW);
    expect(sit.map(one => one.message)).toEqual([expect.stringContaining("no operation 'sit'")]);
    expect(sit[0].fixes).toBeUndefined();
    expect(r001After(fetching('@htp/http.port.json#request'))[0].fixes).toBeUndefined();
  });
  it('R001 offers nothing for a port the node may not name, since the fix would trade R001 for L005', () => {
    const [hidden] = r001After(fetching('@hello/domain/greeting.port.json#helo'));
    expect(hidden.message).toContain("no operation 'helo'");
    expect(hidden.fixes).toBeUndefined();
  });
  it('R001 offers nothing for a name of four letters or fewer two edits away, though it is the only one near', () => {
    const one = { ...KV, operations: { get: KV.operations.get } };
    const kv = planting(
      { 'features/customers/domain/kv.port.json': one },
      fetching('@customers/domain/kv.port.json#put'),
    );
    const put = r001After(kv).filter(one => one.file === GET_ROW);
    expect(put.map(one => one.message)).toEqual([expect.stringContaining("no operation 'put'")]);
    expect(put[0].fixes).toBeUndefined();
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
