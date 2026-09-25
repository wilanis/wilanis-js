/**
 * docs/demo.md held to the tree it presents. `demo.test.ts` asserts what each beat points at and `build.mjs`
 * runs the script and asserts its payoffs, but neither read what docs/demo.md prints, and each kept numbers of
 * its own: when the example grew, the test's were bumped and the script's were not, so the script said 205
 * documents to a tree of 221 while every test passed. Here what the script prints -- the counts, the codes of
 * each check, the rule's reach, the rehearsal, the map, the file the closer imports, the startup line -- is read
 * out of docs/demo.md and compared with what the tree answers at that beat, and the counts also with
 * `docs/demo/lib/expected.mjs`, the one place `build.mjs` asserts its run against.
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LoadResult, loadTree } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODES, DOCUMENTS, LOCAL_STARTUP_STEPS, REGISTRATION } from '../../../docs/demo/lib/expected.mjs';
import { describe as describeDoc, map, rehearse, scaffold } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS, refusalsAt } from './example-harness.js';
import { startedUnder } from './roles-harness.js';

const DEMO = fileURLToPath(new URL('../../../docs/demo', import.meta.url));
const SCRIPT = readFileSync(fileURLToPath(new URL('../../../docs/demo.md', import.meta.url)), 'utf8');
const ROUTE = 'features/customers/edge/archive-customer.trigger.json';
const POLICY = '@access/edge/can-register.policy.json';

/** Every fenced block of the script, its text without the fences. */
const BLOCKS = [...SCRIPT.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map(found => found[1].replace(/\n$/, ''));

/** The `count` blocks the script prints after the block that is exactly `command`: what it says the command answers. */
function answersTo(command: string, count = 1): string[] {
  const at = BLOCKS.indexOf(command);
  expect(at, `docs/demo.md runs ${command}`).toBeGreaterThanOrEqual(0);
  return BLOCKS.slice(at + 1, at + 1 + count);
}

/** Each check the script prints that refuses: the codes it lists and the count it ends on. */
const checksRefusing = () =>
  BLOCKS.filter(block => /\n\d+ refusal\(s\)$/.test(block)).map(block => ({
    codes: [...block.matchAll(/^([A-Z]\d{3}) {2}/gm)].map(found => found[1]),
    count: Number(/(\d+) refusal\(s\)$/.exec(block)?.[1]),
  }));

let dir: string;
beforeAll(() => {
  dir = copyOfExample();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const load = (): LoadResult => loadTree(dir, PLUGINS, INCLUDES);
const codesNow = () => refusalsAt(dir).map(one => one.split(' ')[0]);
const paste = (name: string) => copyFileSync(join(DEMO, name), join(dir, ROUTE));

describe('docs/demo.md says what the tree answers', () => {
  it('prints the counts the tree has and build.mjs asserts', () => {
    expect(load().registry.files.length).toBe(DOCUMENTS.shipped);
    expect([...SCRIPT.matchAll(/^ok: (\d+) documents$/gm)].map(found => Number(found[1]))).toEqual([
      DOCUMENTS.shipped,
      DOCUMENTS.finished,
    ]);
    expect(SCRIPT).toContain(`Every one of the ${DOCUMENTS.shipped} is a JSON document`);
    expect(SCRIPT).toContain(`reload: ${DOCUMENTS.finished} documents, serving the new tree`);
    expect(checksRefusing()).toEqual(
      [CODES.scaffolded, CODES.hinted, CODES.gated].map(codes => ({ codes, count: codes.length })),
    );
  });

  it('beat 1 prints the rule reach as describe answers it', () => {
    const said = describeDoc(load(), '@customers/domain/writes-are-for-registrars.invariant.json');
    const [printed] = answersTo('npx wilanis describe @customers/domain/writes-are-for-registrars.invariant.json .');
    expect(said.slice(said.indexOf('access:')).trimEnd()).toBe(printed);
  });

  it('beats 2 and 3 answer the codes it prints, and the finished route the count', () => {
    scaffold(dir, 'trigger', 'features/customers/edge/archive-customer', {
      run: '@customers/domain/customer.port.json#remove',
      kind: '@http/http.trigger-kind.json',
    });
    expect(codesNow()).toEqual(CODES.scaffolded);
    paste('archive-customer.step2.trigger.json');
    expect(codesNow()).toEqual(CODES.hinted);
    // the one line the I001 hint says, written after `out` as build.mjs writes it
    const file = join(dir, ROUTE);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const edited = Object.fromEntries(
      Object.entries(doc).flatMap(([key, value]) =>
        key === 'out'
          ? [
              [key, value],
              ['policies', [POLICY]],
            ]
          : [[key, value]],
      ),
    );
    writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
    expect(codesNow()).toEqual(CODES.gated);
    paste('archive-customer.step3.trigger.json');
    expect(codesNow()).toEqual([]);
    expect(load().registry.files.length).toBe(DOCUMENTS.finished);
  });

  it('beat 4 prints the rehearsal and the map of the finished route', async () => {
    paste('archive-customer.step3.trigger.json');
    const run = await rehearse(load(), { seed: 1, profile: 'local' });
    const said = run.lines.join('\n');
    for (const printed of answersTo('npx wilanis rehearse . --profile local', 2)) expect(said).toContain(printed);
    const [route] = answersTo('npx wilanis map . --profile local');
    const lines = map(load(), 'local');
    const start = lines.findIndex(line => line.startsWith(`@${ROUTE}  `));
    const end = lines.findIndex((line, at) => at > start && line.startsWith('@'));
    expect(lines.slice(start, end).join('\n')).toBe(route);
  });

  it('beats 5 and 6 print what local starts, what bo registers, and the file the closer imports', async () => {
    const started = await startedUnder(load(), 'local');
    expect(started).toHaveLength(LOCAL_STARTUP_STEPS);
    expect(started.at(-1)?.run).toBe('@http/server.port.json#listen');
    expect(SCRIPT).toContain(`\`startup ${LOCAL_STARTUP_STEPS}/${LOCAL_STARTUP_STEPS} Listen: ok\``);
    expect(SCRIPT).toContain(`-d '${REGISTRATION}'`);
    const registered = JSON.parse(REGISTRATION);
    const [answered] = answersTo(BLOCKS.find(block => block.includes(`-d '${REGISTRATION}'`)) ?? '');
    for (const line of answered.split('\n'))
      expect(JSON.parse(line.replace(/ {2}\[\d+\]$/, ''))).toMatchObject(registered);
    const [csv] = answersTo('cat $DEMO/customers.bad.csv');
    expect(csv).toBe(readFileSync(join(DEMO, 'customers.bad.csv'), 'utf8').trimEnd());
  });
});
