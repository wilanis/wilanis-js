/**
 * @wilanis/compiler: `checkTree` judges a loaded tree against every rule; `Compiler` lowers a judged graph
 * to a kernel spec whose handlers are plugin functions or nested specs; `buildEnv` and `runGraph` run it;
 * `refusalsReachable` and `refusalsOfTrigger` say what a run can refuse with and `operationsReachable` what
 * it calls, `sitesOf` where a value of a shape comes into being, `reachOf` what an atomic graph reaches,
 * `atomicOf` what a reader is told about one, and `invariantSaidOf` which triggers an access invariant
 * reaches and how each one meets it.
 */
export * from './atomic.js';
export * from './atomic-said.js';
// The walk below an atomic graph, named rather than spread: `./atomic.js` beside it is the run scope, and
// a reader of one import line should not have to know which of the two a name came from.
export { type Reach, type Reached, type ReachedMap, reachOf } from './check/atomic.js';
export * from './checker.js';
export * from './compiler.js';
export * from './documents.js';
export * from './env.js';
export * from './invariant-said.js';
export * from './refusals.js';
export * from './sites.js';
