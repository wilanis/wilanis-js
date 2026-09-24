/**
 * A nightly schedule, planted in the example and broken one way at a time. The example keeps its customers per
 * tenant, so every operation over them reads the caller's tenant and the digest reads a view behind a policy;
 * a tick has no caller to be a tenant of, so the example ships no scheduled trigger and keeps only the startup
 * step that would run one. The copy plants `nightly-greeting.trigger.json` in the hello feature, firing
 * `greeting.port.json#hello`, which composes its answer from constants and reaches no collection and no view
 * under any profile, so the planted copy checks clean and each case below breaks exactly the one thing it names.
 *
 * What is judged here is what the *tree* says: @schedule's own band (X251 to X254) against the example, and
 * the rules a scheduled trigger shares with a route, which the compiler already had -- T001 the settings
 * against the kind's contract, T003 a read of a context the kind does not hand, T004 a resolver under a kind
 * that hands no request, A005 a policy reading a caller nobody is, L008 a graph running what only a startup
 * step may, B006 a startup step naming what is not an operation, D008 the trigger outside edge/. The plugin's
 * own unit cases live in `packages/plugin-schedule/test/rules.test.ts`; these say the example proves them too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, planted, plantedEditing, plantedEditingAllAt } from './example-harness.js';

const NIGHTLY = 'features/hello/edge/nightly-greeting.trigger.json';
/** The same document as a refusal names it: canonical, from the tree's root. */
const AT = `@${NIGHTLY}`;
/** The scheduled trigger the copy plants: a tick at three, UTC, firing an operation that needs no caller. */
const TRIGGER = {
  $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/trigger.schema.json',
  label: 'nightly greeting',
  description: 'At three in the morning, UTC, the greeting: nobody is calling, so no policy and nothing to answer.',
  kind: '@schedule/schedule.trigger-kind.json',
  settings: { cron: '0 3 * * *', timezone: 'UTC' },
  out: '@hello/edge/GreetingView.shape.json',
  fire: { run: '@hello/domain/greeting.port.json#hello' },
};
const PLANT = { [NIGHTLY]: TRIGGER };
/** The codes of the planted copy once one of its documents is edited: the trigger, or any other it has. */
const sabotage = (file: string, edit: (doc: any) => void) => plantedEditing(PLANT, file, edit);
/** The same, as `code file#at`. */
const sabotagePointing = (file: string, edit: (doc: any) => void) => plantedEditingAllAt(PLANT, { [file]: edit });
const codesOf = (edit: (doc: any) => void) => sabotage(NIGHTLY, edit);
const pointing = (edit: (doc: any) => void) => sabotagePointing(NIGHTLY, edit);

/** The step that keeps the schedule, found by what it runs, so a step added before it moves nothing here. */
const KEEP = JSON.parse(readFileSync(join(EXAMPLE, 'project.json'), 'utf8')).startup.findIndex(
  (step: { run: string }) => step.run === '@schedule/scheduler.port.json#run',
);

describe('the planted schedule', () => {
  it('checks clean before any case breaks it', () => {
    expect(planted(NIGHTLY, TRIGGER)).toEqual([]);
  });
});

describe('sabotage: a schedule that is not one -- X251', () => {
  it('six fields, where a cron expression has five', () => {
    expect(
      codesOf(trigger => {
        trigger.settings.cron = '0 3 * * * *';
      }),
    ).toEqual(['X251']);
  });
  it('a minute out of range', () => {
    expect(
      codesOf(trigger => {
        trigger.settings.cron = '61 3 * * *';
      }),
    ).toEqual(['X251']);
  });
  it('a weekday that is no day', () => {
    expect(
      codesOf(trigger => {
        trigger.settings.cron = '0 3 * * mon-fry';
      }),
    ).toEqual(['X251']);
  });
  it('a macro, which this parser does not take', () => {
    expect(
      codesOf(trigger => {
        trigger.settings.cron = '@daily';
      }),
    ).toEqual(['X251']);
  });
  it('both cron and everyMs, and neither', () => {
    expect(
      codesOf(trigger => {
        trigger.settings.everyMs = 60000;
      }),
    ).toEqual(['X251']);
    expect(
      codesOf(trigger => {
        trigger.settings = {};
      }),
    ).toEqual(['X251']);
  });
  it('an interval below a second, and one that names a zone', () => {
    expect(
      codesOf(trigger => {
        trigger.settings = { everyMs: 500 };
      }),
    ).toEqual(['X251']);
    expect(
      pointing(trigger => {
        trigger.settings = { everyMs: 60000, timezone: 'UTC' };
      }),
    ).toEqual([`X251 ${AT}#settings/timezone`]);
  });
  it('a zone no runtime knows', () => {
    expect(
      pointing(trigger => {
        trigger.settings.timezone = 'Mars/Olympus';
      }),
    ).toEqual([`X251 ${AT}#settings/timezone`]);
  });
  it("the plugin's own leaseTtlMs, judged where the project sets it", () => {
    expect(
      sabotagePointing('project.json', project => {
        project.plugins.find((plugin: any) => plugin.use === '@schedule').settings = { leaseTtlMs: 10 };
      }),
    ).toEqual(['X251 @project.json#plugins/@schedule/settings/leaseTtlMs']);
  });
});

