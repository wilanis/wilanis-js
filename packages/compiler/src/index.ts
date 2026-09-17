/**
 * @wilanis/compiler: `checkTree` judges a loaded tree against every rule; `Compiler` lowers a judged graph
 * to a kernel spec whose handlers are plugin functions or nested specs; `buildEnv` and `runGraph` run it;
 * `refusalsReachable` and `refusalsOfTrigger` say what a run can refuse with and `operationsReachable` what
 * it calls, `sitesOf` where a value of a shape comes into being and `heldAt` whether a field invariant already
 * holds there, `reachOf` what an atomic graph reaches, `atomicOf` what a reader is told about one, and
 * `invariantSaidOf` which triggers an access invariant reaches and how each one meets it.
 */
export * from './atomic.js';
export * from './atomic-said.js';
// The walk below an atomic graph, named rather than spread: `./atomic.js` beside it is the run scope, and
// a reader of one import line should not have to know which of the two a name came from.
export { type Reach, type Reached, type ReachedMap, reachOf } from './check/atomic.js';
// The proof rules behind a field invariant, named rather than spread: what a site establishes is asked of this
// one function by the checker, by the guard the compiler lowers, and by the tests that hold the rules honest.
export { heldAt, heldWhollyAt, type Proof } from './check/prove.js';
export * from './checker.js';
export * from './compiled.js';
export * from './compiler.js';
export * from './documents.js';
export * from './env.js';
// What a field invariant lowers to where it could not be proved, named rather than spread: the node-building
// half is the compiler's own, and a reader of one import line wants the guards of a graph and their ids.
export {
  type Guard,
  guardIds,
  guardMessage,
  guardsOf,
  hasGuard,
  INVARIANT,
  idsOf,
  TAKEN_IDS,
  type Unproved,
} from './guard.js';
export * from './invariant-said.js';
export * from './refusals.js';
export * from './sites.js';
