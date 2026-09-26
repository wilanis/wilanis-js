/**
 * RFC 0008, step 3, on the smallest trees that show it: a plugin whose docs/ are of a version this runtime does not
 * read is refused by the same rule as a tree's own document (D013), at each document it ships; an include is read as
 * the loader reads it, its project.json and the features taken from it and nothing else; a tree wholly of one
 * such version is refused document by document and mixes nothing; the alias is the version this runtime reads; and a
 * tree either rule refuses is read no further, so nothing of it is registered.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type LoadResult, loadTree } from '../src/load.js';
import type { PluginModule } from '../src/plugin.js';
import { SCHEMA_BASE, schemaRef, schemaUrl } from '../src/published.js';

const V2 = SCHEMA_BASE.replace('/main/', '/schemas-v2/');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory written from path to document; removed after the case. */
function written(docs: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-ir-'));
  dirs.push(dir);
  for (const [file, doc] of Object.entries(docs)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(doc));
  }
  return dir;
}

const project = (schema: string, plugins: { use: string }[] = []) => ({
  $schema: schema,
  description: 'd',
  name: 't',
  plugins,
});

/** A plugin `@p` whose docs/ hold only its manifest, under the `$schema` given. */
const pluginAt = (schema: string): PluginModule => ({
  root: '@p',
  docs: written({ 'plugin.json': { $schema: schema, description: 'd', grants: {} } }),
  handlers: {},
});

/** The refusals of a load, as `code file#at`, sorted. */
const refusalsOf = (load: LoadResult) =>
  load.refusals.items.map(one => `${one.code} ${one.file}${one.at ? `#${one.at}` : ''}`).sort();

describe('the IR version rules, where a plugin ships the documents', () => {
  it('D013 a plugin whose docs/ are of a version this runtime does not read, and the tree mixes versions', () => {
    const root = written({ 'project.json': project(schemaUrl('project'), [{ use: '@p' }]) });
    const load = loadTree(root, { '@p': pluginAt(`${V2}/plugin.schema.json`) });
    expect(load.refusals.items.map(one => one.code)).toContain('D013');
    expect(refusalsOf(load)).toEqual(['D013 @p/plugin.json#$schema', 'D014 project.json']);
    expect(load.registry.files).toEqual([]);
  });

  it('none for a plugin at hand that the project does not name, since its documents are not read', () => {
    const root = written({ 'project.json': project(schemaUrl('project')) });
    expect(refusalsOf(loadTree(root, { '@p': pluginAt(`${V2}/plugin.schema.json`) }))).toEqual([]);
  });

  it('none for a plugin of the version this runtime reads', () => {
    const root = written({ 'project.json': project(schemaUrl('project'), [{ use: '@p' }]) });
    const load = loadTree(root, { '@p': pluginAt(schemaUrl('plugin')) });
    expect(refusalsOf(load)).toEqual([]);
    expect(load.registry.get('plugin', '@p/plugin.json')).toBeDefined();
  });
});

describe('the IR version rules, where an include ships the documents', () => {
  it('D013 at the project.json of an include and at each feature taken from it, and none at a feature not taken', () => {
    const root = written({ 'project.json': project(schemaUrl('project')) });
    const thing = { $schema: `${V2}/shape.schema.json`, description: 'd' };
    const dir = written({
      'project.json': project(`${V2}/project.schema.json`),
      'features/g/domain/Thing.shape.json': thing,
      'features/h/domain/Thing.shape.json': thing,
    });
    const load = loadTree(root, {}, [{ from: '@i', dir, features: ['g'] }]);
    expect(refusalsOf(load)).toEqual([
      'D013 @i/project.json#$schema',
      'D013 features/g/domain/Thing.shape.json#$schema',
      'D014 project.json',
    ]);
  });
});

describe('the IR version rules, over a tree of one version', () => {
  it('D013 at every document of a tree wholly of a version this runtime does not read, and no D014', () => {
    const root = written({
      'project.json': project(`${V2}/project.schema.json`),
      'features/f/domain/Thing.shape.json': { $schema: `${V2}/shape.schema.json`, description: 'd' },
    });
    const load = loadTree(root, {});
    expect(refusalsOf(load)).toEqual(['D013 features/f/domain/Thing.shape.json#$schema', 'D013 project.json#$schema']);
    expect(load.registry.files).toEqual([]);
  });

  it('none where the alias stands beside the published URL of the version this runtime reads', () => {
    const root = written({
      'project.json': project(schemaRef('project')),
      'features/f/domain/Thing.shape.json': {
        $schema: schemaUrl('shape'),
        description: 'd',
        layer: 'core',
        fields: {},
      },
    });
    expect(refusalsOf(loadTree(root, {})).filter(one => /^D01[34] /.test(one))).toEqual([]);
  });
});
