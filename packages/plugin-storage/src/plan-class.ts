/**
 * The *Guide* table of RFC 0017, as code: what class a step is once the engine has counted the rows that stand
 * in its way. The planner emits a step and says what it would lose; nothing there knows how many rows there
 * are, and the class is exactly what the count decides.
 *
 * Additive is what costs nothing and cannot fail on data; transformative costs a name or a guarantee and no
 * data; destructive costs rows or values; refused is what no flag can make safe, and it carries the edit or
 * the graph that makes the step possible instead.
 */
import type { Step } from './plan.js';

/** What a step is at stake for, which decides what applies it: additive always, destructive only when allowed. */
export type Class = 'additive' | 'transformative' | 'destructive' | 'refused';

/** A step with the count the engine answered and the class that count puts it in. */
export interface Classed {
  step: Step;
  rows: number;
  class: Class;
  /** why nothing can apply it, where the class is `refused` */
  refused?: string;
}

/** The steps whose class no count can change: they cost nothing on any database, whatever it holds. */
const ALWAYS_ADDITIVE = new Set(['create', 'adopt']);

/** The steps that cost a name or a guarantee and never a row, whatever the count says. */
const ALWAYS_TRANSFORMATIVE = new Set(['rename', 'renameCollection', 'relax', 'ununique', 'unref']);

/**
 * A constraint the tree declares: additive where no row violates it, and refused above -- deleting rows to
 * make a constraint fit is business, and business lives in a graph the tree declares, never in a flag.
 */
function constraintClass(step: Step, rows: number): Classed {
  if (!rows) return { step, rows, class: 'additive' };
  const what = step.do === 'unique' ? `repeat [${(step.over ?? []).join(', ')}]` : `point at no ${step.to}`;
  return {
    step,
    rows,
    class: 'refused',
    refused: `${rows} row(s) ${what}: fix them with a one-off graph fired by a command-line trigger, or drop the mark; wilanis migrate applies it once no row violates`,
  };
}

/**
 * A field made required, or added required: additive where no row is empty and additive where a `defaults`
 * value fills the empty ones, and destructive otherwise -- the rows with nothing to put there are the rows
 * that would go, and that is the operator's to allow and nobody else's.
 *
 * An added optional column is additive at any count: every row simply has no value for it.
 */
function requireClass(step: Step, rows: number): Classed {
  if (!rows || step.default !== undefined) return { step, rows, class: 'additive' };
  return { step, rows, class: 'destructive' };
}

/**
 * An added column: additive unless it is required with no default, which the planner marks by saying what it
 * would cost. There the rows already in the table have nothing to put in the column, so the count decides:
 * additive on an empty table, destructive on one with rows.
 */
function addClass(step: Step, rows: number): Classed {
  if (!step.loses) return { step, rows, class: 'additive' };
  return { step, rows, class: rows ? 'destructive' : 'additive' };
}

/** A step that costs rows or values where there are any, and costs nothing where the count is zero. */
function byCount(step: Step, rows: number): Classed {
  return { step, rows, class: rows ? 'destructive' : 'transformative' };
}

/**
 * A field kept in another type: destructive by the *Guide* table whatever the count, since a cast is a value
 * rewritten and no flag makes that free. What the count answers is the rows no cast can carry at all, and
 * those refuse the step -- an engine that will not attempt the pair answers every row.
 */
function retypeClass(step: Step, rows: number): Classed {
  if (!rows) return { step, rows, class: 'destructive' };
  return {
    step,
    rows,
    class: 'refused',
    refused: `${rows} row(s) hold a ${step.was} in ${step.at} that no cast carries to ${step.target}'s declared type: change the values with a one-off graph fired by a command-line trigger, or declare the type they already are`,
  };
}

/** Which of the four the count puts a step in, step by step, exactly as RFC 0017's *Guide* table says. */
function classOf(step: Step, rows: number): Classed {
  if (ALWAYS_ADDITIVE.has(step.do)) return { step, rows, class: 'additive' };
  if (ALWAYS_TRANSFORMATIVE.has(step.do)) return { step, rows, class: 'transformative' };
  if (step.do === 'unique' || step.do === 'ref') return constraintClass(step, rows);
  if (step.do === 'add') return addClass(step, rows);
  if (step.do === 'require') return requireClass(step, rows);
  if (step.do === 'retype') return retypeClass(step, rows);
  return byCount(step, rows);
}

/**
 * One step classed. A step the planner already refused stays refused whatever the count says: a changed key,
 * a `renamed` naming a field the record has not got, a cast the engine will not attempt -- none of them is a
 * question about data, so no number answers it.
 */
export function classed(step: Step, rows: number): Classed {
  if (step.refused) return { step, rows, class: 'refused', refused: step.refused };
  return classOf(step, rows);
}

/**
 * Does this step need a row counted before it can be classed? The count is one query each, so a plan asks only
 * where the answer changes something: a `create` is additive on an empty database and on a full one alike.
 */
export function counts(step: Step): boolean {
  if (step.refused) return false;
  if (step.do === 'add') return Boolean(step.loses);
  if (step.do === 'require' && step.default !== undefined) return false;
  return !ALWAYS_ADDITIVE.has(step.do) && !ALWAYS_TRANSFORMATIVE.has(step.do);
}
