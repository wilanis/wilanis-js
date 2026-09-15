import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, describe as describeDoc, loadProject, rehearse, start } from '../src/index.js';
import { codes, docsDir, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

describe('the example tree', () => {
  it('passes check', () => {
    expect(codes(EXAMPLE)).toEqual([]);
  });
  it('keeps its entries under the local profile, and every branch of that still settles', async () => {
    // the same routes, the same policies, the same domain graphs: only the binding differs, which is
    // what a port is for. Nothing here reaches a network, so this is the milestone's demo in one line.
    const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, profile: 'local' });
    expect(run.ok, run.lines.join('\n')).toBe(true);
    expect(run.lines.join('\n')).toMatch(/every branch settled/);
    // and the store is what answers: a data graph of the local binding is among the graphs walked
    expect(run.lines.join('\n')).toContain('features/monitor/data/kept-get');
  });
  it('rehearses every branch of every switch, whatever the seed', async () => {
    // solved from the rules, so no seed can leave a branch untried
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed, profile: 'live' });
      expect(run.ok, `seed ${seed}: ${run.lines.join('\n')}`).toBe(true);
      expect(run.lines.join('\n')).not.toMatch(/NEVER RUN|BROKE|BLOCKED|WRONG ROUTE/);
    }
  });
  it('reports each decision once, under the graph that declares it', async () => {
    const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, profile: 'live' });
    const text = run.lines.join('\n');
    // list-rows is reached from two triggers (the listing and the digest), and is one decision even so
    expect(text.match(/list-rows {2}switch 'route'/g)).toHaveLength(1);
    // delete-row is reached directly by the single delete and once per element by the batch delete's map
    expect(text.match(/delete-row {2}switch 'route'/g)).toHaveLength(1);
    expect(text).toMatch(/every branch settled -- 37 branch\(es\), 15 decision\(s\), 15 graph\(s\)/);
  });
  it('reaches both the answer and the declared failure of every data graph', async () => {
    const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, profile: 'live' });
    const text = run.lines.join('\n');
    // the six data graphs each answer on one branch and refuse on purpose on the others
    expect(text.match(/refused on purpose at 'failed' as upstream/g)).toHaveLength(6);
    // the three graphs behind an id declare what a missing id means, and say so in one word the trigger maps
    expect(text.match(/refused on purpose at 'missing' as missing: "no entry /g)).toHaveLength(3);
    // every branch that answers names the node it answered from, never a bare status word: the monitor's eight, and the access feature's
    expect(text.match(/answered from '/g)).toHaveLength(16);
    // the rule is shown as a condition, not as a bare expression next to a node id
    expect(text).toMatch(/when status == 200 && has\(body\)/);
    expect(text).toMatch(/anything else/);
    expect(text).toMatch(/when status == 404/);
  });
  it('rehearses a switch inside a mapped operation through the first element, whatever the seed', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed, verbose: true, profile: 'live' });
      const text = run.lines.join('\n');
      // the batch delete reaches the delete-row decision through its map, and every branch of it settles
      expect(text).toMatch(/delete-row {2}switch 'route' {2}3\/3 branches {2}\[via delete-entries, delete-entry\]/);
    }
  });
  it('loads its plugin packages through project.json → plugins[].from', async () => {
    const loaded = await loadProject(EXAMPLE);
    expect(loaded.refusals.items).toEqual([]);
    expect(loaded.plugins.map(plugin => plugin.root).sort()).toEqual([
      '@auth',
      '@blob',
      '@cli',
      '@http',
      '@reload',
      '@schedule',
      '@std',
      '@storage',
      '@storage-memory',
      '@storage-postgres',
    ]);
  });
});

