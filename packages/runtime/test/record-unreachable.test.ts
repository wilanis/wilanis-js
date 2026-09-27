/**
 * A branch no input reaches, recorded by `wilanis rehearse --record` (RFC 0018): written as a scenario that expects to
 * stay unreachable, with nothing to run, and replayed by `regress` solving the branch again rather than firing it, on
 * copies of the example whose list-rows tries a broader rule before its own.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, schemaUrl } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECORDED, type Rehearsal, regress, rehearse } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const load = (dir: string) => loadTree(dir, PLUGINS, INCLUDES);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const LIST_ROWS = 'features/customers/data/list-rows.graph.json';
const COVERED = 'status == 200 && has(body)';
const WHY = `no inputs satisfy '${COVERED}'`;

/** Set list-rows' rules, the else left as it is. */
function rulesOf(dir: string, rules: { when: string; to: string }[]) {
  const doc = read(join(dir, LIST_ROWS));
  doc.nodes.find((node: any) => node.id === 'outcome').rules = rules;
  writeFileSync(join(dir, LIST_ROWS), JSON.stringify(doc, null, 2));
}

/** A copy of a copy, so each change is judged alone against the directory the reordered tree recorded. */
function copyOf(dir: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'wilanis-'));
  cpSync(dir, copy, { recursive: true });
  return copy;
}

/** The triggers whose runs reach list-rows: their name, their document, and the file of the covered branch. */
function reaching(rehearsal: Rehearsal, dir: string): { name: string; path: string; file: string }[] {
  const names = rehearsal.decisions.find(one => one.graph.endsWith(LIST_ROWS))?.triggers ?? [];
  const triggers = load(dir).registry.all('trigger');
  return names.map(name => {
    const trigger = triggers.find(one => one.name === name);
    const file = `${RECORDED}/${trigger?.feature}.${name}/customers.list-rows.outcome.customers.scenario.json`;
    return { name, path: trigger?.path ?? '', file };
  });
}

describe('rehearse --record: a branch no input reaches', () => {
  let dir: string;
  let original: string;
  let recorded: Rehearsal;
  const covered = () => reaching(recorded, dir).map(one => one.file);
  beforeAll(async () => {
    dir = copyOfExample();
    original = readFileSync(join(dir, LIST_ROWS), 'utf8');
    // every status from 200 up is taken before the rule that answers the rows is tried
    rulesOf(dir, [
      { when: 'status >= 200', to: 'upstreamFailed' },
      { when: COVERED, to: 'customers' },
    ]);
    recorded = await rehearse(load(dir), { record: RECORDED });
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('fails the rehearsal as before, and is written expecting to stay unreachable, saying why, with nothing to run', () => {
    expect(checkTree(load(dir)).items).toEqual([]);
    expect(recorded.ok).toBe(false);
    expect(recorded.lines.join('\n')).toContain(`NEVER RUN -- ${WHY}`);
    const ways = reaching(recorded, dir);
    expect(ways.map(one => one.name).sort()).toEqual(['digest', 'export-customers', 'list-customers']);
    for (const way of ways) {
      expect(recorded.recorded?.written).toContain(way.file);
      // the whole document: no in, no context and no stubs, since nothing ran
      expect(read(join(dir, way.file))).toEqual({
        $schema: schemaUrl('scenario'),
        description: `${way.name}: list-rows 'outcome' when ${COVERED} routes to customers, and no input reaches it: ${WHY}. Written by wilanis rehearse --record; regenerate it, do not edit it.`,
        generated: 'rehearse',
        trigger: way.path,
        branch: { graph: `@${LIST_ROWS}`, node: 'outcome', when: COVERED, to: 'customers' },
        seed: 1,
        expect: { status: 'unreachable', nodes: {}, unreachable: WHY },
      });
    }
  });

  it('is a scenario check accepts and regress answers the same while it stays unreachable, and is solved alike again', async () => {
    const loaded = load(dir);
    expect(checkTree(loaded).items).toEqual([]);
    const replayed = await regress(loaded);
    expect(replayed.ok, replayed.lines.filter(line => !line.endsWith(': same')).join('\n')).toBe(true);
    for (const file of covered()) expect(replayed.lines).toContain(`@${file}: same`);
    const checked = await rehearse(load(dir), { check: true });
    expect(checked.ok).toBe(false);
    expect(checked.recorded?.check).toEqual({ stale: [], missing: [], extra: [] });
  }, 60_000);

  it('answers the order restored as a diff that says the branch is reachable now, and check lists the file stale', async () => {
    const restored = copyOf(dir);
    writeFileSync(join(restored, LIST_ROWS), original);
    const replayed = await regress(load(restored));
    expect(replayed.ok).toBe(false);
    for (const file of covered())
      expect(replayed.lines).toContain(`@${file}: DIFF branch '${COVERED}' → customers is reachable now`);
    const checked = await rehearse(load(restored), { check: true });
    expect(checked.ok, checked.lines.join('\n')).toBe(true);
    expect(checked.recorded?.check?.stale).toEqual(expect.arrayContaining(covered()));
    rmSync(restored, { recursive: true, force: true });
  }, 60_000);

  it('answers a rule that is no longer there as a diff, since nothing is left to solve', async () => {
    const rewritten = copyOf(dir);
    rulesOf(rewritten, [
      { when: 'status >= 200', to: 'upstreamFailed' },
      { when: 'status == 201 && has(body)', to: 'customers' },
    ]);
    expect(checkTree(load(rewritten)).items).toEqual([]);
    const replayed = await regress(load(rewritten));
    for (const file of covered())
      expect(replayed.lines).toContain(
        `@${file}: DIFF branch '${COVERED}' → customers is no longer a case of 'outcome' where this trigger reaches it`,
      );
    rmSync(rewritten, { recursive: true, force: true });
  }, 60_000);
});
