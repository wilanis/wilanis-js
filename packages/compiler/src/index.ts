/**
 * @wilanis/compiler: `checkTree` judges a loaded tree against every rule; `Compiler` lowers a judged graph
 * to a kernel spec whose handlers are plugin functions or nested specs; `buildEnv` and `runGraph` run it;
 * `refusalsReachable` and `refusalsOfTrigger` say what a run can refuse with, `operationsReachable` what
 * it calls and `effectsReachable` the native sites it ends at,
 * `sitesOf` where a value of a shape comes into being and `heldAt` whether a field invariant already
 * holds there, `reachOf` what a profile reaches -- the effectful operations, connections, secrets and holds
 * of one place a tree runs --, `atomicReachOf` what an atomic graph reaches, `atomicOf` what a reader is told
 * about one, `invariantSaidOf` which triggers an access invariant reaches and how each one meets it, and
 * `viewsReachedBy` every view across a scope a run reaches.
 */
export * from './atomic.js';
export * from './atomic-said.js';
// The walk below an atomic graph, named rather than spread: `./atomic.js` beside it is the run scope, and
// a reader of one import line should not have to know which of the two a name came from.
export { type AtomicReach, atomicReachOf, type Reached, type ReachedMap } from './check/atomic.js';
// The profiles a walk is made under, named rather than spread: `check/judge.ts` is the checker's own and this
// one question is asked outside it, by everything that walks a tree per profile.
export { profilesOf } from './check/judge.js';
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
  guardSpecAt,
  guardSpecName,
  guardsOf,
  hasGuard,
  INVARIANT,
  idsOf,
  TAKEN_IDS,
  type Unproved,
} from './guard.js';
export * from './invariant-said.js';
// The scope a site carries and the name it is carried under, named rather than spread: `lower.ts` is the whole
// of lowering and almost none of it is public surface, but what a document may not write and how a reader asks
// whether an operation takes one are the same two facts the checker, `describe` and the viewer each read.
export { SCOPE, takesScope } from './lower.js';
export * from './reach.js';
export * from './refusals.js';
export * from './scope-said.js';
export * from './sites.js';
