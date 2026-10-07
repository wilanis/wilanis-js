/**
 * What every engine that keeps a record must count alike when a plan changes a name before it counts (RFC 0017).
 * A plan is classed before it runs, so every count is asked of the database as it stands before the plan: a
 * step after a `rename` names a column the database does not have yet, and a `ref` to a collection the same plan
 * creates names a table it does not have. These cases drive the planner as `ensure` does -- `standing`, `plan`,
 * `classedSteps` -- over a collection the case makes, and judge the class each step comes back with.
 *
 * An engine that keeps nothing between processes has no record to plan against, and `wilanis migrate` skips it;
 * so does each case here, which is why they can sit in `cases` and still hold every engine to them that plans.
 */
import { strict as assert } from 'node:assert';
import type { Type } from '@wilanis/core';
import type { At } from './engine.js';
import { type Declared, type Marks, plan } from './plan.js';
import type { Classed } from './plan-class.js';
import type { Recording } from './record.js';
import { classedSteps, standing } from './standing.js';
import type { Case, Subject } from './suite-fixture.js';

const BY = { by: 'suite', tree: 'suite' };

/** A collection of string fields keyed by `id`, which is required; every other field is optional. */
function declared(fields: string[], extra: Partial<Declared> = {}): Declared {
  const all = ['id', ...fields];
  return {
    key: 'id',
    fields: Object.fromEntries(all.map(name => [name, { type: 'string' as const, required: name === 'id' }])),
    unique: [],
    refs: {},
    ...extra,
  };
}

/** The collection as a store operation names it, with a shape of exactly the fields it was made with. */
function atOf(subject: Subject, name: string, made: Declared): At {
  const fields = Object.fromEntries(
    Object.entries(made.fields).map(([field, one]) => [field, { type: { kind: 'string' }, required: one.required }]),
  );
  const shape = { kind: 'object', name, open: false, fields } as Type;
  return { ...subject.connection, name, shape, key: 'id', unique: [], refs: [], referenced: [], defaults: {} };
}

/** Drop whatever a previous run left under these names, so the case starts from a database that has none. */
async function cleared(subject: Subject, names: string[]): Promise<void> {
  const { engine, connection } = subject;
  for (const name of names) {
    if (!(await engine.recorded(connection, name)) && !(await engine.inspect(connection, name))) continue;
    const record: Recording = { [name]: null };
    await engine.apply(connection, [{ do: 'drop', target: name, says: `drop collection ${name}` }], record, BY);
  }
}

/** A collection made by the plan the planner writes for it, holding the rows the case gives. */
async function made(subject: Subject, name: string, as: Declared, rows: Record<string, string | null>[]) {
  await subject.engine.apply(subject.connection, plan({}, { [name]: as }, {}).steps, { [name]: as }, BY);
  const at = atOf(subject, name, as);
  for (const row of rows) {
    const record = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
    await subject.engine.put(at, record, { replace: true });
  }
}

/** The plan from what the database holds to what the tree declares now, every step classed as `ensure` classes it. */
async function classedFor(subject: Subject, now: Record<string, Declared>, marks: Marks): Promise<Classed[]> {
  const held = await standing(subject.engine, subject.connection, Object.keys(now));
  return classedSteps(subject.engine, subject.connection, plan(held.recorded, now, marks, held.found).steps);
}

/** The one step of a plan that does this, with its class and its count. */
function stepOf(steps: Classed[], does: string): Classed {
  const found = steps.find(one => one.step.do === does);
  assert.ok(found, `the plan has no ${does} step: ${steps.map(one => one.step.says).join('; ')}`);
  return found;
}

export const plannerCases: Case[] = [
  {
    name: 'a retype after a rename is counted under the column name the database has before the plan',
    async run(subject) {
      if (!subject.engine.keeps()) return;
      await cleared(subject, ['plan_retyped']);
      await made(subject, 'plan_retyped', declared(['code']), [
        { id: 'a', code: '1' },
        { id: 'b', code: 'two' },
      ]);
      const now = declared(['label']);
      now.fields.label = { type: 'number', required: false };
      const steps = await classedFor(subject, { plan_retyped: now }, { plan_retyped: { renamed: { label: 'code' } } });
      const retype = stepOf(steps, 'retype');
      assert.equal(retype.class, 'refused');
      assert.equal(retype.rows, 1);
    },
  },
  {
    name: 'a guarantee after a rename counts the rows that break it, under the column name the database has',
    async run(subject) {
      if (!subject.engine.keeps()) return;
      await cleared(subject, ['plan_renamed']);
      await made(subject, 'plan_renamed', declared(['mail']), [
        { id: 'a', mail: 'x' },
        { id: 'b', mail: 'x' },
      ]);
      const now = declared(['email'], { unique: [['email']] });
      const steps = await classedFor(subject, { plan_renamed: now }, { plan_renamed: { renamed: { email: 'mail' } } });
      const guarantee = stepOf(steps, 'unique');
      assert.equal(guarantee.class, 'refused');
      assert.equal(guarantee.rows, 2);
    },
  },
  {
    name: 'a refs to a collection the same plan creates counts every row that names a record, since none is there',
    async run(subject) {
      if (!subject.engine.keeps()) return;
      await cleared(subject, ['plan_holders', 'plan_targets']);
      const rows = [
        { id: 'a', target: 'x' },
        { id: 'b', target: null },
      ];
      await made(subject, 'plan_holders', declared(['target']), rows);
      const holders = declared(['target'], { refs: { target: { collection: 'plan_targets', onRemove: 'refuse' } } });
      const now = { plan_targets: declared([]), plan_holders: holders };
      const ref = stepOf(await classedFor(subject, now, {}), 'ref');
      assert.equal(ref.class, 'refused');
      assert.equal(ref.rows, 1);
    },
  },
];
