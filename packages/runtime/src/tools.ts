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
export { fuzz, type Regression, type Replayed, regress } from './fuzz.js';
export { edgesLines, type Fuzzing, fuzzEdges } from './fuzz-edges.js';
export {
  type ListenRow,
  listensOf,
  MANIFEST_SCHEMA,
  type Manifest,
  type ManifestOptions,
  manifestOf,
  manifestText,
} from './manifest.js';
export { map } from './map.js';
export { type MigratedStep, type MigratedTarget, type MigrateOptions, type MigrateResult, migrate } from './migrate.js';
export {
  current,
  fileOf,
  type Recorded,
  type RecordedRun,
  recordedLines,
  scenarioOf,
} from './record.js';
export { checkRecorded, type RecordCheck, writeRecorded } from './recorded-dir.js';
export { EDGED, EDGES, type Owner, RECORDED, REHEARSED, refusedDir, SCENARIOS } from './recorded-owner.js';
export { type Rehearsal, rehearse } from './rehearse.js';
export { init, scaffold } from './scaffolds.js';
export { type Pinned, pinScenario } from './scenario-pin.js';
export {
  checkScenarios,
  edgesFailed,
  edgesSaid,
  rehearsalFailed,
  rehearsalSaid,
  type ScenariosCheck,
} from './scenarios-check.js';
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
