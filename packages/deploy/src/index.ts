/**
 * @wilanis/deploy: deployment for wilanis trees (RFC 0024). A tool over a tree's manifest, not a plugin: it grants
 * nothing to a tree and runs nothing of it. `planOf` answers what one deployment is -- one workload per profile, its
 * command, its addresses, what it holds, the variables it needs by name and its probe, and what the environment
 * must provide -- from a manifest alone; every target renders that plan, each a pure function from it to the files
 * it writes, `writeInto` is what puts them on disk, and `wilanis-deploy` is the command.
 */
export { composeFiles } from './compose.js';
export { CHART, helmFiles, SWITCHES } from './helm.js';
export { imageFiles, majorOf, NODE_MAJOR } from './image.js';
export {
  commandOf,
  DOCKERFILE,
  PLAN_SCHEMA,
  type Plan,
  type PlanImage,
  type PlanListen,
  type PlanNeed,
  type PlanOptions,
  type PlanProbe,
  planOf,
  planText,
  type Requirement,
  type Workload,
} from './plan.js';
export { reachable, unreachableOf } from './reachable.js';
export {
  GENERATED,
  headerOf,
  type Origin,
  type Rendered,
  regenerateOf,
  stamped,
  type WriteOptions,
  type Written,
  writeInto,
} from './write.js';
