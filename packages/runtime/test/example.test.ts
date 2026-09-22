import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import http from '@wilanis/plugin-http';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, describe as describeDoc, loadProject, rehearse, start } from '../src/index.js';
import { codes, docsDir, EXAMPLE, INCLUDES, PLUGINS, withBrokenPluginDoc } from './example-harness.js';

describe('the example tree', () => {
  it('passes check', () => {
    expect(codes(EXAMPLE)).toEqual([]);
  });
  it('keeps its customers under the local profile, and every branch of that still settles', async () => {
    // the same routes, the same policies, the same domain graphs: only the binding differs, which is
    // what a port is for. Nothing here reaches a network, so this is the milestone's demo in one line.
    const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, profile: 'local' });
    expect(run.ok, run.lines.join('\n')).toBe(true);
    expect(run.lines.join('\n')).toMatch(/every branch settled/);
    // and the store is what answers: a data graph of the local binding is among the graphs walked
    expect(run.lines.join('\n')).toContain('features/customers/data/kept-get');
  });
  // eight full rehearsals of the whole tree, well past vitest's five-second default
  it('rehearses every branch of every switch, whatever the seed', { timeout: 60_000 }, async () => {
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
    expect(text.match(/list-rows {2}switch 'outcome'/g)).toHaveLength(1);
    // delete-row is reached directly by the single delete and once per element by the batch delete's map
    expect(text.match(/delete-row {2}switch 'outcome'/g)).toHaveLength(1);
    // the sixteenth decision is the guard over the CSV export's list of customers, whose nested spec the walk
    // opens by name; the fifteen the tree's authors wrote are unchanged
    expect(text).toMatch(/every branch settled -- 42 branch\(es\), 17 decision\(s\), 16 graph\(s\)/);
  });
  it('reaches both the answer and the declared failure of every data graph', async () => {
    const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, profile: 'live' });
    const text = run.lines.join('\n');
    // the six data graphs each answer on one branch and refuse on purpose on the others
    expect(text.match(/refused on purpose at 'upstreamFailed' as upstream/g)).toHaveLength(6);
    // the three graphs behind an id declare what a missing id means, and say so in one word the trigger maps
    expect(text.match(/refused on purpose at 'noCustomer' as missing: "no customer /g)).toHaveLength(3);
    // every branch that answers names the node it answered from, never a bare status word: the registry's eight,
    // the access feature's, and the `in:ok` of the guard over the CSV export's list
    expect(text.match(/answered from '/g)).toHaveLength(20);
    // the rule is shown as a condition, not as a bare expression next to a node id
    expect(text).toMatch(/when status == 200 && has\(body\)/);
    expect(text).toMatch(/anything else/);
    expect(text).toMatch(/when status == 404/);
  });
  it('prints how long each branch took under --verbose, and never without it', async () => {
    const quiet = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, profile: 'live' });
    const loud = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, verbose: true, profile: 'live' });
    expect(quiet.ok && loud.ok, quiet.lines.join('\n')).toBe(true);
    // a duration is an aside for a reader, so it is absent from the ordinary report
    expect(quiet.lines.join('\n')).not.toMatch(/\(\d+ms\)/);
    // and present on every branch that ran under --verbose -- an uncovered one never ran, so it has none
    const ran = loud.lines.filter(line => /^ {2}(ok|!!) /.test(line));
    expect(ran.length).toBeGreaterThan(0);
    expect(
      ran.every(line => /\(\d+ms\)$/.test(line)),
      ran.join('\n'),
    ).toBe(true);
    // the duration follows the outcome rather than replacing it: the line still says what settled
    expect(loud.lines.join('\n')).toMatch(/answered from '[^']+' {2}\(\d+ms\)/);
    expect(loud.lines.join('\n')).toMatch(/refused on purpose at '[^']+' as upstream: "[^"]*" {2}\(\d+ms\)/);
  });
  it('rehearses a switch inside a mapped operation through the first element, whatever the seed', {
    timeout: 60_000,
  }, async () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed, verbose: true, profile: 'live' });
      const text = run.lines.join('\n');
      // the batch delete reaches the delete-row decision through its map, and every branch of it settles
      expect(text).toMatch(
        /delete-row {2}switch 'outcome' {2}3\/3 branches {2}\[via delete-customer, delete-customers\]/,
      );
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
      '@otel',
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
    expect(describeDoc(loaded, '@customers/domain/customer.port.json')).not.toContain('granted by');
    // and a holds operation says that it holds
    expect(describeDoc(loaded, '@http/server.port.json')).toContain('#listen  (holds until stopped)');
    // a kind that says what correlates a run with its caller says so where its other rules are said
    expect(describeDoc(loaded, '@http/http.trigger-kind.json')).toContain(
      "correlation: request.headers.traceparent correlates a run with the caller's trace, copied opaquely (T007)",
    );
    expect(describeDoc(loaded, '@cli/cli.trigger-kind.json')).not.toContain('correlation:');
    expect(loaded.registry.get('graph', '@features/customers/data/get-row.graph.json')?.file).toBe(
      join(EXAMPLE, 'features/customers/data/get-row.graph.json'),
    );
  });
  it('T007 a trigger kind whose correlation names no field of its own context', () => {
    // the route kind says headers.traceparent correlates a run with its caller's trace; the example's routes
    // are of that kind, so what the kind declares is judged here and the tree that names it is the proof
    const broken = (path: string) =>
      withBrokenPluginDoc(http, 'http.trigger-kind.json', kind => {
        kind.correlation = path;
      });
    expect(broken('headers.traceparent').codes).toEqual([]);
    expect(broken('traceparent').at).toEqual(['T007 @http/http.trigger-kind.json#correlation']);
    expect(broken('headers.traceparent.version').codes).toEqual(['T007']);
    expect(broken('method.traceparent').codes).toEqual(['T007']);
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
    const lines = await withEdit('features/customers/data/list-rows.graph.json', graph => {
      const route = graph.nodes.find((node: any) => node.id === 'outcome');
      route.rules = [
        { when: 'status >= 200', to: 'customers' },
        { when: 'status == 200 && has(body)', to: 'customers' },
      ];
    });
    expect(lines.join('\n')).toMatch(/NEVER RUN/);
  });

  it('reports a rule that contradicts itself', async () => {
    const lines = await withEdit('features/customers/data/list-rows.graph.json', graph => {
      const route = graph.nodes.find((node: any) => node.id === 'outcome');
      route.rules = [{ when: 'status > 500 && status < 200', to: 'customers' }];
    });
    expect(lines.join('\n')).toMatch(/NEVER RUN/);
  });

  it('marks an atomic graph and says which of its branches roll back', async () => {
    // store-and-latest is the example's own: it writes the customer and its tier's latest, and says so
    const lines = await withEdit('features/customers/data/store-and-latest.graph.json', () => {}, 'local');
    const text = lines.join('\n');
    expect(text).toMatch(/features\/customers\/data\/store-and-latest {2}\(atomic\) {2}switch 'bothWritten'/);
    // the branch that answers routes to the node the guard moved aside to, since the field invariant over
    // Customer is not proved at 'customer' and the compiler lowers a switch between it and what reads it
    expect(text).toMatch(/when has\(record\) && has\(mark\) {2}answered from 'customer:made'$/m);
    expect(text).toMatch(/refused on purpose at 'nothingWritten' as upstream: "[^"]*", rolled back$/m);
    // and the line names no reasons: describe says those
    expect(text).not.toMatch(/\(atomic\)[^\n]*rolls back/);
  });

  it('changes nothing but those two words: the same branches, and only the graph that says so', async () => {
    const graph = 'features/customers/data/store-and-latest.graph.json';
    const before = (await withEdit(graph, doc => delete doc.atomic, 'local')).join('\n');
    const after = (await withEdit(graph, () => {}, 'local')).join('\n');
    // atomicity is a property of the run, not of the routing: the solver walks the same branches either way
    expect(before).not.toContain('(atomic)');
    expect(before).not.toContain('rolled back');
    // two decisions of this one graph: its own `bothWritten`, and the `customer:check` the guard over Customer lowered
    expect(after.match(/\(atomic\)/g)).toHaveLength(2);
    expect(after.replace(/ {2}\(atomic\)/g, '').replace(/, rolled back/g, '')).toBe(before);
  });

  it('marks a graph with no branches at all, reached as a trigger fires its port', async () => {
    // A trigger whose fire reaches no switch anywhere is reported as one plain run rather than as decisions,
    // and the line names the operation it fired. Greeting is that run: its graph holds no switch and reaches
    // nothing guarded. Digest was this case's subject until #437 -- the list it reads is guarded element by
    // element, and the walk now opens that guard's nested spec, so digest reaches a decision after all.
    const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, profile: 'local' });
    expect(run.ok, run.lines.join('\n')).toBe(true);
    expect(run.lines.join('\n')).toMatch(/hello\/domain\/greeting\.port\.json#hello {2}\(no branches\)/);
    // and `(atomic)` is the other word such a line can carry, said where the graph behind a decision says so
    expect(run.lines.join('\n')).toMatch(/store-and-latest {2}\(atomic\) {2}switch 'bothWritten'/);
  });
});

