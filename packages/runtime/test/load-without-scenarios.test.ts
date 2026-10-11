/**
 * A load that leaves scenarios/ unread (issue #906): what `run`, `start`, `migrate`, `map`, the deploy CLI and a
 * served reload load, since none of them judges or replays a scenario. The tree it answers holds no scenario and no
 * answers document, everything else is the same, and a trigger runs to the same answer.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { loadProject, runTrigger } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

/** A copy of the example with the scenarios it keeps, which `copyOfExample` leaves out. */
function copyWithScenarios(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-scenarios-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
  return dir;
}

const RECORDED = ['scenario', 'answers'];
const recorded = (load: LoadResult) => load.registry.files.filter(file => RECORDED.includes(file.kind));
const rest = (load: LoadResult) =>
  load.registry.files.filter(file => !RECORDED.includes(file.kind)).map(file => file.path);

describe('a load without scenarios', () => {
  const dir = copyWithScenarios();
  const full = loadTree(dir, PLUGINS, INCLUDES);
  const lean = loadTree(dir, PLUGINS, INCLUDES, { scenarios: false });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('holds no scenario and no answers document, and every other document the full load holds', () => {
    // the full load is the default, and the copy keeps its recorded runs, so there is something to leave out
    expect(recorded(full).length).toBeGreaterThan(0);
    expect(recorded(lean)).toEqual([]);
    expect(rest(lean)).toEqual(rest(full));
    expect(checkTree(lean).items).toEqual([]);
  });

  it('runs a trigger to the same answer as the full load', async () => {
    const trigger = '@hello/edge/hello-gated.trigger.json';
    const ran = (load: LoadResult) => runTrigger(load, trigger, {}, { seed: 1, log: () => {} });
    const [before, after] = [await ran(full), await ran(lean)];
    expect(after.report.status).toBe(before.report.status);
    expect(after.answer).toEqual(before.answer);
    // a run that reached the greeting, so the two agree on something rather than on nothing
    expect(after.answer).toEqual({ greeting: 'hello, gated' });
  });

  it('is what loadProject reads when asked, and the full tree otherwise', async () => {
    const asked = await loadProject(EXAMPLE, { plugins: PLUGINS, scenarios: false });
    expect(recorded(asked)).toEqual([]);
    expect(recorded(await loadProject(EXAMPLE, { plugins: PLUGINS })).length).toBeGreaterThan(0);
  });
});
