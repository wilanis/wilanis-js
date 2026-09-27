/**
 * What `wilanis rehearse --record` owns (RFC 0018): every scenario under the recorded directory and nothing else --
 * not a scenario a person or fuzz wrote, not what a link inside it leads to -- on copies of the example.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { checkRecorded, RECORDED, rehearse, writeRecorded } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const load = (dir: string) => loadTree(dir, PLUGINS, INCLUDES);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('rehearse --record: what the recorded directory owns', () => {
  it('owns its directory: a stray file in it is removed, a scenario beside it is kept', {
    timeout: 60_000,
  }, async () => {
    const dir = copyOfExample();
    await rehearse(load(dir), { record: RECORDED });
    const { generated: _, ...kept } = read(join(dir, RECORDED, 'hello.hello-gated/whole.scenario.json'));
    const mine = JSON.stringify({ ...kept, description: 'the gated hello, kept by hand' }, null, 2);
    writeFileSync(join(dir, 'scenarios/mine.scenario.json'), mine);
    mkdirSync(join(dir, RECORDED, 'gone-trigger'));
    writeFileSync(join(dir, RECORDED, 'gone-trigger/old.scenario.json'), mine);
    const answer = await rehearse(load(dir), { record: RECORDED });
    expect(existsSync(join(dir, RECORDED, 'gone-trigger'))).toBe(false);
    expect(readFileSync(join(dir, 'scenarios/mine.scenario.json'), 'utf8')).toBe(mine);
    expect(answer.recorded?.written).not.toContain(`${RECORDED}/gone-trigger/old.scenario.json`);
    rmSync(dir, { recursive: true, force: true });
  });

  it('never reaches through a link: what a link inside the directory leads to is left where it is', {
    timeout: 60_000,
  }, async () => {
    const dir = copyOfExample();
    const loaded = load(dir);
    const elsewhere = mkdtempSync(join(tmpdir(), 'wilanis-elsewhere-'));
    writeFileSync(join(elsewhere, 'keep.scenario.json'), '{}');
    mkdirSync(join(dir, RECORDED), { recursive: true });
    symlinkSync(elsewhere, join(dir, RECORDED, 'link'));
    const answer = await rehearse(loaded, { record: RECORDED });
    expect(readFileSync(join(elsewhere, 'keep.scenario.json'), 'utf8')).toBe('{}');
    expect(answer.recorded?.written).not.toContain(`${RECORDED}/link/keep.scenario.json`);
    // a link where a trigger's files go is refused before anything is written or removed
    const docs = {
      'linked-trigger/x.scenario.json': read(join(dir, RECORDED, 'hello.hello-gated/whole.scenario.json')),
    };
    symlinkSync(elsewhere, join(dir, RECORDED, 'linked-trigger'));
    expect(() => writeRecorded(dir, RECORDED, docs)).toThrow(/would be written through a link/);
    expect(readdirSync(elsewhere)).toEqual(['keep.scenario.json']);
    expect(existsSync(join(dir, RECORDED, 'hello.hello-gated/whole.scenario.json'))).toBe(true);
    // and so is a recorded directory that is itself a link out of the tree, or back onto the scenarios' home
    symlinkSync(elsewhere, join(dir, 'scenarios/linked'));
    symlinkSync(join(dir, 'scenarios'), join(dir, 'scenarios/home'));
    for (const linked of ['scenarios/linked', 'scenarios/home'])
      expect(() => writeRecorded(dir, linked, {})).toThrow(`the recorded directory ${linked} leads through a link to `);
    expect(readdirSync(elsewhere)).toEqual(['keep.scenario.json']);
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('owns only a directory below scenarios/ and outside scenarios/fuzz/, and says where one may go', {
    timeout: 60_000,
  }, async () => {
    const dir = copyOfExample();
    const loaded = load(dir);
    mkdirSync(join(dir, 'scenarios/fuzz'), { recursive: true });
    writeFileSync(join(dir, 'scenarios/mine.scenario.json'), '{}');
    writeFileSync(join(dir, 'scenarios/fuzz/get-customer.1.scenario.json'), '{}');
    const where = 'it may be any directory below scenarios/ outside scenarios/fuzz/, as scenarios/rehearsed/ is';
    const refusals = ['scenarios', 'scenarios/', 'scenarios/fuzz', 'scenarios/fuzz/rehearsed', '.', 'features'];
    // and in another case, which a case-insensitive filesystem reads as the same directory
    for (const refused of [...refusals, 'scenarios/FUZZ', 'Scenarios/fuzz', 'SCENARIOS', 'scenarios/Fuzz/new']) {
      expect(() => writeRecorded(dir, refused, {})).toThrow(`--record owns ${refused} and removes every scenario`);
      expect(() => checkRecorded(dir, refused, {})).toThrow(where);
    }
    for (const outside of ['../elsewhere', 'scenarios/../features', join(tmpdir(), 'elsewhere')])
      expect(() => writeRecorded(dir, outside, {})).toThrow(where);
    // judged before the walk, so a refused directory costs no run
    await expect(rehearse(loaded, { record: 'scenarios' })).rejects.toThrow(where);
    expect(readFileSync(join(dir, 'scenarios/mine.scenario.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(dir, 'scenarios/fuzz/get-customer.1.scenario.json'), 'utf8')).toBe('{}');
    for (const cased of ['scenarios/FUZZ', 'Scenarios/fuzz'])
      await expect(rehearse(loaded, { record: cased })).rejects.toThrow(where);
    expect(readFileSync(join(dir, 'scenarios/fuzz/get-customer.1.scenario.json'), 'utf8')).toBe('{}');
    // beside fuzz's directory, under a name of its own, is below the home and outside fuzz's
    expect(writeRecorded(dir, 'scenarios/fuzzy', {})).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("records two features' triggers of one name apart, an included one among them, and refuses two of one feature", {
    timeout: 60_000,
  }, async () => {
    const dir = copyOfExample();
    // a host trigger named as the included access tree's refresh is, which the host cannot rename: the checker accepts
    // it, and each is recorded under its own feature
    const hello = read(join(dir, 'features/hello/edge/hello-gated.trigger.json'));
    writeFileSync(
      join(dir, 'features/hello/edge/refresh.trigger.json'),
      JSON.stringify({ ...hello, settings: { command: 'hello-refresh' } }),
    );
    expect(checkTree(load(dir)).items).toEqual([]);
    const both = await rehearse(load(dir), { record: RECORDED });
    expect(both.recorded?.written).toContain(`${RECORDED}/hello.refresh/whole.scenario.json`);
    expect(both.recorded?.written).toContain(`${RECORDED}/access.refresh/access.refresh.wasGood.renewed.scenario.json`);
    expect((await rehearse(load(dir), { check: true })).recorded?.check).toEqual({ stale: [], missing: [], extra: [] });
    // a second get-customer under the same feature's edge/v2/ would share customers.get-customer/: refused, naming
    // the two files, rather than one's runs dropped for the other's
    const again = read(join(dir, 'features/customers/edge/get-customer.trigger.json'));
    mkdirSync(join(dir, 'features/customers/edge/v2'));
    writeFileSync(
      join(dir, 'features/customers/edge/v2/get-customer.trigger.json'),
      JSON.stringify({ ...again, settings: { ...again.settings, route: '/v2/customers/{id}' } }),
    );
    expect(checkTree(load(dir)).items).toEqual([]);
    const written = readdirSync(join(dir, RECORDED, 'customers.get-customer'));
    await expect(rehearse(load(dir), { record: RECORDED })).rejects.toThrow(
      "two triggers of feature 'customers' are named 'get-customer', and a recorded trigger's scenarios are written " +
        'under its feature and name (customers.get-customer/): rename ' +
        '@features/customers/edge/get-customer.trigger.json or @features/customers/edge/v2/get-customer.trigger.json',
    );
    expect(readdirSync(join(dir, RECORDED, 'customers.get-customer'))).toEqual(written);
    rmSync(dir, { recursive: true, force: true });
  });
});
