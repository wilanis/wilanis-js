/**
 * D010 over an include's plugins (#854): a host names the plugins the features it takes from an include use, and
 * no other. A feature uses a plugin by naming one of its documents, directly or through an alias the include brings
 * along; a plugin the include names for what stays behind (its connections, a feature the host does not take) is
 * the include's business.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rootsReferenced } from '../src/include-plugins.js';
import { loadTree } from '../src/load.js';
import { schemaRef } from '../src/published.js';
import type { Refusal } from '../src/registry.js';
import { run } from './documents.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory written from path to document; removed after the case. */
function written(docs: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-include-'));
  dirs.push(dir);
  for (const [file, doc] of Object.entries(docs)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(doc));
  }
  return dir;
}

const project = (body: Record<string, unknown> = {}) => ({
  $schema: schemaRef('project'),
  description: 'd',
  name: 't',
  plugins: [],
  ...body,
});

/** A shape whose one field is of the type given: a reference to another shape, or a plain type. */
const shapeOf = (type: string, description = 'd') => ({
  $schema: schemaRef('shape'),
  description,
  layer: 'core',
  fields: { thing: { type } },
});

/** The include: it names @java for its own connection, which a host leaves behind, and @std. */
const INCLUDE = {
  'project.json': project({ plugins: [{ use: '@std' }, { use: '@java', from: '@acme/plugin-java' }] }),
  'connections/sample.connection.json': {
    $schema: schemaRef('connection'),
    description: 'd',
    kind: '@java/java.connection-kind.json',
    settings: {},
  },
  'features/g/feature.json': { $schema: schemaRef('feature'), description: 'd' },
};

/** The D010 refusals of loading a host that names no plugin, including a tree written from `docs`. */
function d010(docs: Record<string, unknown>, features?: string[]): Refusal[] {
  const root = written({ 'project.json': project() });
  const load = loadTree(root, {}, [{ from: '@acme/lib', dir: written(docs), features }]);
  return load.refusals.items.filter(one => one.code === 'D010');
}

/** The same, as `at message`. */
const refusedD010 = (docs: Record<string, unknown>, features?: string[]) =>
  d010(docs, features).map(one => `${one.at} ${one.message}`);

describe('D010: a host names the plugins an included feature uses', () => {
  it('none for a plugin the include names that no walked feature uses, only its own connection', () => {
    expect(refusedD010({ ...INCLUDE, 'features/g/domain/Thing.shape.json': shapeOf('string') })).toEqual([]);
  });

  it('none for a plugin only a feature the host does not take uses', () => {
    const docs = { ...INCLUDE, 'features/dev/domain/Probe.shape.json': shapeOf('@java/Probe.shape.json') };
    expect(refusedD010({ ...docs, 'features/dev/feature.json': INCLUDE['features/g/feature.json'] }, ['g'])).toEqual(
      [],
    );
  });

  it('none for a plugin named only in prose', () => {
    const prose = shapeOf('string', 'the same as @java/Probe.shape.json, kept here');
    expect(refusedD010({ ...INCLUDE, 'features/g/domain/Thing.shape.json': prose })).toEqual([]);
  });

  it('refused for a plugin a walked feature names a document of, with the message and hint it always had', () => {
    const refusals = d010({ ...INCLUDE, 'features/g/domain/Thing.shape.json': shapeOf('@java/Probe.shape.json') });
    expect(refusals).toEqual([
      {
        code: 'D010',
        file: 'project.json',
        at: 'includes/0',
        message: "'@acme/lib' uses plugin '@java', which this project does not name",
        hint: 'add { "use": "@java", "from": "..." } to project.json → plugins, with the settings its README says',
      },
    ]);
  });

  it('refused for a plugin a walked feature reaches through an alias the include brings along', () => {
    const docs = {
      ...INCLUDE,
      'project.json': project({ plugins: INCLUDE['project.json'].plugins, aliases: { '@kinds': '@java/kinds' } }),
      'features/g/domain/Thing.shape.json': shapeOf('@kinds/Probe.shape.json'),
    };
    expect(refusedD010(docs)).toEqual(["includes/0 '@acme/lib' uses plugin '@java', which this project does not name"]);
  });

  it('refused for @std where a walked feature runs one of its operations, with no "from" in the hint', () => {
    const graph = {
      $schema: schemaRef('graph'),
      description: 'd',
      nodes: [run('a')],
    };
    const refusals = d010({ ...INCLUDE, 'features/g/domain/make.graph.json': graph });
    expect(refusals.map(one => one.hint)).toEqual([
      'add { "use": "@std" } to project.json → plugins, with the settings its README says',
    ]);
  });
});

describe('the roots the references of documents start with', () => {
  it('reads each through the aliases, and counts a root alone, a fragment and a key; never prose', () => {
    const resolve = (ref: string) => ref.replace(/^@lib\//, '@features/lib/');
    const docs = [
      { a: '@http/http.trigger-kind.json', b: ['@std/outcome.port.json#refuse'], c: { '@auth/x.json': 1 } },
      { d: '@lib/domain/T.shape.json', e: '@cli', f: 'see @java/x.json', g: 'a@b/c', h: 3 },
    ];
    expect([...rootsReferenced(docs, resolve)].sort()).toEqual(['@auth', '@cli', '@features', '@http', '@std']);
  });
});
