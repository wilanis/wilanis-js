/**
 * `wilanis fuzz --edges [--check]` and `wilanis scenarios --check` on the command line (RFC 0018), from the built
 * runtime on copies of the example: what each writes, when each exits 1, and the flags each refuses before any run.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { checkScenarios } from '../src/index.js';
import { edgingOf, recordingOf, scenariosOf } from '../src/scenario-flags.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const RUNTIME = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE = fileURLToPath(new URL('../../..', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const GET_ROW = 'features/customers/data/get-row.graph.json';
const EDGE = 'scenarios/edges/customers.get-customer/id.empty.scenario.json';

/** Edit one document of a copied tree in place. */
function edit(dir: string, file: string, change: (doc: any) => void) {
  const doc = read(join(dir, file));
  change(doc);
  writeFileSync(join(dir, file), JSON.stringify(doc, null, 2));
}

/** A copy of the example the CLI can run in: it reaches the workspace's plugins through a linked node_modules. */
function runnableCopy(): string {
  const dir = copyOfExample();
  symlinkSync(join(WORKSPACE, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

/** The CLI on a copy, from the built runtime. */
function wilanis(dir: string, ...args: string[]) {
  const ran = spawnSync(process.execPath, [join(RUNTIME, 'bin/wilanis.js'), ...args], { cwd: dir, encoding: 'utf8' });
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

describe('the flags the scenario commands are asked', () => {
  it('answers what to run with, or why the flags are refused', () => {
    expect(edgingOf({})).toEqual({ asked: {} });
    expect(edgingOf({ edges: 'true', check: 'true' })).toEqual({ asked: { edges: true, check: true } });
    expect(edgingOf({ check: 'true' })).toEqual({
      refused: '--check judges what fuzz --edges wrote: fuzz --edges --check',
    });
    for (const flag of ['runs', 'seed', 'profile', 'out', 'json'])
      expect(edgingOf({ edges: 'true', [flag]: '2' })).toMatchObject({
        refused: expect.stringContaining(`drop --${flag}`),
      });
    // plain fuzz takes what it took
    expect(edgingOf({ runs: '2', profile: 'live' })).toEqual({ asked: {} });
    expect(scenariosOf({ check: 'true' })).toEqual({ asked: { check: true } });
    expect(scenariosOf({})).toMatchObject({ refused: expect.stringContaining('add --check') });
    for (const flag of ['json', 'seed', 'profile', 'record'])
      expect(scenariosOf({ check: 'true', [flag]: 'x' })).toMatchObject({
        refused: expect.stringContaining(`drop --${flag}`),
      });
    expect(recordingOf({ record: 'scenarios/edges' }, WORKSPACE)).toMatchObject({
      refused: expect.stringContaining(
        '--record may not own scenarios/edges, beside the scenarios a person or fuzz wrote',
      ),
    });
  });
});

describe('fuzz --edges on the command line', () => {
  it('writes, says a directory is current, exits 1 on a stale one, and refuses --check alone and what --edges does not read', {
    timeout: 120_000,
  }, () => {
    const dir = runnableCopy();
    const alone = wilanis(dir, 'fuzz', '.', '--check');
    expect(alone.code).toBe(2);
    expect(alone.stderr).toContain('--check judges what fuzz --edges wrote: fuzz --edges --check');
    for (const [flag, value] of [
      ['--runs', '2'],
      ['--profile', 'live'],
      ['--seed', '2'],
    ]) {
      const refused = wilanis(dir, 'fuzz', '.', '--edges', flag, value);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain(`drop ${flag}`);
    }
    const json = wilanis(dir, 'fuzz', '.', '--edges', '--check', '--json');
    expect(json.code).toBe(2);
    expect(json.stdout).toBe('');
    expect(json.stderr).toContain("an envelope for staleness is RFC 0019's to add: drop --json");
    const written = wilanis(dir, 'fuzz', '.', '--edges');
    expect(written.code, written.stderr).toBe(0);
    expect(written.stdout).toMatch(
      /^wrote \d+ scenario\(s\) under scenarios\/edges\/ -- regenerate them, do not edit them$/m,
    );
    const current = wilanis(dir, 'fuzz', '.', '--edges', '--check');
    expect(current.code).toBe(0);
    expect(current.stdout).toMatch(/^scenarios\/edges\/ is what fuzz --edges writes for this tree: \d+ file\(s\)$/m);
    edit(dir, EDGE, doc => {
      doc.expect.status = 'done';
    });
    const stale = wilanis(dir, 'fuzz', '.', '--edges', '--check');
    expect(stale.code).toBe(1);
    expect(stale.stdout).toBe(
      `stale    ${EDGE}\n1 file(s) differ from what fuzz --edges writes for this tree -- run wilanis fuzz --edges and review the diff\n`,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('scenarios --check', () => {
  it('runs both checks and exits 1 when either directory differs, 0 once both are what the tree writes', {
    timeout: 180_000,
  }, () => {
    const dir = runnableCopy();
    for (const [args, says] of [
      [[], 'add --check'],
      [['--check', '--json'], "an envelope for staleness is RFC 0019's to add: drop --json"],
      [['--check', '--profile', 'live'], 'drop --profile'],
    ] as const) {
      const refused = wilanis(dir, 'scenarios', '.', ...args);
      expect(refused.code).toBe(2);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain(says);
    }
    // nothing recorded yet: both directories are missing every file
    const bare = wilanis(dir, 'scenarios', '.', '--check');
    expect(bare.code).toBe(1);
    expect(bare.stdout).toContain('missing  scenarios/rehearsed/hello.hello-gated/whole.scenario.json');
    expect(bare.stdout).toContain(`missing  ${EDGE}`);
    expect(wilanis(dir, 'rehearse', '.', '--record').code).toBe(0);
    // the rehearsed directory is current, and the edges one is not, which fails the step alone
    const half = wilanis(dir, 'scenarios', '.', '--check');
    expect(half.code).toBe(1);
    expect(half.stdout).toMatch(/^scenarios\/rehearsed\/ is what the solver writes for this tree: \d+ file\(s\)$/m);
    expect(half.stdout).toContain(`missing  ${EDGE}`);
    expect(wilanis(dir, 'fuzz', '.', '--edges').code).toBe(0);
    const both = wilanis(dir, 'scenarios', '.', '--check');
    expect(both.code, both.stdout).toBe(0);
    expect(both.stdout.trimEnd().split('\n')).toEqual([
      expect.stringMatching(/^scenarios\/rehearsed\/ is what the solver writes for this tree: \d+ file\(s\)$/),
      expect.stringMatching(/^scenarios\/edges\/ is what fuzz --edges writes for this tree: \d+ file\(s\)$/),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails on a failed rehearsal, however current both directories are, and a caller without the CLI reads the same', {
    timeout: 180_000,
  }, async () => {
    const dir = runnableCopy();
    // a rule no input satisfies: the rehearsal cannot reach it, and fails
    edit(dir, GET_ROW, doc => {
      doc.nodes
        .find((node: any) => node.id === 'outcome')
        .rules.push({ when: 'status == 404 && status == 200', to: 'upstreamFailed' });
    });
    expect(wilanis(dir, 'rehearse', '.', '--record').code).toBe(1);
    expect(wilanis(dir, 'fuzz', '.', '--edges').code).toBe(0);
    const checked = wilanis(dir, 'scenarios', '.', '--check');
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain('NEVER RUN');
    expect(checked.stdout).toContain('scenarios/rehearsed/ is what the solver writes for this tree');
    expect(checked.stdout).toContain('scenarios/edges/ is what fuzz --edges writes for this tree');
    const answer = await checkScenarios(loadTree(dir, PLUGINS, INCLUDES));
    expect(answer.ok).toBe(false);
    expect(answer.rehearsal.ok).toBe(false);
    expect(answer.edges.recorded?.check).toEqual({ stale: [], missing: [], extra: [] });
    expect(`${answer.lines.join('\n')}\n`).toBe(checked.stdout);
    rmSync(dir, { recursive: true, force: true });
  });
});
