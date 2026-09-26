/**
 * RFC 0008, step 3: the loader's two IR version rules, judged before any other. A copy of the example with one
 * document rewritten to a `schemas-v2` URL is refused for that document's version (D013) and by nothing else -- no
 * D001 for what v1's schema makes of it, no R001 for what names it. A copy whose customers feature has moved to v2
 * while the rest stays at v1 is refused for the mix (D014), once, at the project. The alias names no version of its
 * own and is read as the one this runtime reads, so a tree writing it beside the published URL mixes nothing.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_BASE } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE,
  plantedEditingAllAt,
  plantedEditingAllSaying,
  sabotageHinting,
  sabotagePointing,
} from './example-harness.js';

const PORT = 'features/customers/domain/customer.port.json';

/** A `$schema` moved from the base this runtime reads to the tag of a version it does not. */
const toV2 = (doc: { $schema: string }) => {
  doc.$schema = doc.$schema.replace('/main/', '/schemas-v2/');
};

/** A `$schema` written in the short form, which names a kind and no version. */
const toAlias = (doc: { $schema: string }) => {
  doc.$schema = doc.$schema.replace(`${SCHEMA_BASE}/`, '@wilanis/');
};

/** The same edit to every document of the example's customers feature, by path. */
const everyCustomersDocument = (edit: (doc: { $schema: string }) => void) =>
  Object.fromEntries(
    readdirSync(join(EXAMPLE, 'features/customers'), { recursive: true, encoding: 'utf8' })
      .filter(name => name.endsWith('.json'))
      .map(name => [`features/customers/${name}`, edit]),
  );

/** The code a refusal read as `code ...` opens with. */
const codeOf = (refusal: string) => refusal.slice(0, refusal.indexOf(' '));

describe('sabotage: a document of an IR version this runtime does not read', () => {
  it('D013 a document rewritten to a schemas-v2 URL, at its $schema, and no rule but the version rules runs', () => {
    const refused = sabotagePointing(PORT, toV2);
    expect(refused.map(codeOf)).toContain('D013');
    expect(refused).toContain(`D013 ${PORT}#$schema`);
    expect(refused.map(codeOf).filter(code => code !== 'D013' && code !== 'D014')).toEqual([]);
  });

  it('D013 says the version this runtime reads, the one the document names, and the edit that fixes it', () => {
    expect(sabotageHinting(PORT, toV2)).toContain(
      `D013 this runtime reads v1; the document names v2: upgrade @wilanis/runtime, or rewrite the document against v1, its $schema under ${SCHEMA_BASE}`,
    );
  });
});

describe('sabotage: a tree that mixes IR versions', () => {
  it('D014 a tree whose customers feature names v2 and the rest v1, said once, at the project', () => {
    const edits = everyCustomersDocument(toV2);
    const refused = plantedEditingAllAt({}, edits);
    expect(refused.filter(one => codeOf(one) === 'D014')).toEqual(['D014 project.json']);
    expect(refused.filter(one => codeOf(one) === 'D013')).toHaveLength(Object.keys(edits).length);
    expect(refused.map(codeOf).filter(code => code !== 'D013' && code !== 'D014')).toEqual([]);
  });

  it('D014 names each version, how many documents name it, and one of them', () => {
    const edits = everyCustomersDocument(toV2);
    const said = plantedEditingAllSaying({}, edits).filter(one => codeOf(one) === 'D014');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(
      /^D014 the documents of this tree name more than one IR version: v1 \(\d+, [^)]+ among them\)/,
    );
    expect(said[0]).toContain(`, v2 (${Object.keys(edits).length}, features/customers/`);
  });

  it('none where the alias stands beside the published URL: the alias is the version this runtime reads', () => {
    expect(plantedEditingAllAt({}, everyCustomersDocument(toAlias))).toEqual([]);
  });
});
