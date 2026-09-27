/**
 * `wilanis rehearse --record` and `--check` (RFC 0018): the branch solver's runs written to `scenarios/rehearsed/`,
 * and that directory judged against what the tree writes today, on copies of the example.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree } from '@wilanis/compiler';
import { type GraphDoc, isSwitch, type LoadResult, loadTree, type ProjectDoc } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILE_VARIABLE, RECORDED, type Rehearsal, regress, rehearse } from '../src/index.js';
import { recordedProfile } from '../src/profile.js';
import { copyOfExample, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const RUNTIME = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE = fileURLToPath(new URL('../../..', import.meta.url));
const load = (dir: string) => loadTree(dir, PLUGINS, INCLUDES);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const GET_ROW = 'features/customers/data/get-row.graph.json';

/** Edit one document of a copied tree in place. */
function edit(dir: string, file: string, change: (doc: any) => void) {
  const doc = read(join(dir, file));
  change(doc);
  writeFileSync(join(dir, file), JSON.stringify(doc, null, 2));
}

/** Every file under a directory with its bytes, by its path inside it. */
function bytesUnder(dir: string): Record<string, string> {
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.json'));
  return Object.fromEntries(files.sort().map(file => [file, readFileSync(join(dir, file), 'utf8')]));
}

/** Whether a branch is the one a switch's catch routes a fault to: its run breaks a node, which no stub can say. */
function caught(loaded: LoadResult, graph: string, node: string, when: string): boolean {
  const doc = loaded.registry.all('graph').find(one => one.path === loaded.resolve(graph))?.doc as GraphDoc;
  const sw = doc.nodes.find(one => one.id === node);
  return !!sw && isSwitch(sw) && Object.keys(sw.catch ?? {}).some(at => when === `${at} broke`);
}

/**
 * How many files the rehearsal records, read off what it reported: every branch a trigger reached that ran without
 * breaking a node, once per trigger reaching it -- guards aside, since the compiler wrote their switch -- and one
 * whole run per trigger with no switch. A policy's decision is walked but not recorded.
 */
function expectedFiles(loaded: LoadResult, rehearsal: Rehearsal): number {
  const triggers = new Set(loaded.registry.all('trigger').map(one => one.name));
  let count = rehearsal.plain.filter(one => triggers.has(one.trigger)).length;
  for (const decision of rehearsal.decisions) {
    if (decision.guard) continue;
    const ran = decision.branches.filter(
      one => one.settled && !caught(loaded, decision.graph, decision.node, one.when),
    );
    count += ran.length * decision.triggers.filter(one => triggers.has(one)).length;
  }
  return count;
}

/** The directory a trigger's runs are recorded in, `<feature>.<trigger>`, by the trigger's name in the example. */
function underOf(name: string): string {
  const trigger = load(EXAMPLE)
    .registry.all('trigger')
    .find(one => one.name === name);
  return `${RECORDED}/${trigger?.feature}.${name}`;
}

/** The directories of the triggers whose runs reach a graph, as the rehearsal reported them. */
const reaching = (rehearsal: Rehearsal, graph: string) =>
  (rehearsal.decisions.find(one => one.graph.endsWith(graph))?.triggers ?? []).map(underOf);

/** The recorded files of one target of get-row's switch, one per trigger that reaches the graph. */
const filesOf = (rehearsal: Rehearsal, to: string) =>
  reaching(rehearsal, GET_ROW)
    .map(under => `${under}/customers.get-row.outcome.${to}.scenario.json`)
    .sort();

describe('rehearse --record: the recorded directory', () => {
  let dir: string;
  let first: Rehearsal;
  beforeAll(async () => {
    dir = copyOfExample();
    first = await rehearse(load(dir), { record: RECORDED, seed: 7 });
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is complete: one file per trigger and branch, and one per trigger with no switch', () => {
    expect(first.ok, first.lines.join('\n')).toBe(true);
    const written = first.recorded?.written ?? [];
    expect(written).toHaveLength(expectedFiles(load(dir), first));
    expect(Object.keys(bytesUnder(join(dir, RECORDED))).map(file => `${RECORDED}/${file}`)).toEqual(written);
    expect(written).toContain(`${RECORDED}/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json`);
    expect(written).toContain(`${RECORDED}/hello.hello-gated/whole.scenario.json`);
    const sc = read(join(dir, RECORDED, 'customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json'));
    expect(sc).toMatchObject({
      description:
        "get-customer: get-row 'outcome' when status == 404 routes to noCustomer, which refuses as missing. Written by wilanis rehearse --record; regenerate it, do not edit it.",
      generated: 'rehearse',
      trigger: '@features/customers/edge/get-customer.trigger.json',
      branch: { graph: `@${GET_ROW}`, node: 'outcome', when: 'status == 404', to: 'noCustomer' },
      seed: 1,
      stubs: { 'op.fetched': { status: 404 } },
      expect: { status: 'failed', reason: 'missing' },
    });
    // a branch is named by the node the document routes to, not by where a guard moved the made node aside
    expect(written).toContain(
      `${RECORDED}/customers.list-customers/customers.list-rows-by-tier.outcome.none.scenario.json`,
    );
  });

  it('is deterministic: solved under seed 1 whatever seed is asked, and byte-identical a second time', async () => {
    expect(first.seed).toBe(1);
    const before = bytesUnder(join(dir, RECORDED));
    const again = await rehearse(load(dir), { record: RECORDED });
    expect(again.recorded?.written).toEqual(first.recorded?.written);
    expect(bytesUnder(join(dir, RECORDED))).toEqual(before);
    const checked = await rehearse(load(dir), { check: true, seed: 3 });
    expect(checked.recorded?.check).toEqual({ stale: [], missing: [], extra: [] });
  }, 60_000);

  it('is a suite that passes: it loads, check refuses nothing, and regress replays every file the same', async () => {
    const loaded = load(dir);
    expect(loaded.registry.all('scenario')).toHaveLength(first.recorded?.files ?? -1);
    expect(checkTree(loaded).items).toEqual([]);
    const replayed = await regress(loaded);
    expect(replayed.ok, replayed.lines.filter(line => !line.endsWith(': same')).join('\n')).toBe(true);
    expect(replayed.results).toHaveLength(first.recorded?.files ?? -1);
  });
});

