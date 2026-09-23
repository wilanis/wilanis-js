/**
 * @wilanis/runtime: everything that runs a tree. The embedder (fire a trigger: input mapping, compile,
 * run, prune), the gates (rehearse, fuzz, regress), discovery (ls, describe, map), scaffolds, project
 * loading with plugin packages, start, and the `wilanis` command line. Ships the @std and @cli plugins.
 * What a store says beyond its own document -- the engine behind it, a key's type, the calls against it --
 * is here too, so the viewer reads it from one place rather than walking the tree its own way.
 */

export { FileBlobStore } from './blobs.js';
export {
  type Branch,
  branchesOf,
  type Case,
  casesFor,
  type Demands,
  type Domain,
  satisfy,
  switchesOf,
} from './branches.js';
export { coerceWire, Embedder, type FireOptions, fillTemplates, type Observers, prune } from './embed.js';
export {
  correlationOf,
  type Decided,
  type Fired,
  type Identified,
  isStarted,
  type Ran,
  type Started,
  statusOf,
} from './fired.js';
export { LIMIT_SETTINGS, type Limit, type LimitSetting, limitsOf, type TriggerLimits } from './limits-said.js';
export { cli as cliTriggers } from './plugins/cli-trigger.js';
export { BUILTIN_PLUGINS } from './plugins/index.js';
export { std } from './plugins/std.js';
export { postLoad } from './post-load.js';
export { loadProject, type PluginResolution, resolveIncludes, resolvePlugins } from './project.js';
export { contentTypeOf, runStartup, runTrigger, start } from './serve.js';
export { Served } from './served.js';
export {
  CAP,
  CONFIG,
  COUNTER,
  gateOf,
  type StopAnswer,
  type StopInput,
  stopHook,
  type Verdict,
  verdictOf,
} from './stopping.js';
export {
  callsAgainst,
  engineOf,
  keyTypeOf,
  STORE_PORT,
  type StoreCall,
  type StoreEngine,
  storeCalls,
  storeTail,
} from './stores.js';
export {
  type CancelAt,
  describe,
  embedderFor,
  failedLeaf,
  fuzz,
  generatedFire,
  init,
  ls,
  type MigrateOptions,
  type MigrateResult,
  map,
  migrate,
  policyRoots,
  type Rehearsal,
  regress,
  rehearse,
  type StubOptions,
  scaffold,
  stubEffects,
} from './tools.js';
export { atLevel, type Level, traceJson, traceOf, traceText } from './trace.js';
