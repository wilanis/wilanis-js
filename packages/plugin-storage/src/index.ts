/**
 * @wilanis/plugin-storage, the @storage plugin: records of a shape behind one generic port. It says what a
 * store is and what may be asked of one; how the records are kept is an engine plugin's business, reached
 * through the `Engine` contract and the table `engines(env)` holds. This package carries no driver, speaks no
 * engine's language, and depends on core and engine alone.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule } from '@wilanis/core';
import { handlers } from './handlers.js';
import { applyStores, historyOfStores, planStores } from './migrate.js';
import { check } from './rules.js';

export { driftOf } from './drift.js';
export type {
  At,
  Engine,
  Engines,
  Made,
  Order,
  PutAnswer,
  Query,
  Record_,
  Ref,
  RemoveAnswer,
  Transaction,
} from './engine.js';
export { engines } from './engine.js';
export { ensureStore } from './ensure.js';
export { applyStores, historyOfStores, planStores } from './migrate.js';
export type {
  CollectionMarks,
  Declared,
  DeclaredField,
  Declares,
  Declaring,
  Does,
  FieldType,
  Marks,
  Planned,
  Stale,
  Step,
} from './plan.js';
export { declaredOf, declaredOfStore, fieldTypeOf, marksOf, marksOfStore, plan } from './plan.js';
export type { Class, Classed, Judging } from './plan-class.js';
export { classed, counts } from './plan-class.js';
export type { Applied, Applying, On, Recorder, Recording } from './record.js';
export { onOf } from './record.js';
export type { Standing } from './standing.js';
export { classedSteps, standing } from './standing.js';
export type { Operator, Test, Where } from './where.js';
export { OPERATORS, parseWhere, whereOf } from './where.js';

const plugin: PluginModule = {
  root: '@storage',
  docs: fileURLToPath(new URL('../docs', import.meta.url)),
  handlers,
  check,
  // the one planner's second caller: `ensure` prepares a store at startup, and this plans every store of the
  // tree for an operator to read before anything is applied (RFC 0017)
  migrate: { plan: planStores, apply: applyStores, history: historyOfStores },
};
export default plugin;
