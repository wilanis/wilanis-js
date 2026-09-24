/**
 * RFC 0019's envelope: what `--json` prints on `check`, `rehearse` and `regress`, asserted on copies of the example
 * against the published schema, and the command line that prints it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree, type Refusal } from '@wilanis/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { diagnosticsOf, fuzz, regress, rehearse, withRegression, withRehearsal } from '../src/index.js';
import { copyOfExample, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const RUNTIME = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE = fileURLToPath(new URL('../../..', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const schema = read(join(RUNTIME, 'schemas/diagnostics.schema.json'));
const valid = new Ajv2020({ allErrors: true }).compile(schema);
const conforms = (envelope: unknown) => (valid(envelope) ? [] : valid.errors);

const load = (dir: string) => loadTree(dir, PLUGINS, INCLUDES);
const checked = (loaded: LoadResult, command = 'check') =>
  diagnosticsOf(loaded, checkTree(loaded), { command, root: 'example' });

/** Edit one document of a copied tree in place. */
function edit(dir: string, file: string, change: (doc: any) => void) {
  const doc = read(join(dir, file));
  change(doc);
  writeFileSync(join(dir, file), JSON.stringify(doc, null, 2));
}

/** The customers feature no longer allows the HTTP request its data graphs and binding run: L003, with its fix. */
const withoutRequest = (dir: string) =>
  edit(dir, 'features/customers/feature.json', doc => {
    doc.effects = doc.effects.filter((one: string) => one !== '@http/http.port.json#request');
  });

