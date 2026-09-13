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
export { coerceWire, Embedder, type FireOptions, fillTemplates, prune } from './embed.js';
export { cli as cliTriggers } from './plugins/cli-trigger.js';
export { BUILTIN_PLUGINS } from './plugins/index.js';
export { std } from './plugins/std.js';
export { postLoad } from './post-load.js';
export { loadProject, type PluginResolution, resolveIncludes, resolvePlugins } from './project.js';
export { contentTypeOf, runStartup, runTrigger, start } from './serve.js';
export { Served } from './served.js';
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
  describe,
  embedderFor,
  failedLeaf,
  fuzz,
  generatedFire,
  init,
  ls,
  map,
  policyRoots,
  type Rehearsal,
  regress,
  rehearse,
  scaffold,
  stubEffects,
  summarize,
} from './tools.js';