describe('sabotage: what a refusal says to the caller', () => {
  /** The example checked against a copy of the access tree it includes, one document of it edited: code and at, each. */
  function withBrokenInclude(file: string, edit: (doc: any) => void): string[][] {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-access-'));
    cpSync(INCLUDES[0].dir, dir, { recursive: true, filter: path => !path.includes('node_modules') });
    const path = join(dir, file);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    edit(doc);
    writeFileSync(path, JSON.stringify(doc));
    const refusals = checkTree(loadTree(EXAMPLE, PLUGINS, [{ ...INCLUDES[0], dir }])).items;
    rmSync(dir, { recursive: true, force: true });
    return refusals.map(one => [one.code, one.at ?? '']);
  }
  const signIn = 'features/access/domain/sign-in-customer.graph.json';
  const rejected = (message: string) => (graph: any) => {
    graph.nodes.find((node: any) => node.id === 'rejected').in.message = message;
  };

  it('G016 a refuse node whose message reads the password the credential marks secret', () => {
    expect(withBrokenInclude(signIn, rejected('no account {{in.username}} with password {{in.password}}'))).toEqual([
      ['G016', 'nodes/rejected/in/message'],
    ]);
  });
  it('lets the same message read what is not secret', () => {
    expect(withBrokenInclude(signIn, rejected('no account {{in.username}} with that password'))).toEqual([]);
  });
});
