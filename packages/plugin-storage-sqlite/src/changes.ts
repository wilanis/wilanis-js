/**
 * What each step SQLite takes only by remaking the table does to that table (RFC 0017): `retype`, `require`,
 * `relax`, `ref`, `unref`, `remove`, and an `add` of a required field with no default. `rebuild.ts` does the
 * remaking; this file says, step by step, what the table is afterwards and how a column is copied into it.
 *
 * Each change is read against the table as the catalog holds it at that moment, inside the plan, so the steps
 * of one plan compose: a `retype` after an `add` remakes a table that already has the added column. Names are
 * matched as SQLite matches them, without case, and the column keeps the spelling the table already has.
 */
import type { DeclaredField, Step } from '@wilanis/plugin-storage';
import { castOf } from './casts.js';
import { quoted } from './columns.js';
import { columnFor, type Kept, literal, same } from './ddl.js';
import type { Table } from './inspect.js';
import type { Change } from './rebuild.js';

/** The column of the table a step is about, as the table spells it; a step about no column of it is a fault. */
function columnOf(table: Table, step: Step): Kept {
  const found = table.columns.find(one => same(one.name, step.at ?? ''));
  if (!found) throw new Error(`${step.do} ${step.target}.${step.at}: the table has no such column`);
  return found;
}

/** The table's columns with the one a step is about replaced, and its references as they are. */
function replacing(table: Table, column: Kept, next: Kept): Change {
  return { columns: table.columns.map(one => (one === column ? next : one)), refs: table.refs };
}

/** A column kept in another type, each value copied through the cast `casts.ts` writes for the pair. */
function retype(table: Table, step: Step): Change {
  const column = columnOf(table, step);
  if (!step.was || !step.becomes) throw new Error(`retype ${step.target}.${step.at}: the step names no pair of types`);
  const next = { ...column, type: step.becomes, column: columnFor(step.becomes) };
  return {
    ...replacing(table, column, next),
    from: { [column.name]: castOf(step.was, step.becomes, quoted(column.name)) },
  };
}

/** A column made required, an empty value filled with the declared default where there is one. */
function require_(table: Table, step: Step): Change {
  const column = columnOf(table, step);
  const change = replacing(table, column, { ...column, required: true });
  if (step.default === undefined) return change;
  const fill = `COALESCE(${quoted(column.name)}, ${literal(step.default, column.type)})`;
  return { ...change, from: { [column.name]: fill } };
}

/** A column made optional. */
function relax(table: Table, step: Step): Change {
  const column = columnOf(table, step);
  return replacing(table, column, { ...column, required: false });
}

/** A column and its values gone. */
function remove(table: Table, step: Step): Change {
  const column = columnOf(table, step);
  return { columns: table.columns.filter(one => one !== column), refs: table.refs };
}

/**
 * A reference made: the column holds the other collection's key from now on. A table that already holds it --
 * one the same plan made, since a `create` writes its references -- is left as it is.
 */
function ref(table: Table, step: Step): Change | undefined {
  const column = columnOf(table, step);
  const held = Object.entries(table.refs).find(([field]) => same(field, column.name));
  if (held && same(held[1].collection, step.to ?? '')) return undefined;
  const refs = { ...table.refs, [column.name]: { collection: step.to ?? '', onRemove: 'refuse' as const } };
  return { columns: table.columns, refs };
}

/** A reference dropped: the column stays, and holds any value from now on. */
function unref(table: Table, step: Step): Change {
  const refs = Object.fromEntries(Object.entries(table.refs).filter(([field]) => !same(field, step.at ?? '')));
  return { columns: table.columns, refs };
}

/** A required column added with no default: only an empty table can take one, and the copy fails on any row. */
function add(table: Table, step: Step, field: DeclaredField): Change {
  const added: Kept = { name: step.at ?? '', type: field.type, column: columnFor(field.type), required: true };
  return { columns: [...table.columns, added], refs: table.refs };
}

/** What a step that remakes the table makes of it, or nothing where this step is not one of them. */
export function changeOf(
  step: Step,
  field: DeclaredField | undefined,
): ((table: Table) => Change | undefined) | undefined {
  if (step.do === 'retype') return table => retype(table, step);
  if (step.do === 'require') return table => require_(table, step);
  if (step.do === 'relax') return table => relax(table, step);
  if (step.do === 'remove') return table => remove(table, step);
  if (step.do === 'ref') return table => ref(table, step);
  if (step.do === 'unref') return table => unref(table, step);
  if (step.do === 'add' && field?.required && step.default === undefined) return table => add(table, step, field);
  return undefined;
}
