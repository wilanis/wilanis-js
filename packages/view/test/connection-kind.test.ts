/**
 * What the viewer shows of what a storage engine can do (RFC 0022, step 3): the connection-kind page draws the kind's
 * `capabilities` block as three labelled facts under its settings, the same three `wilanis describe` says on one line,
 * and a connection's page links to its kind. The page's functions are lifted from its source and run over a stand-in
 * for the DOM, since the page is one static file.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { type Drawn, drawn, lifted, PAGE, words } from './page-harness.js';
import { scopedView } from './scoped-harness.js';

const POSTGRES = '@storage-postgres/postgres.connection-kind.json';

/** The rows of the facts table one kind page draws, each as its cells' words. */
async function factsOf(capabilities: unknown): Promise<{ heading: string; rows: string[][] }> {
  const { capabilitiesEl } = await lifted('capabilitiesEl');
  const page = drawn({ tag: 'main' });
  capabilitiesEl(page, capabilities);
  const table = page.children[1] as Drawn;
  return { heading: words(page.children[0]), rows: table.children.slice(1).map(row => row.children.map(words)) };
}

describe('the connection-kind page', () => {
  it("draws the kind's block as three labelled facts", async () => {
    const { heading, rows } = await factsOf((scopedView(POSTGRES).doc as { capabilities: unknown }).capabilities);
    expect(heading).toBe('What its engine can do');
    expect(rows).toEqual([
      ['transactional DDL', 'yes', 'a migration plan applies in one transaction'],
      ['unique over', 'string, number, boolean', "the field classes a collection's unique may name"],
      ['refs', 'yes', "the engine enforces a collection's refs"],
    ]);
  });

  it('says no and none where the engine cannot', async () => {
    const { rows } = await factsOf({ transactionalDdl: false, unique: [], refs: false });
    expect(rows).toEqual([
      ['transactional DDL', 'no', 'a migration plan applies step by step'],
      ['unique over', 'none', "a collection's unique may name nothing"],
      ['refs', 'no', "the engine does not enforce a collection's refs"],
    ]);
  });

  it('draws them under the settings, and only on a kind that states them', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(
      /case 'connection-kind': \{\n[^\n]*fieldsTable\(d\.settings\.fields[^\n]*\n\s*if \(d\.capabilities\) capabilitiesEl\(page, d\.capabilities\);/,
    );
  });
});

describe('the connection page', () => {
  it('links to its kind', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(/case 'connection': \{\n[^\n]*step\('a channel of kind', link\(d\.kind\)\)/);
    expect((scopedView('@connections/customers-postgres.connection.json').doc as { kind: string }).kind).toBe(POSTGRES);
  });
});
