import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, loadProject, rehearse } from '../src/index.js';
import { codes, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

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
    expect(text).toMatch(/every branch settled -- 43 branch\(es\), 17 decision\(s\), 16 graph\(s\)/);
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
      '@s3',
      '@schedule',
      '@std',
      '@storage',
      '@storage-memory',
      '@storage-postgres',
    ]);
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
    plugins: Record<string, PluginModule> = PLUGINS,
  ): Promise<{ lines: string[]; codes: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-'));
    cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
    for (const [file, edit] of Object.entries(edits)) {
      const at = join(dir, file);
      const doc = JSON.parse(readFileSync(at, 'utf8'));
      edit(doc);
      writeFileSync(at, JSON.stringify(doc));
    }
    const refused = checkTree(loadTree(dir, plugins, INCLUDES)).items.map(one => one.code);
    const run = await rehearse(loadTree(dir, plugins), { seed: 1, profile });
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

  /**
   * The guide's catch on get-row (RFC 0014): `fetched` breaking routes to `unreachable`, which the example has refuse
   * `upstream` and a case may rewrite as `target`.
   */
  const GetRow = 'features/customers/data/get-row.graph.json';
  const caughtTo = (target: Record<string, unknown>) => (doc: any) => {
    doc.nodes = doc.nodes.map((node: any) =>
      node.id === 'unreachable' ? { type: '@wilanis/node/run.schema.json', id: 'unreachable', ...target } : node,
    );
  };

  it('walks the branch a catch routes to by making the caught effect break', { timeout: 20_000 }, async () => {
    const { lines, codes: refused } = await withEdits({}, 'live');
    expect(refused).toEqual([]);
    const text = lines.join('\n');
    // one more branch than the rules and the else, counted with them
    expect(text).toMatch(/features\/customers\/data\/get-row {2}switch 'outcome' {2}4\/4 branches/);
    expect(text).toMatch(
      /^ {2}ok {2}when fetched broke {2,}refused on purpose at 'unreachable' as upstream: "the customer API could not be reached"$/m,
    );
    // the three branches that were there still settle as they did: the stubbed world breaks only where it is told to
    expect(text).toMatch(/^ {2}ok {2}when status == 404 {2,}refused on purpose at 'noCustomer' as missing: /m);
    expect(text).toMatch(/^ {2}ok {2}when status == 200 && has\(body\) {2,}answered from 'customer/m);
    expect(text).toMatch(/^ {2}ok {2}anything else {2,}refused on purpose at 'upstreamFailed' as upstream: /m);
    expect(text).not.toMatch(/NEVER RUN|BROKE|BLOCKED|WRONG ROUTE/);
    expect(text).toContain('A fault a switch catches is the graph deciding what breaking means.');
  });

  it('names the target that breaks as BROKE, and never the node whose fault was caught', {
    timeout: 20_000,
  }, async () => {
    // `make` runs for real under stubs, since it is pure; this one throws for the one value the target makes
    const std = BUILTIN_PLUGINS['@std'];
    const make = std.handlers['@std/object.port.json#make'];
    const breaking: PluginModule = {
      ...std,
      handlers: {
        ...std.handlers,
        '@std/object.port.json#make': args => {
          if ((args.in.value as { name?: string } | undefined)?.name === 'nobody') throw new Error('target broke');
          return make(args);
        },
      },
    };
    const { lines, codes: refused } = await withEdits(
      {
        [GetRow]: caughtTo({
          run: '@std/object.port.json#make',
          in: {
            value: { id: '{{in.id}}', name: 'nobody', email: 'nobody', tier: 'none' },
            type: '@customers/domain/Customer.shape.json',
          },
        }),
      },
      'live',
      { ...PLUGINS, '@std': breaking },
    );
    expect(refused).toEqual([]);
    const text = lines.join('\n');
    expect(text).toMatch(/^ {2}!! {2}when fetched broke {2,}BROKE at 'unreachable' -- unreachable: target broke$/m);
    expect(text.match(/BROKE/g)).toHaveLength(1);
    expect(text).not.toContain('broke in rehearsal');
    expect(text).not.toMatch(/every branch settled/);
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
