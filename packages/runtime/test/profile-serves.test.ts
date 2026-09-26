/**
 * What a command that fires triggers does under a profile that does not serve some of them (#703). The checker
 * judges a trigger only under the profiles whose startup serves it (#632), so a tool that fired it anywhere else
 * would run what nothing judged there: a route under production-worker, which never listens, would take a
 * binding choice B011 no longer asks for. `rehearse`, `fuzz` and `regress` skip such a trigger and say how many
 * they skipped and where those are served; `run`, asked for that one trigger, refuses it.
 *
 * The example serves its routes under live, local and production, its queue trigger under live, local and
 * production-worker, and its commands everywhere: production-worker leaves out every route, and
 * production-scheduler every route and the queue trigger besides.
 */
import { rmSync } from 'node:fs';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { fuzz, regress, rehearse, runTrigger } from '../src/index.js';
import { copyOfExample, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const ROUTES = '(served under live, local, production)';
const QUEUE = '(served under live, local, production-worker)';
const example = () => loadTree(EXAMPLE, PLUGINS, INCLUDES);
/** What the example's routes are named, as a rehearsal names the triggers that reach a decision. */
const routeNames = example()
  .registry.all('trigger')
  .filter(one => one.doc.kind === '@http/http.trigger-kind.json')
  .map(one => one.name);

describe('rehearse under a profile runs only the triggers it serves', () => {
  it('says first how many it skipped under production-worker, and walks no route', async () => {
    const run = await rehearse(example(), { seed: 1, profile: 'production-worker' });
    expect(run.ok, run.lines.join('\n')).toBe(true);
    expect(run.lines[0]).toBe(`skipped 15 trigger(s) profile 'production-worker' does not serve ${ROUTES}`);
    expect(run.lines[1]).not.toMatch(/^skipped/);
    const ran = [...run.decisions.flatMap(one => one.triggers), ...run.plain.map(one => one.trigger)];
    expect(ran).toContain('remove-queued');
    expect(ran.filter(name => routeNames.includes(name))).toEqual([]);
  });

  it('says a line per set of profiles serving what it skipped: production-scheduler leaves the queue out too', async () => {
    const run = await rehearse(example(), { seed: 1, profile: 'production-scheduler' });
    expect(run.lines.filter(line => line.startsWith('skipped'))).toEqual([
      `skipped 15 trigger(s) profile 'production-scheduler' does not serve ${ROUTES}`,
      `skipped 1 trigger(s) profile 'production-scheduler' does not serve ${QUEUE}`,
    ]);
  });

  it('skips nothing under a profile that serves every trigger', async () => {
    const run = await rehearse(example(), { seed: 1, profile: 'local' });
    expect(run.lines.some(line => line.startsWith('skipped'))).toBe(false);
  });
});

describe('fuzz and regress under a profile leave out what it does not serve', () => {
  it('fuzz writes no scenario of a route under production-worker, and says how many it skipped', async () => {
    const dir = copyOfExample();
    const fuzzed = await fuzz(loadTree(dir, PLUGINS, INCLUDES), { runs: 1, profile: 'production-worker' });
    expect(fuzzed.ok, fuzzed.lines.join('\n')).toBe(true);
    expect(fuzzed.skipped).toEqual([`skipped 15 trigger(s) profile 'production-worker' does not serve ${ROUTES}`]);
    const names = fuzzed.written.map(file =>
      file
        .split('/')
        .pop()
        ?.replace(/\.1\.scenario\.json$/, ''),
    );
    expect(names).toContain('remove-queued');
    expect(names.filter(name => name !== undefined && routeNames.includes(name))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("regress replays no route's scenario under production-worker, and counts the scenarios it skipped", async () => {
    const dir = copyOfExample();
    const fuzzed = await fuzz(loadTree(dir, PLUGINS, INCLUDES), { runs: 1, profile: 'live' });
    expect(fuzzed.skipped).toEqual([]);
    const replayed = await regress(loadTree(dir, PLUGINS, INCLUDES), { profile: 'production-worker' });
    const routes = fuzzed.written.filter(file => routeNames.some(name => file.endsWith(`/${name}.1.scenario.json`)));
    expect(routes).toHaveLength(15);
    expect(replayed.results).toHaveLength(fuzzed.written.length - routes.length);
    expect(replayed.results.some(one => one.scenario.includes('remove-queued'))).toBe(true);
    expect(replayed.lines.at(-1)).toBe(
      `skipped 15 scenario(s) whose trigger profile 'production-worker' does not serve ${ROUTES}`,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('run refuses a trigger the profile does not serve', () => {
  it('names the kind no step serves there and the profiles that serve it, before anything runs', async () => {
    await expect(
      runTrigger(
        example(),
        '@features/customers/edge/get-customer.trigger.json',
        {},
        {
          seed: 1,
          profile: 'production-worker',
        },
      ),
    ).rejects.toThrow(
      "profile 'production-worker' does not serve @features/customers/edge/get-customer.trigger.json: no startup " +
        `step it runs serves kind '@http/http.trigger-kind.json' ${ROUTES}\n` +
        "→ --profile live, or run the step that serves the kind under 'production-worker' too",
    );
    await expect(
      runTrigger(
        example(),
        '@customers/edge/remove-queued.trigger.json',
        {},
        {
          seed: 1,
          profile: 'production-scheduler',
        },
      ),
    ).rejects.toThrow(`serves kind '@queue/queue.trigger-kind.json' ${QUEUE}`);
  });

  it('fires a command under any profile, since its plugin grants nothing a step starts', async () => {
    const { report } = await runTrigger(
      example(),
      '@customers/edge/digest.trigger.json',
      {},
      {
        seed: 1,
        profile: 'production-scheduler',
      },
    );
    expect(report.status).toBe('done');
  });
});