describe('rehearse --check: a recorded directory the tree has moved away from', () => {
  it('names the branch a routing change moved, and lists its files stale', { timeout: 60_000 }, async () => {
    const dir = copyOfExample();
    const recorded = await rehearse(load(dir), { record: RECORDED });
    edit(dir, GET_ROW, doc => {
      doc.nodes.find((node: any) => node.id === 'outcome').rules[0].when = 'status == 410';
    });
    const replayed = await regress(load(dir));
    const moved = replayed.lines.filter(line => line.includes('.get-row.outcome.noCustomer.'));
    expect(moved).toHaveLength(filesOf(recorded, 'noCustomer').length);
    for (const line of moved)
      expect(line).toContain(": DIFF branch 'status == 404' → noCustomer no longer routes there: ");
    const checked = await rehearse(load(dir), { check: true });
    expect(checked.recorded?.check).toEqual({
      stale: filesOf(recorded, 'noCustomer'),
      missing: [],
      extra: [],
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers a renamed target as one missing and one extra per trigger, and check refuses the extra as S004', {
    timeout: 60_000,
  }, async () => {
    const dir = copyOfExample();
    const recorded = await rehearse(load(dir), { record: RECORDED });
    edit(dir, GET_ROW, doc => {
      doc.nodes.find((node: any) => node.id === 'noCustomer').id = 'gone';
      doc.nodes.find((node: any) => node.id === 'outcome').rules[0].to = 'gone';
      doc.out.from = doc.out.from.map((id: string) => (id === 'noCustomer' ? 'gone' : id));
    });
    const checked = await rehearse(load(dir), { check: true });
    const extra = filesOf(recorded, 'noCustomer');
    expect(checked.recorded?.check).toMatchObject({ missing: filesOf(recorded, 'gone'), extra });
    // every other run through get-row recorded the node under its old name, so those files are stale and no others
    const through = reaching(recorded, GET_ROW).map(under => `${under}/`);
    expect(checked.recorded?.check?.stale.length).toBeGreaterThan(0);
    for (const file of checked.recorded?.check?.stale ?? []) expect(through.some(at => file.startsWith(at))).toBe(true);
    const refused = checkTree(load(dir)).items.map(one => `${one.code} ${one.file}#${one.at}`);
    expect(refused).toEqual(extra.map(file => `S004 @${file}#branch/to`));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('rehearse --record and --check under a profile', () => {
  it('solve under the profile project.json marks default, whatever profile is asked for or set', {
    timeout: 60_000,
  }, async () => {
    const dir = copyOfExample();
    const recorded = await rehearse(load(dir), { record: RECORDED });
    // production-worker skips most triggers and binds remove-queued to Postgres: read, it would change the answer
    const asked = await rehearse(load(dir), { check: true, profile: 'production-worker' });
    expect(asked.skipped).toEqual(recorded.skipped);
    expect(asked.recorded?.check).toEqual({ stale: [], missing: [], extra: [] });
    const kept = process.env[PROFILE_VARIABLE];
    process.env[PROFILE_VARIABLE] = 'production-worker';
    try {
      const set = await rehearse(load(dir), { check: true });
      expect(set.recorded?.check).toEqual({ stale: [], missing: [], extra: [] });
    } finally {
      if (kept === undefined) delete process.env[PROFILE_VARIABLE];
      else process.env[PROFILE_VARIABLE] = kept;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a project that declares profiles and marks none default, naming the one way to choose', () => {
    expect(recordedProfile(undefined)).toBeUndefined();
    const marked = { profiles: { live: {}, production: { default: true } } } as unknown as ProjectDoc;
    expect(recordedProfile(marked)).toBe('production');
    const unmarked = { profiles: { live: {}, production: {} } } as unknown as ProjectDoc;
    expect(() => recordedProfile(unmarked)).toThrow(
      'which profile? project.json declares live, production and marks none default\n' +
        '→ mark one profile "default": true; rehearse --record and --check solve under it and read no other',
    );
  });
});

/**
 * The CLI on a copy, from the built runtime, with `env` over this process's environment: the copy reaches the
 * workspace's plugins through a linked node_modules.
 */
function wilanisWith(env: Record<string, string>, dir: string, ...args: string[]) {
  const bin = join(RUNTIME, 'bin/wilanis.js');
  const ran = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}
const wilanis = (dir: string, ...args: string[]) => wilanisWith({}, dir, ...args);

describe('rehearse --record and --check on the command line', () => {
  it('writes, says a directory is current, exits 1 on a stale one, and refuses --seed, --profile, --json and a directory it may not own', {
    timeout: 120_000,
  }, () => {
    const dir = copyOfExample();
    symlinkSync(join(WORKSPACE, 'node_modules'), join(dir, 'node_modules'));
    const seeded = wilanis(dir, 'rehearse', '.', '--record', '--seed', '2');
    expect(seeded.code).toBe(2);
    expect(seeded.stderr).toContain('the recorded directory is solved under seed 1: drop --seed');
    // the envelope's ok is the rehearsal's, and the exit code would be the directory's
    for (const args of [
      ['--record', '--json'],
      ['--check', '--json'],
    ]) {
      const json = wilanis(dir, 'rehearse', '.', ...args);
      expect(json.code).toBe(2);
      expect(json.stdout).toBe('');
      expect(json.stderr).toContain("an envelope for staleness is RFC 0019's to add: drop --json");
    }
    // a directory holding what a person or fuzz wrote is refused before anything runs
    for (const at of ['scenarios', 'scenarios/fuzz']) {
      const owned = wilanis(dir, 'rehearse', '.', '--record', at);
      expect(owned.code).toBe(2);
      expect(owned.stderr).toContain(`--record may not own ${at}, beside the scenarios a person or fuzz wrote: `);
    }
    const recorded = wilanis(dir, 'rehearse', '.', '--record');
    expect(recorded.code, recorded.stderr).toBe(0);
    expect(recorded.stdout).toMatch(/wrote \d+ scenario\(s\) under scenarios\/rehearsed\//);
    const current = wilanis(dir, 'rehearse', '.', '--check');
    expect(current.code).toBe(0);
    expect(current.stdout).toContain('scenarios/rehearsed/ is what the solver writes for this tree');
    // --profile is refused and WILANIS_PROFILE is not read, so no caller's environment changes the answer
    const profiled = wilanis(dir, 'rehearse', '.', '--check', '--profile', 'production-worker');
    expect(profiled.code).toBe(2);
    expect(profiled.stderr).toContain('so that it is a function of the tree alone: drop --profile');
    const set = wilanisWith({ [PROFILE_VARIABLE]: 'production-worker' }, dir, 'rehearse', '.', '--check');
    expect(set.code, set.stdout).toBe(0);
    expect(set.stdout).toBe(current.stdout);
    const file = 'scenarios/rehearsed/customers.get-customer/customers.get-row.outcome.noCustomer.scenario.json';
    edit(dir, file, doc => {
      doc.expect.reason = 'gone';
    });
    for (const args of [['--check'], ['--record', '--check']]) {
      const stale = wilanis(dir, 'rehearse', '.', ...args);
      expect(stale.code).toBe(1);
      expect(stale.stdout).toBe(
        `stale    ${file}\n1 file(s) differ from what the solver writes for this tree -- run wilanis rehearse --record and review the diff\n`,
      );
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 under --check when the rehearsal fails, however current the directory is', { timeout: 120_000 }, () => {
    const dir = copyOfExample();
    symlinkSync(join(WORKSPACE, 'node_modules'), join(dir, 'node_modules'));
    // a rule no input satisfies: the rehearsal cannot reach it, and fails
    edit(dir, GET_ROW, doc => {
      doc.nodes
        .find((node: any) => node.id === 'outcome')
        .rules.push({ when: 'status == 404 && status == 200', to: 'upstreamFailed' });
    });
    const recorded = wilanis(dir, 'rehearse', '.', '--record');
    expect(recorded.code).toBe(1);
    // the directory is what the tree writes, and the check still fails, saying why
    const checked = wilanis(dir, 'rehearse', '.', '--check');
    expect(checked.code, checked.stderr).toBe(1);
    expect(checked.stdout).toContain('scenarios/rehearsed/ is what the solver writes for this tree');
    expect(checked.stdout).toContain('NEVER RUN');
    rmSync(dir, { recursive: true, force: true });
  });
});
