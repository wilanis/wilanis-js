/**
 * The plugin as the runtime meets it: what it grants, and that what it grants is a file a reader can open
 * rather than an object in code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import otel from '../src/index.js';
import { EXPORT, PORT } from '../src/paths.js';

/** A document this plugin ships, read from the directory it publishes. */
const shipped = (name: string) => JSON.parse(readFileSync(join(otel.docs, name), 'utf8'));

describe('what the plugin grants', () => {
  it('one port, one handler, its documents under docs/, and rules of its own', () => {
    expect(otel.root).toBe('@otel');
    expect(Object.keys(otel.handlers)).toEqual([EXPORT]);
    expect(otel.docs).toMatch(/docs$/);
    expect(otel.check).toBeTypeOf('function');
    // it identifies nobody and fires nothing: the exporter only ever listens
    expect(otel.guard).toBeUndefined();
    expect(otel.triggers).toBeUndefined();
  });

  it('the manifest grants the port the handler answers, so a reader can open what the DSL names', () => {
    expect(shipped('plugin.json').grants.ports).toEqual([PORT]);
  });

  it('export is a holds operation, which is what puts it in a startup list and out of a graph', () => {
    const operation = shipped('exporter.port.json').operations.export;
    expect(operation.holds).toBe(true);
    expect(Object.keys(operation.returns.fields).sort()).toEqual(['endpoint', 'service']);
  });

  it('the settings a project may pass are declared, so `wilanis describe` can say what they are', () => {
    const fields = shipped('plugin.json').settings.fields;
    expect(Object.keys(fields).sort()).toEqual(['endpoint', 'headers', 'level', 'service']);
    // what must be said, and what may be left out
    expect(fields.endpoint.required).toBeUndefined();
    expect(fields.level.required).toBe(false);
  });
});
