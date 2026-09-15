/**
 * What only @schedule can judge. Each case breaks the small tree one way and expects the code and the place
 * the refusal points at -- a code alone would pass for a refusal about something else entirely.
 *
 * The last block says what is deliberately *not* a rule here: a tree with scheduled triggers and no run step
 * is not refused, as a tree with routes and no listener is not, and what a trigger shares with a route is the
 * T family's and not this plugin's.
 */
import { describe, expect, it } from 'vitest';
import { codes, editing, PLAIN, refusals, TRIGGER, tree } from './tree.js';

const edit = (file: string, change: (doc: any) => void) => refusals(editing(file, change));
const schedule = (change: (doc: any) => void) => edit(TRIGGER, change);
const at = (found: ReturnType<typeof refusals>, code: string) => found.filter(one => one.code === code);

describe('a tree with something to do at night', () => {
  it('stands: a scheduled trigger, a run step, and a lease that can keep a hold', () => {
    expect(refusals(tree())).toEqual([]);
  });
});

describe('X251: a schedule that is not one', () => {
  it('six fields, naming the five a cron expression has', () => {
    const found = at(
      schedule(doc => {
        doc.settings.cron = '0 3 * * * *';
      }),
      'X251',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('settings/cron');
    expect(found[0].message).toMatch(/has 6 fields; a cron expression has five/);
  });

  it('a minute out of range', () => {
    const found = at(
      schedule(doc => {
        doc.settings.cron = '61 3 * * *';
      }),
      'X251',
    );
    expect(found[0].message).toMatch(/out of range for minute: 0-59/);
  });

  it('a weekday that is no day', () => {
    const found = at(
      schedule(doc => {
        doc.settings.cron = '0 3 * * mon-fry';
      }),
      'X251',
    );
    expect(found[0].message).toMatch(/'fry' is not a day-of-week/);
  });

  it('a macro, which this parser does not take: the hint spells the five-field form', () => {
    const found = at(
      schedule(doc => {
        doc.settings.cron = '@daily';
      }),
      'X251',
    );
    expect(found[0].message).toMatch(/has 1 field; a cron expression has five/);
  });

  it('both cron and everyMs: a tick cannot be at two schedules at once', () => {
    const found = at(
      schedule(doc => {
        doc.settings.everyMs = 60000;
      }),
      'X251',
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/names both cron and everyMs/);
  });

  it('neither: nothing says when it fires', () => {
    const found = at(
      schedule(doc => {
        doc.settings = {};
      }),
      'X251',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('settings');
    expect(found[0].message).toMatch(/names neither cron nor everyMs/);
  });

  it('an interval below a second', () => {
    const found = at(
      schedule(doc => {
        doc.settings = { everyMs: 500 };
      }),
      'X251',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('settings/everyMs');
    expect(found[0].message).toMatch(/whole number of 1000 or more/);
  });

  it('an interval with a timezone: the multiples of an interval are the same instants everywhere', () => {
    const found = at(
      schedule(doc => {
        doc.settings = { everyMs: 60000, timezone: 'UTC' };
      }),
      'X251',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('settings/timezone');
  });

  it('a zone no runtime knows', () => {
    const found = at(
      schedule(doc => {
        doc.settings.timezone = 'Mars/Olympus';
      }),
      'X251',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('settings/timezone');
    expect(found[0].message).toMatch(/not a timezone this runtime knows/);
  });

  it("the plugin's own leaseTtlMs, judged as @http judges a throttle", () => {
    const found = at(
      edit('project.json', doc => {
        doc.plugins[1].settings = { leaseTtlMs: 10 };
      }),
      'X251',
    );
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe('@project.json');
    expect(found[0].at).toBe('plugins/@schedule/settings/leaseTtlMs');
  });

  it("the plugin's own timezone", () => {
    const found = at(
      edit('project.json', doc => {
        doc.plugins[1].settings = { timezone: 'Mars/Olympus' };
      }),
      'X251',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('plugins/@schedule/settings/timezone');
  });
});

describe('X252: an in nothing fills', () => {
  it('an in declared with no fire.in: nothing arrives on a tick', () => {
    const found = at(
      schedule(doc => {
        doc.in = '@features/monitor/edge/Cutoff.shape.json';
      }),
      'X252',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('in');
    expect(found[0].message).toMatch(/nobody is calling/);
  });

  it('the same in with a fire.in reading the tick is not refused', () => {
    const found = at(
      schedule(doc => {
        doc.in = '@features/monitor/edge/Cutoff.shape.json';
        doc.fire.in = { count: 1 };
      }),
      'X252',
    );
    expect(found).toHaveLength(0);
  });
});

describe('X253: catchUp with nothing to remember the last tick by', () => {
  it('catchUp while the run step names no lease', () => {
    const docs = editing(TRIGGER, doc => {
      doc.settings.catchUp = true;
    });
    (docs['project.json'] as any).startup[0].in = undefined;
    const found = at(refusals(docs), 'X253');
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('settings/catchUp');
    expect(found[0].message).toMatch(/no process can know what the last tick was/);
  });

  it('catchUp with the lease as the tree writes it is not refused', () => {
    const found = at(
      schedule(doc => {
        doc.settings.catchUp = true;
      }),
      'X253',
    );
    expect(found).toHaveLength(0);
  });
});

describe('X254: a lease that keeps none', () => {
  it('a connection whose kind does not declare leases', () => {
    const found = at(
      edit('project.json', doc => {
        doc.startup[0].in.lease = PLAIN;
      }),
      'X254',
    );
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe('@project.json');
    expect(found[0].at).toBe('startup/0/in/lease');
    expect(found[0].message).toMatch(/does not declare leases/);
  });

  it('a connection that is not one at all', () => {
    const found = at(
      edit('project.json', doc => {
        doc.startup[0].in.lease = '@connections/nope.connection.json';
      }),
      'X254',
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/is not a connection document/);
  });

  it('the lease the tree names is one whose kind declares it, so nothing is refused', () => {
    expect(codes(tree()).filter(code => code === 'X254')).toHaveLength(0);
    expect(tree()['project.json']).toBeDefined();
  });
});

describe('what is deliberately not a rule here', () => {
  it('a tree with scheduled triggers and no run step schedules nothing, and is not refused', () => {
    const found = refusals(
      editing('project.json', doc => {
        doc.startup = [];
      }),
    );
    expect(found.filter(one => one.code.startsWith('X'))).toEqual([]);
  });

  it('the run step with no lease is not refused: one process assumes it is alone', () => {
    const found = refusals(
      editing('project.json', doc => {
        doc.startup[0].in = undefined;
      }),
    );
    expect(found.filter(one => one.code.startsWith('X'))).toEqual([]);
  });

  it("overlap's three words are the type system's, through the kind's enum: T001, not an X rule", () => {
    const found = schedule(doc => {
      doc.settings.overlap = 'sometimes';
    });
    expect(found.map(one => one.code)).toContain('T001');
    expect(found.filter(one => one.code.startsWith('X'))).toEqual([]);
  });

  it('a lease is only judged where a run step names one, so another tree is untouched', () => {
    const found = refusals(
      editing('project.json', doc => {
        doc.startup = [];
      }),
    );
    expect(found.filter(one => one.code === 'X254')).toEqual([]);
  });
});
