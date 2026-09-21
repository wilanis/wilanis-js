/**
 * The gates and the discovery commands. All of them work from a loaded, checked tree; each lives in the module for
 * what it does, and this file is the one name the CLI and the package's index reach for.
 */
export { describe, ls } from './discovery.js';
export { fuzz, regress, SCENARIOS } from './fuzz.js';
export { map } from './map.js';
export { type MigrateOptions, type MigrateResult, migrate } from './migrate.js';
export { type Rehearsal, rehearse } from './rehearse.js';
export { init, scaffold } from './scaffolds.js';
export {
  embedderFor,
  failedBelow,
  failedLeaf,
  generatedFire,
  policyRoots,
  stubEffects,
} from './stubbing.js';
