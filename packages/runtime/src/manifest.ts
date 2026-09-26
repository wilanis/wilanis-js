/**
 * What `wilanis manifest` prints (RFC 0026): what a tree is, as one JSON document a machine reads and two runs diff
 * to nothing. `manifestOf` is pure over a tree that passed the checker: it reads the registry, the Scope and the
 * versions the runtime resolved the packages at, never the environment, the clock or a secret's value, and every
 * list it answers is sorted but a trigger's policies, the startup steps (and the labels of those a profile starts)
 * and the arrays inside settings, which keep the order their documents give them, so the same tree is the same
 * string however it was walked. The inventory is what is the same under every profile; `profiles` holds one block
 * per profile, what RFC 0013's `reachOf` derives there.
 */
import { IR_READ, type LoadResult, Scope } from '@wilanis/core';
import { type ProfileBlock, profileBlocks } from './manifest-profiles.js';
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

export type { NeedRow, ProfileBlock, ReachRow } from './manifest-profiles.js';
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

/** The envelope, the tree's inventory (what is the same under every profile), then one block per profile. */
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
  /** By profile name; the unnamed profile of a tree that declares none under `""`. */
  profiles: Record<string, ProfileBlock>;
}

/**
 * What the caller supplies: the root as it was given, which the manifest prints and never resolves, and the one
 * profile to print a block for, where every profile's is not wanted.
 */
export interface ManifestOptions {
  root: string;
  profile?: string;
}

/**
 * The manifest of a tree the checker accepted. The versions of its plugins and includes are read off `resolved`,
 * which `loadProject` carries; a load without it prints `null` for every version it did not resolve. Throws RFC
 * 0013's message where `options.profile` names a profile the project does not declare.
 */
export function manifestOf(load: LoadResult & { resolved?: Resolved }, options: ManifestOptions): Manifest {
  const scope = new Scope(load.registry, load.resolve);
  const included = Object.fromEntries(
    (load.resolved?.includes ?? []).flatMap(one => (one.version === undefined ? [] : [[one.from, one.version]])),
  );
  const triggers = triggerRows(load);
  const profiles = profileBlocks(scope, options.profile);
  return {
    format: 1,
    runtime: RUNTIME_VERSION,
    ir: IR_READ,
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
    profiles,
  };
}

/** The manifest as `wilanis manifest` prints it and `/api/manifest` answers it: two-space JSON and a newline. */
export const manifestText = (manifest: Manifest): string => `${JSON.stringify(manifest, null, 2)}\n`;
