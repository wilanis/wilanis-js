/**
 * `wilanis run <scheduled trigger> --at <time>`: the kind builds the tick a hand-fired run hands, through the
 * trigger runtime's `requestOf`, and the runtime fires it without learning what `--at` means (RFC 0010, open
 * question 1). A trigger whose `fire.in` reads `request.scheduled` gets the instant `--at` names.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadTree, schemaRef } from '@wilanis/core';
import { runTrigger } from '@wilanis/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import schedule, { tickOf } from '../src/index.js';
import { KIND } from '../src/paths.js';
import { type Docs, PLUGINS, refusals, tree } from './tree.js';

const SINCE = 'features/customers/edge/since.trigger.json';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The small tree with a second scheduled trigger whose input is the tick's instant, echoed back as its answer. */
function planted(): Docs {
  return {
    ...tree(),
    'features/customers/domain/Since.shape.json': {
      $schema: schemaRef('shape'),
      description: 'the instant a digest counts up to',
      layer: 'core',
      fields: { before: { type: 'string' } },
    },
    'features/customers/domain/since.port.json': {
      $schema: schemaRef('port'),
      description: 'what a tick asks for up to its own instant',
      operations: {
        since: {
          description: 'the instant handed, answered back',
          accepts: { before: { type: 'string' } },
          returns: '@features/customers/domain/Since.shape.json',
        },
      },
    },
    'features/customers/data/since.binding.json': {
      $schema: schemaRef('binding'),
      description: 'how the instant is answered',
      port: '@features/customers/domain/since.port.json',
      operations: { since: { graph: '@features/customers/data/since.graph.json' } },
    },
    'features/customers/data/since.graph.json': {
      $schema: schemaRef('graph'),
      description: 'the instant, as it came',
      in: '@features/customers/domain/Since.shape.json',
      out: { type: '@features/customers/domain/Since.shape.json', from: 'echoed' },
      nodes: [
        {
          id: 'echoed',
          type: '@wilanis/node/run.schema.json',
          run: '@std/object.port.json#make',
          in: { value: { before: '{{in.before}}' }, type: '@features/customers/domain/Since.shape.json' },
        },
      ],
    },
    [SINCE]: {
      $schema: schemaRef('trigger'),
      description: 'what was seen before each tick, every night at three',
      kind: '@schedule/schedule.trigger-kind.json',
      settings: { cron: '0 3 * * *', timezone: 'UTC' },
      in: '@features/customers/edge/Cutoff.shape.json',
      out: '@features/customers/edge/Cutoff.shape.json',
      fire: { run: '@features/customers/domain/since.port.json#since', in: { before: '{{request.scheduled}}' } },
    },
  };
}

/** The planted tree on disk, loaded with the plugins it names. */
function loaded() {
  const at = mkdtempSync(join(tmpdir(), 'wilanis-schedule-run-at-'));
  dir = at;
  for (const [relative, doc] of Object.entries(planted())) {
    const path = join(at, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  return loadTree(at, PLUGINS);
}

describe('tickOf: the context a hand-fired tick hands', () => {
  const now = new Date('2026-09-11T03:00:07.250Z');

  it('--at names scheduled, in UTC; fired is now and missed is 0', () => {
    expect(tickOf({ at: '2026-09-11T05:00:00+02:00' }, now)).toEqual({
      scheduled: '2026-09-11T03:00:00.000Z',
      fired: '2026-09-11T03:00:07.250Z',
      missed: 0,
    });
  });

  it('without --at there is no scheduled, and the rest is as a tick would hand it', () => {
    expect(tickOf({}, now)).toEqual({ fired: '2026-09-11T03:00:07.250Z', missed: 0 });
  });

  it.each(['tomorrow', 'true', '2026-09-11', '2026-09-11T03:00:00', '2026-13-11T03:00:00Z'])(
    'refuses %s, naming the flag',
    given => {
      expect(() => tickOf({ at: given }, now)).toThrow(/^--at '.*' is not an ISO 8601 time/);
    },
  );

  it('is the kind runtime’s requestOf', () => {
    const request = schedule.triggers?.[KIND]?.requestOf?.({} as never, {
      flags: { at: '2026-09-11T03:00Z' },
      args: [],
    });
    expect(request?.scheduled).toBe('2026-09-11T03:00:00.000Z');
  });
});

describe('wilanis run <scheduled trigger> --at', () => {
  it('the planted tree checks', () => {
    expect(refusals(planted())).toEqual([]);
  });

  it('fills request.scheduled from --at, and the graph reads it', async () => {
    const { report, answer } = await runTrigger(
      loaded(),
      `@${SINCE}`,
      { flags: { at: '2026-09-11T03:00:00Z' } },
      { log: () => {} },
    );
    expect(report.status).toBe('done');
    expect(answer).toEqual({ before: '2026-09-11T03:00:00.000Z' });
  });

  it('a value that is not a time is refused before anything fires', async () => {
    await expect(runTrigger(loaded(), `@${SINCE}`, { flags: { at: 'last night' } }, { log: () => {} })).rejects.toThrow(
      /--at 'last night' is not an ISO 8601 time/,
    );
  });

  it('without --at, a fire.in that reads scheduled is refused at the edge, as it always was', async () => {
    await expect(runTrigger(loaded(), `@${SINCE}`, {}, { log: () => {} })).rejects.toThrow(/^input: /);
  });

  it('a trigger that reads nothing of the tick fires without --at', async () => {
    const { report, answer } = await runTrigger(
      loaded(),
      '@features/customers/edge/digest.trigger.json',
      {},
      {
        log: () => {},
      },
    );
    expect(report.status).toBe('done');
    expect(answer).toEqual({ count: 0 });
  });
});