describe('sabotage: what a tick cannot fill or remember -- X252, X253, X254', () => {
  it('X252 an in nothing fills: nothing arrives on a tick', () => {
    expect(
      pointing(trigger => {
        trigger.in = '@hello/edge/GreetingView.shape.json';
      }),
    ).toEqual([`X252 ${AT}#in`]);
  });
  it("catchUp checks clean, since production's run step keeps its lease in the customer database", () => {
    expect(
      pointing(trigger => {
        trigger.settings.catchUp = true;
      }),
    ).toEqual([]);
  });
  it('X253 catchUp once no run step names a lease', () => {
    expect(
      plantedEditingAllAt(PLANT, {
        [NIGHTLY]: trigger => {
          trigger.settings.catchUp = true;
        },
        'project.json': project => {
          for (const step of project.startup) if (step.in?.lease) step.in = undefined;
        },
      }),
    ).toEqual([`X253 ${AT}#settings/catchUp`]);
  });
  it('X254 a lease on a connection whose kind keeps none', () => {
    expect(
      sabotagePointing('project.json', project => {
        project.startup[KEEP].in = { lease: '@connections/customers-api.connection.json' };
      }),
    ).toEqual([`X254 @project.json#startup/${KEEP}/in/lease`]);
  });
  it('X254 a lease that names no connection at all', () => {
    expect(
      sabotage('project.json', project => {
        project.startup[KEEP].in = { lease: '@connections/nope.connection.json' };
      }),
    ).toEqual(['X254']);
  });
});

describe('sabotage: what a scheduled trigger shares with a route', () => {
  it('T001 a word overlap does not have, and a cron that is not a string', () => {
    // the three words are an enum on the kind's string field, so the type system judges them and no X rule does
    expect(
      codesOf(trigger => {
        trigger.settings.overlap = 'sometimes';
      }),
    ).toEqual(['T001']);
    expect(
      codesOf(trigger => {
        trigger.settings.cron = 3;
      }),
    ).toEqual(['T001']);
  });
  it('T003 a read of a request the kind never hands', () => {
    expect(
      codesOf(trigger => {
        trigger.in = '@customers/edge/ListRequest.shape.json';
        trigger.fire.in = { method: '{{request.body.method}}' };
      }),
    ).toContain('T003');
  });
  it('T004 a resolver, under this trigger, reading a header a tick has none of', () => {
    // record-entry reaches create-row.graph.json, which reads the agent resolver (request.headers['user-agent']);
    // fire that path from the clock and the kind hands no headers at all
    expect(
      codesOf(trigger => {
        trigger.in = '@customers/edge/RegisterRequest.shape.json';
        trigger.out = '@customers/edge/CustomerView.shape.json';
        trigger.fire.run = '@customers/domain/customer.port.json#submit';
        trigger.fire.in = { url: 'https://x.example/', method: 'GET' };
      }),
    ).toContain('T004');
  });
  it('A005 a policy that reads a caller nobody is', () => {
    expect(
      codesOf(trigger => {
        trigger.policies = ['@access/edge/can-register.policy.json'];
      }),
    ).toContain('A005');
  });
  it('D008 the scheduled trigger outside the edge layer', () => {
    expect(planted('features/hello/domain/nightly-greeting.trigger.json', TRIGGER)).toContain('D008');
  });
});

describe('sabotage: what only a startup step may name', () => {
  it('L008 a data graph running the scheduler', () => {
    expect(
      sabotage('features/customers/data/list-rows.graph.json', graph => {
        graph.nodes[0].run = '@schedule/scheduler.port.json#run';
        graph.nodes[0].in = {};
      }),
    ).toContain('L008');
  });
  it('B006 a startup step naming the trigger kind rather than an operation', () => {
    expect(
      sabotage('project.json', project => {
        project.startup[KEEP].run = '@schedule/schedule.trigger-kind.json#run';
      }),
    ).toContain('B006');
  });
});
