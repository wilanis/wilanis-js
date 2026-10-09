/**
 * `wilanis scenarios --pin <file>` (RFC 0036, step 6): one recorded run kept by hand. The copy sits directly under
 * `scenarios/`, writes every answer and stub inline and carries no `generated` mark, so `check` accepts it (no S006, no
 * S007) and `regress` replays it `same`, as it replays the recorded one. On a copy of the example, recorded first.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree } from '@wilanis/compiler';
import { type AnswersDoc, loadTree, nodesOf, type ScenarioDoc, stubsOf } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fuzz, pinScenario, RECORDED, regress, rehearse } from '../src/index.js';
import { scenariosOf } from '../src/scenario-flags.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const RUNTIME = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE = fileURLToPath(new URL('../../..', import.meta.url));
const load = (dir: string) => loadTree(dir, PLUGINS, INCLUDES);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const NAME = 'customers.get-row.outcome.noCustomer.scenario.json';
const FILE = `${RECORDED}/customers.get-customer/${NAME}`;
const PINNED = `scenarios/${NAME}`;
const ANSWERS = `${RECORDED}/answers.json`;

/** The CLI on a copy, from the built runtime. */
function wilanis(dir: string, ...args: string[]) {
  const ran = spawnSync(process.execPath, [join(RUNTIME, 'bin/wilanis.js'), ...args], { cwd: dir, encoding: 'utf8' });
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

let dir: string;
beforeAll(async () => {
  dir = copyOfExample();
  symlinkSync(join(WORKSPACE, 'node_modules'), join(dir, 'node_modules'));
  await rehearse(load(dir), { record: RECORDED });
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the flags scenarios --pin is asked', () => {
  it('takes --pin <file> alone, and refuses --check beside it, a --pin with no file, and any other flag', () => {
    expect(scenariosOf({ pin: FILE })).toEqual({ asked: { pin: FILE } });
    expect(scenariosOf({ pin: FILE, check: 'true' })).toMatchObject({
      refused: expect.stringContaining('run them apart'),
    });
    expect(scenariosOf({ pin: 'true' })).toMatchObject({
      refused: expect.stringContaining('wilanis scenarios [root] --pin <file>'),
    });
    for (const flag of ['json', 'profile', 'seed', 'record'])
      expect(scenariosOf({ pin: FILE, [flag]: 'x' })).toEqual({
        refused: `wilanis scenarios --pin copies one scenario and runs nothing: drop --${flag}`,
      });
    expect(scenariosOf({})).toMatchObject({ refused: expect.stringContaining('or --pin <file>') });
  });
});

describe('scenarios --pin', () => {
  it('writes the recorded run under scenarios/, every pointer written as its value, no generated, no sharedStubs', () => {
    const recorded: ScenarioDoc = read(join(dir, FILE));
    const answers: AnswersDoc = read(join(dir, ANSWERS));
    expect(Object.values(recorded.expect.nodes).every(node => typeof node === 'string')).toBe(true);
    expect(pinScenario(load(dir), FILE)).toEqual({
      ok: true,
      wrote: PINNED,
      line: `wrote ${PINNED} with every answer and stub inline -- give it a description of your own`,
    });
    const pinned = read(join(dir, PINNED));
    expect(pinned.generated).toBeUndefined();
    expect(pinned.sharedStubs).toBeUndefined();
    expect(pinned.description).toBe(
      "get-customer: get-row 'outcome' when status == 404 routes to noCustomer, which refuses as missing. " +
        `Pinned from ${FILE}; say here why it is kept.`,
    );
    expect(pinned.expect).toEqual({ ...recorded.expect, nodes: nodesOf(recorded, answers).nodes });
    expect(Object.keys(pinned.expect.nodes)).toEqual(Object.keys(recorded.expect.nodes));
    expect(pinned.stubs).toEqual(stubsOf(recorded, answers).stubs);
    expect(Object.keys(pinned.stubs)).toEqual(Object.keys(recorded.sharedStubs ?? {}));
    // every other field as the recorded file has it, in its place, with stubs where sharedStubs was
    const { generated: _, sharedStubs: __, ...rest } = recorded;
    const placed = Object.keys(recorded).flatMap(key =>
      key === 'generated' ? [] : [key.replace('sharedStubs', 'stubs')],
    );
    expect(Object.keys(pinned)).toEqual(placed);
    const unchanged = { description: '', stubs: {}, expect: {} };
    expect({ ...pinned, ...unchanged }).toEqual({ ...rest, ...unchanged });
  });

  it('is a scenario check accepts and regress replays the same as the recorded one', { timeout: 120_000 }, async () => {
    const loaded = load(dir);
    expect(checkTree(loaded).items).toEqual([]);
    const { results } = await regress(loaded);
    const result = (path: string) => results.find(one => one.scenario === `@${path}`);
    expect(result(PINNED)).toEqual({ scenario: `@${PINNED}`, same: true, diffs: [] });
    expect(result(FILE)?.same).toBe(true);
  });

  it('refuses a file already there, writing nothing, and says so on the command line with exit 1', () => {
    const before = readFileSync(join(dir, PINNED), 'utf8');
    const again = pinScenario(load(dir), FILE);
    expect(again).toEqual({
      ok: false,
      line: `${PINNED} is there already, and --pin never writes over a file: move it away, then pin again`,
    });
    const cli = wilanis(dir, 'scenarios', '.', '--pin', FILE);
    expect(cli.code).toBe(1);
    expect(cli.stdout).toBe('');
    expect(cli.stderr).toBe(`${again.line}\n`);
    expect(readFileSync(join(dir, PINNED), 'utf8')).toBe(before);
  });

  it('pins on the command line, the path with or without @, and refuses its flags with exit 2 before any run', () => {
    rmSync(join(dir, PINNED));
    const cli = wilanis(dir, 'scenarios', '.', '--pin', `@${FILE}`);
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.stdout).toBe(`wrote ${PINNED} with every answer and stub inline -- give it a description of your own\n`);
    for (const [args, says] of [
      [['--pin', FILE, '--check'], 'run them apart'],
      [['--pin', FILE, '--json'], 'drop --json'],
      [['--pin'], 'wilanis scenarios [root] --pin <file>'],
    ] as const) {
      const refused = wilanis(dir, 'scenarios', '.', ...args);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain(says);
    }
  });

  it('refuses a path that names no scenario, and a pointer its answers file does not hold, saying what to run', () => {
    expect(pinScenario(load(dir), 'scenarios/rehearsed/nothing.scenario.json')).toEqual({
      ok: false,
      line: 'scenarios/rehearsed/nothing.scenario.json is no scenario of this tree: name one by its path below the root, as wilanis ls scenario lists it',
    });
    const answers: AnswersDoc = read(join(dir, ANSWERS));
    const recorded: ScenarioDoc = read(join(dir, FILE));
    const outcome = recorded.expect.nodes['op.outcome'] as string;
    const { [outcome]: _, ...lacking } = answers.nodes;
    writeFileSync(join(dir, ANSWERS), JSON.stringify({ ...answers, nodes: lacking }));
    rmSync(join(dir, PINNED));
    const refused = pinScenario(load(dir), FILE);
    writeFileSync(join(dir, ANSWERS), JSON.stringify(answers));
    expect(refused).toEqual({
      ok: false,
      line:
        `${FILE} points at values --pin cannot read (op.outcome): ${ANSWERS} does not hold them -- run wilanis ` +
        'rehearse --record, which writes the scenario and what it points at again, then pin it again',
    });
  });

  it('pins what plain fuzz wrote too, its first sentence kept whole though the trigger path in it holds dots', async () => {
    const { written } = await fuzz(load(dir), { runs: 1 });
    const from = relative(dir, written[0]).split('\\').join('/');
    const fuzzed: ScenarioDoc = read(written[0]);
    expect(pinScenario(load(dir), from)).toMatchObject({ ok: true, wrote: `scenarios/${basename(from)}` });
    const pinned = read(join(dir, 'scenarios', basename(from)));
    const first = fuzzed.description.slice(0, fuzzed.description.indexOf('. Written by') + 1);
    expect(first).toMatch(/^@features\/.+\.trigger\.json under seed 1: \w+\.$/);
    expect(pinned.description).toBe(`${first} Pinned from ${from}; say here why it is kept.`);
    expect(pinned.generated).toBeUndefined();
    expect(pinned.stubs).toEqual(fuzzed.stubs);
  });
});
