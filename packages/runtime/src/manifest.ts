/**
 * What `wilanis manifest` prints (RFC 0026): what a tree is, as one JSON document a machine reads and two runs diff
 * to nothing. `manifestOf` is pure over a tree that passed the checker: it reads the registry, the Scope and the
 * versions the runtime resolved the packages at, never the environment, the clock or a secret's value, and every
 * list it answers is sorted but a trigger's policies, the startup steps and the arrays inside settings, which keep
 * the order their documents give them, so the same tree is the same string however it was walked.
 */
import { type LoadResult, SCHEMA_BASE, Scope } from '@wilanis/core';
import {
  type ConnectionRow,
  connectionRows,
  type DocumentRow,
  type DomainPortRow,
  documentRows,
  domainPortRows,
  type FeatureRow,
  featureRows,
  type IncludeRow,
  includeRows,
  type NativePortRow,
  nativePortRows,
  type PluginRow,
  type PolicyRow,
  pluginRows,
  policyRows,
  type StartupRow,
  secretRows,
  startupRows,
  type TriggerRow,
  triggerRows,
} from './manifest-rows.js';
import type { Resolved } from './project.js';
import { RUNTIME_VERSION } from './runtime-version.js';

export type {
  ConnectionRow,
  DocumentRow,
  DomainOperationRow,
  DomainPortRow,
  FeatureRow,
  IncludeRow,
  NativeOperationRow,
  NativePortRow,
  PluginRow,
  PolicyRow,
  StartupRow,
  TriggerRow,
} from './manifest-rows.js';

/** Where the manifest's JSON Schema is published, beside the runtime that prints it. */
export const MANIFEST_SCHEMA =
  'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/runtime/schemas/manifest.schema.json';

/** The envelope, then the tree's inventory: what is the same under every profile. */
export interface Manifest {
  format: 1;
  runtime: string;
  ir: string;
  name: string;
  root: string;
  plugins: PluginRow[];
  includes: IncludeRow[];
  features: FeatureRow[];
  documents: DocumentRow[];
  triggers: TriggerRow[];
  ports: { domain: DomainPortRow[]; native: NativePortRow[] };
  policies: PolicyRow[];
  connections: ConnectionRow[];
  secrets: Record<string, string>;
  startup: StartupRow[];
}

/** What the caller supplies: the root as it was given, which the manifest prints and never resolves. */
export interface ManifestOptions {
  root: string;
}

/**
 * The schema version a base URL serves, RFC 0008's segment of it: `v1` while the base is on `main` or on the tag
 * `schemas-v1`, and `vN` once it moves to `schemas-vN`.
 */
export const irOf = (base: string): string => /\/schemas-(v[0-9]+)\//.exec(base)?.[1] ?? 'v1';

/**
 * The manifest of a tree the checker accepted. The versions of its plugins and includes are read off `resolved`,
 * which `loadProject` carries; a load without it prints `null` for every version it did not resolve.
 */
export function manifestOf(load: LoadResult & { resolved?: Resolved }, options: ManifestOptions): Manifest {
  const scope = new Scope(load.registry, load.resolve);
  const included = Object.fromEntries(
    (load.resolved?.includes ?? []).flatMap(one => (one.version === undefined ? [] : [[one.from, one.version]])),
  );
  const triggers = triggerRows(load);
  return {
    format: 1,
    runtime: RUNTIME_VERSION,
    ir: irOf(SCHEMA_BASE),
    name: load.registry.project?.doc.name ?? '',
    root: options.root,
    plugins: pluginRows(load, load.resolved?.plugins ?? {}),
    includes: includeRows(load, included),
    features: featureRows(load),
    documents: documentRows(load),
    triggers,
    ports: { domain: domainPortRows(scope, triggers), native: nativePortRows(load) },
    policies: policyRows(load, triggers),
    connections: connectionRows(scope),
    secrets: secretRows(load),
    startup: startupRows(load),
  };
}
