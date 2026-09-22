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
import { BUILTIN_PLUGINS, describe as describeDoc, fuzz, regress, scaffold } from '../src/index.js';
import { loadedEditing } from './example-harness.js';

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
    // document is a valid instance of its schema. What is left is the three TODOs a scaffold cannot decide for
    // the author: the trigger must declare what it answers (T002); the field invariant names a shape no graph
    // makes or takes yet, since the author has not written one (I003); and the access invariant's proves names
    // request.principal, which only a guarding plugin hands and a fresh project names none (I002).
    expect(checkTree(loadTree(dir, PLUGINS)).items.map(refusal => refusal.code)).toEqual(['T002', 'I003', 'I002']);
    expect(() => scaffold(dir, 'nonsense', 'x', {})).toThrow("unknown kind 'nonsense'");
    rmSync(dir, { recursive: true, force: true });
  });
  it('refuses a bare name for a kind that lives inside a feature, naming the path to give and the features there are', () => {
    const dir = tmp();
    scaffold(dir, 'project', 'board', {});
    scaffold(dir, 'feature', 'tasks', {});
    scaffold(dir, 'feature', 'audit', {});
    const run = '@features/tasks/domain/tasks.port.json#example';
    // the very thing the demo stumbled on: a trigger at the root is a file `wilanis check` refuses as D008
    expect(() => scaffold(dir, 'trigger', 'archive-entry', { run })).toThrow(
      'a trigger lives inside a feature, under edge/; give the path: features/<feature>/edge/archive-entry, where <feature> is one of audit, tasks',
    );
    expect(existsSync(join(dir, 'edge'))).toBe(false);
    // the layer named is the one the scaffold would have chosen: a shape is the domain's unless --layer edge
    expect(() => scaffold(dir, 'shape', 'Task', {})).toThrow('give the path: features/<feature>/domain/Task,');
    expect(() => scaffold(dir, 'shape', 'TaskView', { layer: 'edge' })).toThrow(
      'give the path: features/<feature>/edge/TaskView,',
    );
    expect(() => scaffold(dir, 'graph', 'fetch', { layer: 'data' })).toThrow(
      'give the path: features/<feature>/data/fetch,',
    );
    // a path in a layer the kind may not live in is refused with the checker's own hint, and nothing is written either
    expect(() => scaffold(dir, 'trigger', 'features/tasks/domain/list', { run })).toThrow(
      'features/tasks/domain/list.trigger.json: a trigger may not live in the domain layer',
    );
    expect(existsSync(join(dir, 'features/tasks/domain/list.trigger.json'))).toBe(false);
    // a path is honoured as before
    expect(scaffold(dir, 'trigger', 'features/tasks/archive-entry', { run })).toEqual([
      'features/tasks/edge/archive-entry.trigger.json',
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
  it('tells a tree with no feature yet to make one before placing a document in it', () => {
    const dir = tmp();
    scaffold(dir, 'project', 'board', {});
    expect(() => scaffold(dir, 'port', 'tasks', {})).toThrow(
      'a port lives inside a feature, under domain/; give the path: features/<feature>/domain/tasks, after wilanis new feature <feature>, since this tree has none yet',
    );
    expect(readdirSync(dir).sort()).toEqual(['package.json', 'project.json']);
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
    // the scope is scaffolded whole: one read bound under `reads`, and the column it fills beside the shape
    expect(read(join(dir, 'features/tasks/data/tasks.store.json')).collections).toEqual({
      tasks: {
        of: '@features/tasks/domain/Task.shape.json',
        key: 'id',
        scoped: { tenant: '{{tenant}}' },
        description: 'TODO',
      },
    });
    expect(read(join(dir, 'features/tasks/data/tasks.store.json')).reads).toEqual({
      tenant: '@features/TODO/edge/TODO.resolvers.json#tenant',
    });
    // a file the author named with a dash still declares a collection the grammar accepts
    scaffold(dir, 'store', 'features/tasks/audit-log', {});
    expect(Object.keys(read(join(dir, 'features/tasks/data/audit-log.store.json')).collections)).toEqual(['auditLog']);
    // both validate and are where a store lives: the loader has nothing to say about them
    expect(loadTree(dir, PLUGINS).refusals.items).toEqual([]);
    // anywhere else it is D008: how records are kept is the data layer's job -- and the scaffold refuses before
    // writing, in the checker's words, rather than write a file the checker then refuses
    expect(() => scaffold(dir, 'store', 'features/tasks/domain/elsewhere', {})).toThrow(
      'features/tasks/domain/elsewhere.store.json: a store may not live in the domain layer',
    );
    expect(existsSync(join(dir, 'features/tasks/domain/elsewhere.store.json'))).toBe(false);
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
    expect(sc.trigger).toBe('@features/customers/edge/get-customer.trigger.json');
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
    const file = join(dir, 'features/customers/data/get-row.graph.json');
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
    expect(sc.expect.nodes.op.handler).toBe('graph:@features/customers/data/get-row.graph.json');
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
    doc.expect.nodes.op.handler = 'graph:@features/customers/data/kept-get.graph.json';
    writeFileSync(scenario, JSON.stringify(doc));
    const changed = await regress(loadTree(dir, PLUGINS, INCLUDES), { profile: 'live' });
    expect(changed.ok).toBe(false);
    expect(changed.lines.join('\n')).toContain(
      'op: ran graph:@features/customers/data/kept-get.graph.json → graph:@features/customers/data/get-row.graph.json',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * What `wilanis describe` says about the reads a document takes from the request. A read is the one value in
 * a tree that comes from outside it, and RFC 0029 made each one a path above its use; `describe` reads that
 * map from both ends, so neither a `{{name}}` in a graph nor a resolver in an edge document is a name whose
 * other end a reader has to go looking for.
 */
describe('wilanis describe: the reads a document takes from the request', () => {
  const said = () => describeDoc(loadTree(EXAMPLE, PLUGINS, INCLUDES), '@customers/data/create-row.graph.json');

  it('prints the reads block before the nodes, so no {{name}} is met before what binds it', () => {
    const lines = said().split('\n');
    expect(lines.indexOf('reads:')).toBeGreaterThan(-1);
    expect(lines.indexOf('reads:')).toBeLessThan(lines.indexOf('nodes:'));
  });

  it('names each read, the resolver it is bound to, and what that resolver reads of the request', () => {
    // the ref is openable and the read beside it spares the reader opening it to learn what {{agent}} is
    expect(said()).toContain(
      "    agent ← @customers/edge/request.resolvers.json#agent  (request.headers['user-agent'])",
    );
  });

  it('says of a required read that it is required, since a trigger reaching it must prove it (A006)', () => {
    const lines = describeDoc(loadTree(EXAMPLE, PLUGINS, INCLUDES), '@access/data/read-session.graph.json');
    expect(lines).toContain('    sid ← @access/edge/session.resolvers.json#sid  (request.session.id, required)');
  });

  it('prints no block at all for a graph that reads nothing, rather than an empty heading', () => {
    const lines = describeDoc(loadTree(EXAMPLE, PLUGINS, INCLUDES), '@customers/data/get-row.graph.json');
    expect(lines).not.toContain('reads:');
  });

  it("prints a binding's reads above its operations, since a delegation's {{name}} is one of them", () => {
    // no binding of the example delegates over a read yet; the block is the binding's all the same
    const { load, dir } = loadedEditing('features/customers/data/customers-rest.binding.json', doc => {
      doc.reads = { agent: '@customers/edge/request.resolvers.json#agent' };
    });
    const lines = describeDoc(load, '@customers/data/customers-rest.binding.json').split('\n');
    expect(lines).toContain(
      "    agent ← @customers/edge/request.resolvers.json#agent  (request.headers['user-agent'])",
    );
    expect(lines.indexOf('reads:')).toBeLessThan(lines.indexOf('answers:'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('says the ref and nothing more where the resolver behind it cannot be read', () => {
    // describe reads a tree the checker may not have passed; P004 is the checker's to say, not this command's
    const { load, dir } = loadedEditing('features/customers/data/create-row.graph.json', doc => {
      doc.reads = { agent: '@customers/edge/request.resolvers.json#agents' };
    });
    expect(describeDoc(load, '@customers/data/create-row.graph.json')).toContain(
      '    agent ← @customers/edge/request.resolvers.json#agents\n',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('wilanis describe: a resolvers document and who reads it', () => {
  const said = () => describeDoc(loadTree(EXAMPLE, PLUGINS, INCLUDES), '@customers/edge/request.resolvers.json');

  it('prints one line per resolver, saying what it reads', () => {
    expect(said()).toContain("    agent  ← request.headers['user-agent']");
  });

  it('names every document that binds it, and the local name each gave it', () => {
    expect(said()).toContain('        used by @features/customers/data/create-row.graph.json as {{agent}}');
  });

  it('names each user of a resolver several documents read, one line each', () => {
    const lines = describeDoc(loadTree(EXAMPLE, PLUGINS, INCLUDES), '@access/edge/session.resolvers.json');
    expect(lines).toContain('        used by @features/access/data/end-session.graph.json as {{sid}}');
    expect(lines).toContain('        used by @features/access/data/read-session.graph.json as {{sid}}');
    expect(lines).toContain('        used by @features/access/data/write-theme.graph.json as {{sid}}');
  });

  it('says so where a resolver is declared and nothing binds it', () => {
    const { load, dir } = loadedEditing('features/customers/edge/request.resolvers.json', doc => {
      doc.resolvers.tenant = { read: 'request.session.attributes.tenant' };
    });
    expect(describeDoc(load, '@customers/edge/request.resolvers.json')).toContain(
      '        used by nothing yet -- bind it under a data graph’s or a binding’s reads',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the local name the reader chose, not the resolver name', () => {
    const { load, dir } = loadedEditing('features/customers/data/create-row.graph.json', doc => {
      doc.reads = { who: '@customers/edge/request.resolvers.json#agent' };
      doc.nodes[0].in.headers['x-forwarded-user-agent'] = '{{who}}';
    });
    expect(describeDoc(load, '@customers/edge/request.resolvers.json')).toContain(
      '        used by @features/customers/data/create-row.graph.json as {{who}}',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
