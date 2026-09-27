/**
 * A policy's decision recorded by `wilanis rehearse --record` (RFC 0018): written under `policies/` in the recorded
 * directory, naming the policy and an attaching trigger, and replayed by `regress` through the same root the
 * rehearsal walked, on copies of the example.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree, policyPath, type ResolvedInclude } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { policyRoots, RECORDED, type Rehearsal, regress, rehearse } from '../src/index.js';
import type { PolicyRoot } from '../src/stubbing.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const load = (dir: string, includes: ResolvedInclude[] = INCLUDES) => loadTree(dir, PLUGINS, includes);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const EMPLOYEES_ONLY = '@features/access/edge/employees-only.policy.json';
const UNDER = `${RECORDED}/policies/access.employees-only`;
const ANONYMOUS = `${UNDER}/access.require-employee.isEmployee.anonymous.scenario.json`;

/** The triggers that attach a policy, in path order. */
const attaching = (loaded: LoadResult, policy: string) =>
  loaded.registry
    .all('trigger')
    .filter(one => (one.doc.policies ?? []).some(ref => loaded.resolve(policyPath(ref)) === policy))
    .map(one => one.path)
    .sort();

/** A copy of the included access tree, with one document edited: the example is then loaded against it. */
function editedAccess(file: string, change: (doc: any) => void): ResolvedInclude[] {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-access-'));
  cpSync(INCLUDES[0].dir, dir, { recursive: true, filter: path => !path.includes('node_modules') });
  const doc = read(join(dir, file));
  change(doc);
  writeFileSync(join(dir, file), JSON.stringify(doc, null, 2));
  return [{ ...INCLUDES[0], dir }];
}

describe("rehearse --record: a policy's decision", () => {
  let dir: string;
  let recorded: Rehearsal;
  beforeAll(async () => {
    dir = copyOfExample();
    recorded = await rehearse(load(dir), { record: RECORDED });
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is a root that carries the attaching trigger whose kind and settings it borrowed, the first of its kind in path order', () => {
    const loaded = load(dir);
    const roots: PolicyRoot[] = policyRoots(loaded).filter(one => one.path === EMPLOYEES_ONLY);
    const paths = attaching(loaded, EMPLOYEES_ONLY);
    const kindOf = (path: string) => loaded.registry.get('trigger', path)?.doc.kind;
    const firstOfEach = paths.filter((path, at) => paths.findIndex(other => kindOf(other) === kindOf(path)) === at);
    expect(roots.map(one => one.attaching?.path)).toEqual(firstOfEach);
    for (const root of roots) expect(root.doc.kind).toBe(root.attaching?.doc.kind);
    expect(firstOfEach.length).toBeGreaterThan(1);
  });

  it('is written under policies/, once whatever kinds attach it, naming the policy and the first attaching trigger', () => {
    expect(recorded.ok, recorded.lines.join('\n')).toBe(true);
    const first = attaching(load(dir), EMPLOYEES_ONLY)[0];
    expect(first).toBe('@features/customers/edge/delete-customer.trigger.json');
    expect(recorded.recorded?.written).toContain(ANONYMOUS);
    expect(read(join(dir, ANONYMOUS))).toMatchObject({
      description:
        "employees-only as attached by delete-customer: require-employee 'isEmployee' otherwise routes to anonymous, which refuses as anonymous. Written by wilanis rehearse --record; regenerate it, do not edit it.",
      generated: 'rehearse',
      trigger: first,
      policy: EMPLOYEES_ONLY,
      branch: {
        graph: '@features/access/domain/require-employee.graph.json',
        node: 'isEmployee',
        when: 'else',
        to: 'anonymous',
      },
      seed: 1,
      expect: { status: 'failed', reason: 'anonymous' },
    });
    // one file per branch of the decision, all naming the one trigger, though three kinds' roots were walked
    const files = readdirSync(join(dir, UNDER)).sort();
    expect(files).toEqual([
      'access.require-employee.isEmployee.anonymous.scenario.json',
      'access.require-employee.isEmployee.forbidden.scenario.json',
      'access.require-employee.isEmployee.granted.scenario.json',
    ]);
    for (const file of files) expect(read(join(dir, UNDER, file)).trigger).toBe(first);
    // every policy a trigger attaches has its directory, by its feature and name
    const policies = readdirSync(join(dir, RECORDED, 'policies')).sort();
    expect(policies).toEqual([
      'access.can-register',
      'access.employees-only',
      'access.otp-verified',
      'access.signed-in',
    ]);
  });

  it('is a scenario check accepts and regress replays the same', async () => {
    const loaded = load(dir);
    expect(checkTree(loaded).items).toEqual([]);
    const replayed = await regress(loaded);
    const policy = replayed.results.filter(one => one.scenario.includes('/policies/'));
    expect(policy).toHaveLength((recorded.recorded?.written ?? []).filter(file => file.includes('/policies/')).length);
    expect(policy.length).toBeGreaterThan(0);
    for (const one of policy) expect(one, one.diffs.join('; ')).toMatchObject({ same: true });
  });

  it("replays the policy's decide, so a refusal it now names otherwise is a diff of the reason", async () => {
    const includes = editedAccess('features/access/domain/require-employee.graph.json', doc => {
      doc.nodes.find((node: any) => node.id === 'anonymous').in.reason = 'nobody';
    });
    const replayed = await regress(load(dir, includes));
    const anonymous = replayed.results.find(one => one.scenario === `@${ANONYMOUS}`);
    expect(anonymous?.same).toBe(false);
    expect(anonymous?.diffs).toContain('reason anonymous → nobody');
    expect(replayed.lines).toContainEqual(
      expect.stringMatching(/anonymous\.scenario\.json: DIFF .*reason anonymous → nobody/),
    );
    rmSync(includes[0].dir, { recursive: true, force: true });
  });
});

describe('rehearse --record: a policy nothing attaches', () => {
  it('is walked and not recorded, since a policy scenario replays under a trigger that attaches it', {
    timeout: 120_000,
  }, async () => {
    const dir = copyOfExample();
    const policy = read(join(INCLUDES[0].dir, 'features/access/edge/employees-only.policy.json'));
    writeFileSync(join(dir, 'features/hello/edge/unattached.policy.json'), JSON.stringify(policy, null, 2));
    const loaded = load(dir);
    const root = policyRoots(loaded).find(one => one.path === '@features/hello/edge/unattached.policy.json');
    expect(root).toBeDefined();
    expect(root?.attaching).toBeUndefined();
    const run = await rehearse(loaded, { record: RECORDED });
    expect(run.decisions.some(one => one.triggers.includes('unattached'))).toBe(true);
    expect(existsSync(join(dir, RECORDED, 'policies/hello.unattached'))).toBe(false);
    expect((run.recorded?.written ?? []).some(file => file.includes('unattached'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a scenario regress cannot replay where the policy it names is gone', { timeout: 120_000 }, async () => {
    const dir = copyOfExample();
    await rehearse(load(dir), { record: RECORDED });
    const doc = read(join(dir, ANONYMOUS));
    writeFileSync(join(dir, ANONYMOUS), JSON.stringify({ ...doc, policy: '@features/access/edge/nope.policy.json' }));
    await expect(regress(load(dir))).rejects.toThrow(
      "scenario names unknown policy '@features/access/edge/nope.policy.json', which wilanis check refuses as S005",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