/** A copy of the example, broken by `change`, handed to `use` and removed afterwards. */
async function onCopy<T>(change: (dir: string) => void, use: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = copyOfExample();
  try {
    change(dir);
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('diagnosticsOf: the check envelope', () => {
  it('carries every refusal with its family, its page and its fix, sorted by file, and validates', async () => {
    await onCopy(withoutRequest, dir => {
      const loaded = load(dir);
      const envelope = checked(loaded);
      expect(conforms(envelope)).toEqual([]);
      expect(envelope).toMatchObject({ format: 1, command: 'check', root: 'example', ok: false });
      expect(envelope.runtime).toBe(read(join(RUNTIME, 'package.json')).version);
      expect(envelope.documents).toBe(loaded.registry.files.length);
      // one refusal per graph and binding that runs the request, as many as the checker made and every one L003
      expect(envelope.refusals).toHaveLength(checkTree(loaded).items.length);
      expect(envelope.refusals.length).toBeGreaterThan(1);
      const files = envelope.refusals.map(one => one.file);
      expect(files).toEqual([...files].sort());
      for (const one of envelope.refusals)
        expect(one).toMatchObject({
          code: 'L003',
          family: 'L',
          url: 'https://github.com/wilanis/wilanis-js/blob/main/docs/refusals/L003.md',
          fixes: [{ file: '@features/customers/feature.json', at: 'effects', add: '@http/http.port.json#request' }],
        });
    });
  });

  it('prints the same bytes twice, and whatever order the checker found the refusals in', async () => {
    await onCopy(withoutRequest, dir => {
      const loaded = load(dir);
      const found = checkTree(loaded);
      const how = { command: 'check', root: 'example' };
      const once = JSON.stringify(diagnosticsOf(loaded, found, how));
      expect(JSON.stringify(diagnosticsOf(load(dir), checkTree(load(dir)), how))).toBe(once);
      expect(JSON.stringify(diagnosticsOf(loaded, { items: [...found.items].reverse() }, how))).toBe(once);
    });
  });

  it('puts the misspelt operation before the rules that read what it no longer provides, in one file', async () => {
    const typo = (dir: string) =>
      edit(dir, 'features/customers/data/get-row.graph.json', doc => {
        doc.nodes.find((node: any) => node.id === 'fetched').run = '@http/http.port.json#requst';
      });
    await onCopy(typo, dir => {
      const envelope = checked(load(dir));
      const inRow = envelope.refusals.filter(one => one.file === '@features/customers/data/get-row.graph.json');
      expect(inRow[0]).toMatchObject({ code: 'R001', at: 'nodes/fetched/run' });
      expect(inRow.slice(1).map(one => one.code)).toContain('G011');
      expect(conforms(envelope)).toEqual([]);
    });
  });

  it('sorts by file, then at with the whole-file refusal first, then code, then message', () => {
    const one = (code: string, file: string, at?: string, message = 'm'): Refusal => ({
      code,
      file,
      at,
      message,
      hint: 'h',
    });
    const items = [
      one('G011', '@b.json', 'nodes/route'),
      one('R001', '@b.json', 'nodes/asked', 'z'),
      one('R001', '@b.json', 'nodes/asked', 'a'),
      one('D008', '@b.json'),
      one('C001', '@a.json', 'x'),
    ];
    const sorted = diagnosticsOf(load(EXAMPLE), { items }, { command: 'check', root: '.' }).refusals;
    expect(sorted.map(it => `${it.file} ${it.at ?? '-'} ${it.code} ${it.message}`)).toEqual([
      '@a.json x C001 m',
      '@b.json - D008 m',
      '@b.json nodes/asked R001 a',
      '@b.json nodes/asked R001 z',
      '@b.json nodes/route G011 m',
    ]);
    // a whole-file refusal carries no `at` at all, not an empty one
    expect('at' in sorted[1]).toBe(false);
  });

  it('gives an X code no page where a plugin from outside this workspace has a check', async () => {
    const items = [{ code: 'X101', file: '@a.json', message: 'm', hint: 'h' }];
    const how = { command: 'check', root: '.' };
    expect(diagnosticsOf(load(EXAMPLE), { items }, how).refusals[0].url).toMatch(/docs\/refusals\/X101\.md$/);
    // the same @auth module, said to come from a package of someone else's: nothing tells its X codes from ours
    const foreign = (dir: string) =>
      edit(dir, 'project.json', doc => {
        doc.plugins.find((use: any) => use.use === '@auth').from = 'acme-auth';
      });
    await onCopy(foreign, dir => {
      const elsewhere = load(dir);
      expect('url' in diagnosticsOf(elsewhere, { items }, how).refusals[0]).toBe(false);
      // a checker family keeps its page whoever the plugins are
      const l003 = diagnosticsOf(elsewhere, { items: [{ ...items[0], code: 'L003' }] }, how).refusals[0];
      expect(l003.url).toMatch(/docs\/refusals\/L003\.md$/);
    });
  });

  it('says of the untouched tree that it is ok, with no refusal and nothing else', () => {
    const loaded = load(EXAMPLE);
    const envelope = checked(loaded);
    expect(Object.keys(envelope)).toEqual(['format', 'runtime', 'command', 'root', 'ok', 'documents', 'refusals']);
    expect(envelope).toMatchObject({ ok: true, refusals: [], documents: loaded.registry.files.length });
    expect(conforms(envelope)).toEqual([]);
  });
});

describe('withRehearsal and withRegression: what rehearse and regress computed, as data', () => {
  it('carries every decision and branch the lines count, the branchless runs, and no time', {
    timeout: 60_000,
  }, async () => {
    const loaded = load(EXAMPLE);
    const run = () => rehearse(loaded, { seed: 1, profile: 'live' });
    const envelope = withRehearsal(checked(loaded, 'rehearse'), await run());
    expect(conforms(envelope)).toEqual([]);
    expect(envelope).toMatchObject({ command: 'rehearse', ok: true, seed: 1 });
    // the counts are the summary line's: the data and the words are one computation
    const summary = envelope.lines?.find(line => line.startsWith('every branch settled')) ?? '';
    const [, branches, decisions] = /(\d+) branch\(es\), (\d+) decision\(s\)/.exec(summary) ?? [];
    const all = (envelope.decisions ?? []).flatMap(one => one.branches);
    expect(envelope.decisions).toHaveLength(Number(decisions));
    expect(all).toHaveLength(Number(branches));
    expect((envelope.plain ?? []).map(one => one.trigger).sort()).toEqual([
      'get-preferences',
      'hello-gated',
      'set-preferences',
      'sign-out',
    ]);
    for (const branch of all) {
      // a guard an enclosing graph already judged on this path is held there and never run (RFC 0035): under live,
      // update-row's in:check behind update-customer's customer:check, which says where it was held, not how it settled
      if (branch.held) {
        expect(branch.settled).toBeUndefined();
        continue;
      }
      expect(branch.settled).toMatchObject({ status: expect.any(String), blocked: expect.any(Boolean) });
      expect(branch.settled).not.toHaveProperty('ms');
    }
    expect(all.some(branch => branch.held)).toBe(true);
    expect(JSON.stringify(withRehearsal(checked(loaded, 'rehearse'), await run()))).toBe(JSON.stringify(envelope));
  });

  it('answers one result per scenario, and names the diffs of those a changed graph no longer matches', {
    timeout: 60_000,
  }, async () => {
    await onCopy(
      () => undefined,
      async dir => {
        await fuzz(load(dir), { runs: 1, profile: 'live' });
        const loaded = load(dir);
        const same = withRegression(checked(loaded, 'regress'), await regress(loaded, { profile: 'live' }));
        expect(conforms(same)).toEqual([]);
        expect(same.ok).toBe(true);
        expect(same.results).toHaveLength(loaded.registry.all('scenario').length);
        expect(same.results?.every(one => one.same && one.diffs.length === 0)).toBe(true);
        // the answering node renamed: every scenario of get-customer recorded a node that is gone
        edit(dir, 'features/customers/data/get-row.graph.json', doc => {
          doc.nodes.find((node: any) => node.id === 'customer').id = 'renamed';
          doc.nodes.find((node: any) => node.id === 'outcome').rules[1].to = 'renamed';
          doc.out.from = ['renamed', 'noCustomer', 'upstreamFailed'];
        });
        const again = load(dir);
        const changed = withRegression(checked(again, 'regress'), await regress(again, { profile: 'live' }));
        expect(changed.ok).toBe(false);
        const customer = changed.results?.filter(one => one.scenario.includes('get-customer.')) ?? [];
        expect(customer.length).toBeGreaterThan(0);
        for (const one of customer)
          expect(one).toMatchObject({ same: false, diffs: expect.arrayContaining([expect.any(String)]) });
        expect(changed.lines).toEqual(
          changed.results?.map(one => `${one.scenario}: ${one.same ? 'same' : `DIFF ${one.diffs.join('; ')}`}`),
        );
      },
    );
  });
});

/** The CLI on a copy, from the built runtime: the copy reaches the workspace's plugins through a linked node_modules. */
function wilanis(dir: string, ...args: string[]) {
  const ran = spawnSync(process.execPath, [join(RUNTIME, 'bin/wilanis.js'), ...args], { cwd: dir, encoding: 'utf8' });
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}
const linked = (change: (dir: string) => void) => (dir: string) => {
  symlinkSync(join(WORKSPACE, 'node_modules'), join(dir, 'node_modules'));
  change(dir);
};

describe('--json on the command line', () => {
  it('prints the check envelope on stdout alone and exits 1, whichever command met the refused tree', {
    timeout: 60_000,
  }, async () => {
    await onCopy(linked(withoutRequest), dir => {
      const check = wilanis(dir, 'check', '.', '--json');
      expect(check.code).toBe(1);
      expect(check.stderr).toBe('');
      expect(JSON.parse(check.stdout)).toMatchObject({
        command: 'check',
        root: '.',
        ok: false,
        refusals: expect.any(Array),
      });
      const rehearsed = wilanis(dir, 'rehearse', '--json');
      expect(rehearsed.code).toBe(1);
      expect(rehearsed.stderr).toBe('');
      const envelope = JSON.parse(rehearsed.stdout);
      expect(envelope.command).toBe('rehearse');
      expect(envelope.refusals).toEqual(JSON.parse(check.stdout).refusals);
      expect(envelope).not.toHaveProperty('decisions');
      const migrated = wilanis(dir, 'migrate', '--json');
      expect(migrated.code).toBe(1);
      expect(migrated.stderr).toBe('');
      expect(JSON.parse(migrated.stdout)).toEqual({ ...JSON.parse(check.stdout), command: 'migrate', root: '.' });
    });
  });

  it('prints what rehearse and regress computed on an accepted tree and exits 0', { timeout: 60_000 }, async () => {
    await onCopy(
      linked(() => undefined),
      dir => {
        const check = wilanis(dir, 'check', '--json');
        expect(check.code).toBe(0);
        expect(JSON.parse(check.stdout)).toMatchObject({ command: 'check', ok: true, refusals: [] });
        const rehearsed = wilanis(dir, 'rehearse', '--json', '--profile', 'live');
        expect(rehearsed.code).toBe(0);
        expect(rehearsed.stderr).toBe('');
        const envelope = JSON.parse(rehearsed.stdout);
        expect(conforms(envelope)).toEqual([]);
        expect(envelope.decisions.length).toBeGreaterThan(0);
        const regressed = wilanis(dir, 'regress', '--json', '--profile', 'live');
        expect(regressed.code).toBe(0);
        expect(JSON.parse(regressed.stdout)).toMatchObject({ command: 'regress', ok: true, results: [], lines: [] });
      },
    );
  });

  it('keeps a missing project.json a line on stderr and exit 2', async () => {
    await onCopy(
      dir => rmSync(join(dir, 'project.json')),
      dir => {
        const ran = wilanis(dir, 'check', '--json');
        expect(ran.code).toBe(2);
        expect(ran.stdout).toBe('');
        expect(ran.stderr).toMatch(/^no project\.json in /);
      },
    );
  });
});
