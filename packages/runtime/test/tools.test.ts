import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type ResolvedInclude } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import blobs from '@wilanis/plugin-blob';
import http from '@wilanis/plugin-http';
import otel from '@wilanis/plugin-otel';
import reload from '@wilanis/plugin-reload';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, fuzz, init, regress, scaffold } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
/** The tree the example includes, as the runtime would resolve it from the example's node_modules. */
const INCLUDES: ResolvedInclude[] = [
  {
    from: '@wilanis/access',
    dir: fileURLToPath(new URL('../../../libraries/access', import.meta.url)),
    features: ['access'],
  },
];
const PLUGINS = {
  ...BUILTIN_PLUGINS,
  '@http': http,
  '@blob': blobs,
  '@reload': reload,
  '@auth': auth,
  '@schedule': schedule,
  '@storage': storage,
  '@storage-memory': memory,
  '@storage-postgres': postgres,
  '@otel': otel,
};
const tmp = () => mkdtempSync(join(tmpdir(), 'wilanis-tools-'));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('wilanis new', () => {
  it('writes a project that loads, and refuses to overwrite', () => {
    const dir = tmp();
    expect(scaffold(dir, 'project', 'board', {})).toEqual(['package.json', 'project.json']);
    expect(read(join(dir, 'project.json')).plugins.map((plugin: any) => plugin.use)).toEqual(['@std', '@cli', '@http']);
    expect(() => scaffold(dir, 'project', 'board', {})).toThrow('package.json exists');
    rmSync(dir, { recursive: true, force: true });
  });
  it('writes each kind into the layer it lives in, and the result passes the placement rules', () => {
    const dir = tmp();
    scaffold(dir, 'project', 'board', {});
    expect(scaffold(dir, 'feature', 'tasks', {})).toEqual(['features/tasks/feature.json']);
    // features/<name>/<file>: the layer is inserted for the author, from the kind (and --layer for a shape or a graph)
    expect(scaffold(dir, 'shape', 'features/tasks/Task', {})).toEqual(['features/tasks/domain/Task.shape.json']);
    expect(scaffold(dir, 'shape', 'features/tasks/TaskView', { layer: 'edge' })).toEqual([
      'features/tasks/edge/TaskView.shape.json',
    ]);
    expect(scaffold(dir, 'port', 'features/tasks/tasks', {})).toEqual(['features/tasks/domain/tasks.port.json']);
    expect(scaffold(dir, 'graph', 'features/tasks/greet', {})).toEqual(['features/tasks/domain/greet.graph.json']);
    expect(scaffold(dir, 'graph', 'features/tasks/fetch', { layer: 'data' })).toEqual([
      'features/tasks/data/fetch.graph.json',
    ]);
    expect(
      scaffold(dir, 'binding', 'features/tasks/tasks-rest', { port: '@features/tasks/domain/tasks.port.json' }),
    ).toEqual(['features/tasks/data/tasks-rest.binding.json']);
    expect(scaffold(dir, 'resolvers', 'features/tasks/request', {})).toEqual([
      'features/tasks/edge/request.resolvers.json',
    ]);
    expect(
      scaffold(dir, 'trigger', 'features/tasks/list', { run: '@features/tasks/domain/tasks.port.json#example' }),
    ).toEqual(['features/tasks/edge/list.trigger.json']);
    // an invariant is a rule of the business, so both its forms land in domain/: --over writes the access form,
    // and without it the field form over a core shape
    expect(
      scaffold(dir, 'invariant', 'features/tasks/writes-are-gated', {
        over: '@features/tasks/domain/tasks.port.json#example',
      }),
    ).toEqual(['features/tasks/domain/writes-are-gated.invariant.json']);
    expect(
      scaffold(dir, 'invariant', 'features/tasks/task-is-named', { on: '@features/tasks/domain/Task.shape.json' }),
    ).toEqual(['features/tasks/domain/task-is-named.invariant.json']);
    // a path with the layer already in it is taken as written, and the shape's layer follows the directory
    expect(scaffold(dir, 'shape', 'features/tasks/edge/ListRequest', {})).toEqual([
      'features/tasks/edge/ListRequest.shape.json',
    ]);
    expect(read(join(dir, 'features/tasks/edge/ListRequest.shape.json')).layer).toBe('edge');
    // the scaffolds fit together: the binding meets the port's example operation, nothing is misplaced, every
    // document is a valid instance of its schema. What is left is the one TODO a scaffold cannot decide for the
    // author: the trigger must declare what it answers.
    expect(checkTree(loadTree(dir, PLUGINS)).items.map(refusal => refusal.code)).toEqual(['T002']);
    expect(() => scaffold(dir, 'nonsense', 'x', {})).toThrow("unknown kind 'nonsense'");
    rmSync(dir, { recursive: true, force: true });
  });
  it('writes a store into data/, with one collection named after the file and keyed by id', () => {
    const dir = tmp();
    scaffold(dir, 'project', 'board', {});
    scaffold(dir, 'feature', 'tasks', {});
    scaffold(dir, 'shape', 'features/tasks/Task', {});
    expect(scaffold(dir, 'store', 'features/tasks/tasks', { of: '@features/tasks/domain/Task.shape.json' })).toEqual([
      'features/tasks/data/tasks.store.json',
    ]);
    expect(read(join(dir, 'features/tasks/data/tasks.store.json')).collections).toEqual({
      tasks: { of: '@features/tasks/domain/Task.shape.json', key: 'id', description: 'TODO' },
    });
    // a file the author named with a dash still declares a collection the grammar accepts
    scaffold(dir, 'store', 'features/tasks/audit-log', {});
    expect(Object.keys(read(join(dir, 'features/tasks/data/audit-log.store.json')).collections)).toEqual(['auditLog']);
    // both validate and are where a store lives: the loader has nothing to say about them
    expect(loadTree(dir, PLUGINS).refusals.items).toEqual([]);
    // anywhere else it is D008: how records are kept is the data layer's job
    scaffold(dir, 'store', 'features/tasks/domain/elsewhere', {});
    expect(loadTree(dir, PLUGINS).refusals.items.map(refusal => [refusal.code, refusal.file])).toEqual([
      ['D008', 'features/tasks/domain/elsewhere.store.json'],
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('wilanis init', () => {
  it('writes CLAUDE.md and the hooks, keeps what exists, and says which', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# mine\n');
    const lines = init(dir);
    expect(lines).toEqual([`kept ${join(dir, 'CLAUDE.md')}`, `wrote ${join(dir, '.claude', 'settings.json')}`]);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# mine\n');
    expect(read(join(dir, '.claude', 'settings.json')).hooks.Stop).toBeDefined();
    // a second run changes nothing
    expect(init(dir).every(line => line.startsWith('kept '))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('wilanis fuzz and regress', () => {
  it('fuzz writes one scenario per trigger per seed, and regress replays every one as the same', async () => {
    const dir = tmp();
    cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
    const written = await fuzz(loadTree(dir, PLUGINS, INCLUDES), { runs: 2, profile: 'live' });
    // eighteen triggers -- the example's, the nightly digest among them, and the included access tree's -- two seeds each
    expect(written).toHaveLength(36);
    expect(readdirSync(join(dir, 'scenarios')).sort()).toEqual(written.map(one => one.split('/').pop()!).sort());
    const sc = read(join(dir, 'scenarios', 'get-entry.1.scenario.json'));
    expect(sc.trigger).toBe('@features/monitor/edge/get-entry.trigger.json');
    expect(['done', 'failed']).toContain(sc.expect.status);
    // the scenarios are documents of the tree: they load, and they pass check
    const again = loadTree(dir, PLUGINS, INCLUDES);
    expect(again.registry.all('scenario')).toHaveLength(36);
    expect(checkTree(again).items).toEqual([]);
    const replayed = await regress(again, { profile: 'live' });
    expect(replayed.ok, replayed.lines.join('\n')).toBe(true);
    expect(replayed.lines).toHaveLength(36);
    expect(replayed.lines.every(line => line.endsWith(': same'))).toBe(true);
    // a graph that changes is caught: the answering node under a new name is a node the scenario never saw
    const file = join(dir, 'features/monitor/data/get-row.graph.json');
    const doc = read(file);
    doc.nodes.find((node: any) => node.id === 'row').id = 'entry';
    doc.nodes.find((node: any) => node.id === 'route').rules[1].to = 'entry';
    doc.out.from = ['entry', 'missing', 'failed'];
    writeFileSync(file, JSON.stringify(doc));
    const changed = await regress(loadTree(dir, PLUGINS, INCLUDES), { profile: 'live' });
    expect(changed.ok).toBe(false);
    expect(changed.lines.some(line => line.includes('get-entry') && !line.endsWith(': same'))).toBe(true);
    expect(existsSync(join(dir, 'scenarios'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the handler each node ran, so a diff says a node was rebound and not only that it answered differently', async () => {
    const dir = tmp();
    cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
    await fuzz(loadTree(dir, PLUGINS, INCLUDES), { runs: 1, profile: 'live' });
    const sc = read(join(dir, 'scenarios', 'get-entry.1.scenario.json'));
    // the fire runs whatever the profile's binding met the port with -- the graph is the thing a rebind changes
    expect(sc.expect.nodes.op.handler).toBe('graph:@features/monitor/data/get-row.graph.json');
    // and under it, the operation each node ran, native or declared
    expect(sc.expect.nodes['op.asked'].handler).toBe('@http/http.port.json#request');
    expect(sc.expect.nodes['op.failed'].handler).toBe('@std/outcome.port.json#refuse');
    // a switch has no handler to record, and nothing invented one
    expect(sc.expect.nodes['op.route'].selected).toBe('failed');
    expect(sc.expect.nodes['op.route'].handler).toBeUndefined();

    // the scenarios still load and pass check with the field on them
    const again = loadTree(dir, PLUGINS, INCLUDES);
    expect(checkTree(again).items).toEqual([]);
    expect((await regress(again, { profile: 'live' })).ok).toBe(true);

    // a node met by another graph is a change the recorded answer alone cannot name, and the diff names it
    const scenario = join(dir, 'scenarios', 'get-entry.1.scenario.json');
    const doc = read(scenario);
    doc.expect.nodes.op.handler = 'graph:@features/monitor/data/kept-get.graph.json';
    writeFileSync(scenario, JSON.stringify(doc));
    const changed = await regress(loadTree(dir, PLUGINS, INCLUDES), { profile: 'live' });
    expect(changed.ok).toBe(false);
    expect(changed.lines.join('\n')).toContain(
      'op: ran graph:@features/monitor/data/kept-get.graph.json → graph:@features/monitor/data/get-row.graph.json',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
