/**
 * What `wilanis describe` and `wilanis ls` say about what a storage engine can do (RFC 0022, step 3). The three facts
 * are written once, in the `capabilities` block of the kind a plugin ships; `describe` reads them off the loaded kind
 * document, never off a plugin's export, and says them on the connection a store names and on the kind itself.
 */
import { type ConnectionKindDoc, loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describeCapabilities, describe as describeDoc, ls } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const MEMORY = '@storage-memory/memory.connection-kind.json';
const POSTGRES = '@storage-postgres/postgres.connection-kind.json';
const POSTGRES_SAID = 'capabilities  transactional DDL: yes; unique over: string, number, boolean; refs: yes';

/** A storage kind stating the facts it is given, the rest of the document what any kind carries. */
const kind = (capabilities: ConnectionKindDoc['capabilities']): ConnectionKindDoc => ({
  label: 'A kind',
  description: 'A kind under test.',
  settings: { fields: {} },
  storage: true,
  capabilities,
});

describe('describeCapabilities', () => {
  it('says the three facts in the order the RFC writes them, a boolean as yes or no', () => {
    expect(describeCapabilities(kind({ transactionalDdl: true, unique: ['string', 'number'], refs: true }))).toBe(
      'transactional DDL: yes; unique over: string, number; refs: yes',
    );
    expect(describeCapabilities(kind({ transactionalDdl: false, unique: ['string'], refs: false }))).toBe(
      'transactional DDL: no; unique over: string; refs: no',
    );
  });

  it('says none where the engine constrains nothing, and nothing where the kind is not a storage kind', () => {
    expect(describeCapabilities(kind({ transactionalDdl: true, unique: [], refs: false }))).toBe(
      'transactional DDL: yes; unique over: none; refs: no',
    );
    expect(describeCapabilities(kind(undefined))).toBeUndefined();
  });
});

describe('describe: a connection', () => {
  it('says what the engine behind its kind can do, on the line under its kind', () => {
    const lines = describeDoc(example, '@connections/customers-postgres.connection.json').split('\n');
    const at = lines.indexOf(`kind  ${POSTGRES}`);
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(POSTGRES_SAID);
  });

  it("says the memory engine's block as written: it constrains every field class", () => {
    expect(describeDoc(example, '@connections/customers.connection.json')).toContain(
      'capabilities  transactional DDL: yes; unique over: string, number, boolean, shape, list, unknown; refs: yes',
    );
  });

  it('says nothing of capabilities where the kind reaches no storage engine', () => {
    expect(describeDoc(example, '@connections/customers-api.connection.json')).not.toContain('capabilities');
  });
});

describe('describe: a connection kind', () => {
  const lines = () => describeDoc(example, POSTGRES).split('\n');

  it("says the same line under the kind's settings", () => {
    const said = lines();
    const settings = said.indexOf('settings:');
    expect(settings).toBeGreaterThan(-1);
    expect(said.indexOf(POSTGRES_SAID)).toBeGreaterThan(settings);
    expect(said.slice(settings + 1, said.indexOf(POSTGRES_SAID)).every(line => line.startsWith('    '))).toBe(true);
  });

  it('keeps who granted it where it was', () => {
    expect(lines()[2]).toBe('granted by  @storage-postgres  (@wilanis/plugin-storage-postgres)');
  });

  it('says nothing of capabilities on a kind that is not a storage kind', () => {
    expect(describeDoc(example, '@http/http.connection-kind.json')).not.toContain('capabilities');
  });
});

describe('ls connection-kind', () => {
  it('lists the kind of every loaded engine plugin, as it lists every kind a plugin grants', () => {
    const listed = ls(example, 'connection-kind');
    expect(listed).toContain(`connection-kind  ${MEMORY}  (native)`);
    expect(listed).toContain(`connection-kind  ${POSTGRES}  (native)`);
  });
});
