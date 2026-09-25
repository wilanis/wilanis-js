/**
 * The gates and the discovery commands. All of them work from a loaded, checked tree; each lives in the module for
 * what it does, and this file is the one name the CLI and the package's index reach for.
 */
export {
  DIAGNOSTICS_SCHEMA,
  type Diagnostic,
  type Diagnostics,
  diagnosticsOf,
  type Migration,
  printed,
  withMigration,
  withRegression,
  withRehearsal,
} from './diagnostics.js';
export { describe, ls } from './discovery.js';
export { fuzz, type Regression, type Replayed, regress, SCENARIOS } from './fuzz.js';
export {
  irOf,
  MANIFEST_SCHEMA,
  type Manifest,
  type ManifestOptions,
  manifestOf,
} from './manifest.js';
export { map } from './map.js';
export { type MigratedStep, type MigratedTarget, type MigrateOptions, type MigrateResult, migrate } from './migrate.js';
export { type Rehearsal, rehearse } from './rehearse.js';
export { init, scaffold } from './scaffolds.js';
export {
  type CancelAt,
  embedderFor,
  failedBelow,
  failedLeaf,
  generatedFire,
  policyRoots,
  type StubOptions,
  stubEffects,
} from './stubbing.js';