describe('plugin packages and hooks', () => {
  const project = (plugins: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-hooks-'));
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify({ $schema: schemaUrl('project'), name: 'hooks', description: 'a tree with hooks', plugins }),
    );
    return dir;
  };
  it('D006 when from is not a package name, or names a package that is not installed', async () => {
    const codesOf = async (from: string) =>
      (await loadProject(project([{ use: '@std' }, { use: '@x', from }]))).refusals.items.map(refusal => refusal.code);
    expect(await codesOf('../evil.js')).toContain('D006');
    expect(await codesOf('@wilanis/no-such-plugin')).toContain('D006');
  });
  it('every document a plugin ships is a file a reader can open, and describe says where', () => {
    const loaded = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    for (const file of loaded.registry.files.filter(one => one.native)) {
      expect(file.file, file.path).toBeDefined();
      expect(existsSync(file.file!), file.path).toBe(true);
      expect(JSON.parse(readFileSync(file.file!, 'utf8'))).toEqual(file.doc);
    }
    expect(describeDoc(loaded, '@http/http.port.json')).toContain(
      `file  ${loaded.registry.get('port', '@http/http.port.json')?.file}`,
    );
    // a native document says whose it is: who implements it must not be a code detail
    expect(describeDoc(loaded, '@http/server.port.json')).toContain('granted by  @http  (@wilanis/plugin-http)');
    expect(describeDoc(loaded, '@reload/watch.port.json')).toContain('granted by  @reload  (@wilanis/plugin-reload)');
    expect(describeDoc(loaded, '@std/list.port.json')).toContain('granted by  @std  (built into the runtime)');
    expect(describeDoc(loaded, '@monitor/domain/monitor.port.json')).not.toContain('granted by');
    // and a holds operation says that it holds
    expect(describeDoc(loaded, '@http/server.port.json')).toContain('#listen  (holds until stopped)');
    expect(loaded.registry.get('graph', '@features/monitor/data/get-row.graph.json')?.file).toBe(
      join(EXAMPLE, 'features/monitor/data/get-row.graph.json'),
    );
  });
  it('D006 when a plugin ships no plugin.json', () => {
    const fake: PluginModule = {
      root: '@fake',
      docs: docsDir({
        'fake.port.json': {
          $schema: schemaRef('port'),
          description: 'a port',
          operations: { op: { description: 'x' } },
        },
      }),
      handlers: {},
    };
    const dir = project([{ use: '@std' }, { use: '@fake' }]);
    expect(loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake }).refusals.items.map(refusal => refusal.code)).toContain(
      'D006',
    );
    rmSync(dir, { recursive: true, force: true });
  });
  it('postLoad runs once after load with the plugin settings; its teardown runs on stop', async () => {
    const calls: string[] = [];
    const fake: PluginModule = {
      root: '@fake',
      docs: docsDir({
        'plugin.json': {
          $schema: schemaRef('plugin'),
          description: 'a plugin with a postLoad hook',
          settings: { fields: { greeting: { type: 'string' } } },
          grants: {},
        },
      }),
      handlers: {},
      postLoad: async ({ settings, root }) => {
        calls.push(`up:${settings.greeting}:${typeof root}`);
        return async () => {
          calls.push('down');
        };
      },
    };
    const dir = project([{ use: '@std' }, { use: '@fake', settings: { greeting: 'hi' } }]);
    const loaded = loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake });
    expect(checkTree(loaded).items).toEqual([]);
    const { stop } = await start(loaded, { log: () => {}, profile: 'live' });
    expect(calls).toEqual(['up:hi:string']);
    await stop();
    expect(calls).toEqual(['up:hi:string', 'down']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('branch rehearsal', () => {
  /**
   * Copy the example, edit one document per entry, and answer the rehearsal's lines together with the copy's
   * refusal codes -- a fixture the checker refuses proves nothing, so a case that edits the tree says both.
   */
  async function withEdits(
    edits: Record<string, (doc: any) => void>,
    profile: string,
  ): Promise<{ lines: string[]; codes: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-'));
    cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
    for (const [file, edit] of Object.entries(edits)) {
      const at = join(dir, file);
      const doc = JSON.parse(readFileSync(at, 'utf8'));
      edit(doc);
      writeFileSync(at, JSON.stringify(doc));
    }
    const refused = checkTree(loadTree(dir, PLUGINS, INCLUDES)).items.map(one => one.code);
    const run = await rehearse(loadTree(dir, PLUGINS), { seed: 1, profile });
    rmSync(dir, { recursive: true, force: true });
    return { lines: run.lines, codes: refused };
  }

  /** Copy the example, edit one document, and rehearse every branch of it under one profile. */
  async function withEdit(file: string, edit: (doc: any) => void, profile = 'live'): Promise<string[]> {
    return (await withEdits({ [file]: edit }, profile)).lines;
  }

  it('reports a rule an earlier rule already covers', async () => {
    const lines = await withEdit('features/monitor/data/list-rows.graph.json', graph => {
      const route = graph.nodes.find((node: any) => node.id === 'route');
      route.rules = [
        { when: 'status >= 200', to: 'rows' },
        { when: 'status == 200 && has(body)', to: 'rows' },
      ];
    });
    expect(lines.join('\n')).toMatch(/NEVER RUN/);
  });

  it('reports a rule that contradicts itself', async () => {
    const lines = await withEdit('features/monitor/data/list-rows.graph.json', graph => {
      const route = graph.nodes.find((node: any) => node.id === 'route');
      route.rules = [{ when: 'status > 500 && status < 200', to: 'rows' }];
    });
    expect(lines.join('\n')).toMatch(/NEVER RUN/);
  });

  it('marks an atomic graph and says which of its branches roll back', async () => {
    // store-and-latest is the example's own: it writes the entry and its method's latest, and says so
    const lines = await withEdit('features/monitor/data/store-and-latest.graph.json', () => {}, 'local');
    const text = lines.join('\n');
    expect(text).toMatch(/features\/monitor\/data\/store-and-latest {2}\(atomic\) {2}switch 'route'/);
    // the branch that answers commits, so nothing is said of it; the refusal is what undoes both writes
    expect(text).toMatch(/when has\(record\) && has\(mark\) {2}answered from 'row'$/m);
    expect(text).toMatch(/refused on purpose at 'failed' as upstream: "[^"]*", rolled back$/m);
    // and the line names no reasons: describe says those
    expect(text).not.toMatch(/\(atomic\)[^\n]*rolls back/);
  });

  it('changes nothing but those two words: the same branches, and only the graph that says so', async () => {
    const graph = 'features/monitor/data/store-and-latest.graph.json';
    const before = (await withEdit(graph, doc => delete doc.atomic, 'local')).join('\n');
    const after = (await withEdit(graph, () => {}, 'local')).join('\n');
    // atomicity is a property of the run, not of the routing: the solver walks the same branches either way
    expect(before).not.toContain('(atomic)');
    expect(before).not.toContain('rolled back');
    expect(after.match(/\(atomic\)/g)).toHaveLength(1);
    expect(after.replace('  (atomic)', '').replace(/, rolled back/g, '')).toBe(before);
  });

  it('marks a graph with no branches at all, reached as a trigger fires its port', async () => {
    // digest is the one graph a trigger's fire reaches through a binding and that holds no switch, so it is
    // the run the report calls plain -- and the only one that exercises the root a plain run is marked from.
    // Under live its listAll fetches over HTTP, which L009 refuses inside a transaction, so the copy binds
    // that operation to the kept graph as local already does and drops the 'upstream' the export trigger
    // then no longer reaches (T006). What is left is a tree that checks clean and writes under a transaction.
    const { lines, codes: refused } = await withEdits(
      {
        'features/monitor/domain/digest.graph.json': doc => {
          doc.atomic = true;
        },
        'features/monitor/data/monitor-rest.binding.json': doc => {
          doc.operations.listAll = { graph: '@monitor/data/kept-list.graph.json' };
        },
        'features/monitor/edge/export-entries.trigger.json': doc => {
          delete doc.settings.response.refusals.upstream;
        },
      },
      'local',
    );
    expect(refused).toEqual([]);
    // the line names the operation the trigger fires, and says the graph behind it moves as one
    expect(lines.join('\n')).toMatch(/monitor\/domain\/monitor\.port\.json#digest {2}\(atomic\) {2}\(no branches\)/);
  });
});
