/**
 * The inventory half of the manifest (RFC 0026): one row per document, plugin, include, feature, trigger, port,
 * policy, connection and startup step, read off the registry with the values the documents wrote. Every reference a
 * row holds outside its settings is printed canonical, so it names a document by the path `documents` lists it
 * under; every list is sorted by code units, except the two whose order is meaning (a trigger's policies and the
 * startup steps) and the arrays inside settings, which keep their own; and every object's keys are, settings' at
 * every depth among them.
 */
import {
  type Kind,
  type Layer,
  type Loaded,
  type LoadResult,
  type PortDoc,
  policyPath,
  type Scope,
  type TriggerDoc,
} from '@wilanis/core';
import { byUnits } from './diagnostics.js';
import { RUNTIME_VERSION } from './runtime-version.js';

/** One document of the tree, its plugins' and its includes' among them. */
export interface DocumentRow {
  path: string;
  kind: Kind;
  feature: string | null;
  layer: Layer | null;
  included: string | null;
}
/** One plugin the project names, and the version it was loaded at. */
export interface PluginRow {
  use: string;
  from: string | null;
  version: string | null;
  guard: boolean;
}
/** One tree the project includes, and the features of it that came along. */
export interface IncludeRow {
  from: string;
  version: string | null;
  features: string[];
}
/** One feature, and the effects its feature.json allows. */
export interface FeatureRow {
  name: string;
  included: string | null;
  effects: string[];
}
/** One trigger: its kind and settings, the operation it fires, and what gates it. */
export interface TriggerRow {
  path: string;
  kind: string;
  settings: Record<string, unknown>;
  fires: string;
  policies: string[];
  public: boolean;
  included: string | null;
}
/** One operation of a domain port, and the triggers that fire it. */
export interface DomainOperationRow {
  name: string;
  firedBy: string[];
  public: boolean;
}
/** One domain port: its operations, and every binding that meets it under some profile. */
export interface DomainPortRow {
  path: string;
  feature: string | null;
  operations: DomainOperationRow[];
  bindings: string[];
}
/** One operation of a native port, and what its port document promises of it. */
export interface NativeOperationRow {
  name: string;
  pure: boolean;
  holds: boolean;
}
/** One native port, and the plugin that grants it. */
export interface NativePortRow {
  path: string;
  grantedBy: string;
  operations: NativeOperationRow[];
}
/** One policy: the operation that decides it, what it proves, and the triggers it gates. */
export interface PolicyRow {
  path: string;
  decides: string;
  proves: string[];
  gates: string[];
  included: string | null;
}
/** One connection: its kind and settings, and the secret keys its templates read. */
export interface ConnectionRow {
  path: string;
  kind: string;
  settings: Record<string, unknown>;
  secrets: string[];
}
/** One startup step, as declared. */
export interface StartupRow {
  label: string | null;
  run: string;
  required: boolean;
  profiles: string[] | null;
}

/** The strings, each once, in code-unit order. */
export const sorted = (items: Iterable<string>): string[] => [...new Set(items)].sort(byUnits);
/** The rows in code-unit order of the key each is read by. */
export const sortedBy = <T>(rows: T[], key: (row: T) => string): T[] =>
  [...rows].sort((one, other) => byUnits(key(one), key(other)));

/**
 * A copy of a value with every object's keys in code-unit order, at every depth, and every array in its own order:
 * settings print the same whatever order a document wrote them in, and a caller editing the manifest edits a copy,
 * never the loaded tree.
 */
export function keySorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(keySorted);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(sorted(Object.keys(object)).map(key => [key, keySorted(object[key])]));
}

/** An object's settings as a sorted copy. */
const settingsOf = (settings: Record<string, unknown>) => keySorted(settings) as Record<string, unknown>;

/** Every document the tree loaded, by path. */
export function documentRows(load: LoadResult): DocumentRow[] {
  const rows = load.registry.files.map(file => ({
    path: file.path,
    kind: file.kind,
    feature: file.feature ?? null,
    layer: file.layer ?? null,
    included: file.included ?? null,
  }));
  return sortedBy(rows, row => row.path);
}

/**
 * Every plugin the project names, by `use`: the version the runtime resolved its package at, the runtime's own for a
 * plugin the runtime ships, and null where the load was handed the module rather than resolving a package.
 */
export function pluginRows(load: LoadResult, versions: Record<string, string>): PluginRow[] {
  const rows = (load.registry.project?.doc.plugins ?? []).map(use => ({
    use: use.use,
    from: use.from ?? null,
    version: versions[use.use] ?? (use.from === undefined ? RUNTIME_VERSION : null),
    guard: Boolean(load.registry.get('plugin', `${use.use}/plugin.json`)?.doc.guard),
  }));
  return sortedBy(rows, row => row.use);
}

/** Every tree the project includes, by package: the version it was resolved at and the features it brought. */
export function includeRows(load: LoadResult, versions: Record<string, string>): IncludeRow[] {
  const rows = (load.registry.project?.doc.includes ?? []).map(include => ({
    from: include.from,
    version: versions[include.from] ?? null,
    features: sorted(
      load.registry.files.filter(file => file.included === include.from).flatMap(file => file.feature ?? []),
    ),
  }));
  return sortedBy(rows, row => row.from);
}

/** Every feature a document sits in, by name, with the effects its feature.json allows. */
export function featureRows(load: LoadResult): FeatureRow[] {
  const names = sorted(load.registry.files.flatMap(file => (file.native || !file.feature ? [] : [file.feature])));
  return names.map(name => {
    const feature = load.registry.get('feature', `@features/${name}/feature.json`);
    const member = load.registry.files.find(file => file.feature === name && !file.native);
    return {
      name,
      included: member?.included ?? null,
      effects: sorted((feature?.doc.effects ?? []).map(load.resolve)),
    };
  });
}

/** The canonical policies a trigger attaches, in the order it attaches them. */
const policiesOf = (load: LoadResult, trigger: Loaded<TriggerDoc>) =>
  (trigger.doc.policies ?? []).map(ref => load.resolve(policyPath(ref)));

/** Every trigger, by path: public when it attaches no policy. */
export function triggerRows(load: LoadResult): TriggerRow[] {
  const rows = load.registry.all('trigger').map(trigger => {
    const policies = policiesOf(load, trigger);
    return {
      path: trigger.path,
      kind: load.resolve(trigger.doc.kind),
      settings: settingsOf(trigger.doc.settings),
      fires: load.resolve(trigger.doc.fire.run),
      policies,
      public: policies.length === 0,
      included: trigger.included ?? null,
    };
  });
  return sortedBy(rows, row => row.path);
}

/** One operation of a domain port, fired by the triggers whose `fire.run` names it; public when any of them is. */
function domainOperation(path: string, name: string, triggers: TriggerRow[]): DomainOperationRow {
  const firing = triggers.filter(trigger => trigger.fires === `${path}#${name}`);
  return {
    name,
    firedBy: sorted(firing.map(trigger => trigger.path)),
    public: firing.some(trigger => trigger.public),
  };
}

/** Every port the tree binds, a plugin's required ones among them, by path, each with every binding of it. */
export function domainPortRows(scope: Scope, triggers: TriggerRow[]): DomainPortRow[] {
  const ports = scope.registry.all('port').filter(port => !port.native);
  const rows = ports.map(port => ({
    path: port.path,
    feature: port.feature ?? null,
    operations: sorted(Object.keys(port.doc.operations)).map(name => domainOperation(port.path, name, triggers)),
    bindings: sorted(scope.bindingsFor(port.path).map(binding => binding.path)),
  }));
  return sortedBy(rows, row => row.path);
}

/** Every port a plugin grants, by path, with what each operation's document promises. */
export function nativePortRows(load: LoadResult): NativePortRow[] {
  const ports = load.registry
    .all('port')
    .filter((port): port is Loaded<PortDoc> & { native: string } => Boolean(port.native));
  const rows = ports.map(port => ({
    path: port.path,
    grantedBy: port.native,
    operations: sorted(Object.keys(port.doc.operations)).map(name => ({
      name,
      pure: port.doc.operations[name].pure === true,
      holds: port.doc.operations[name].holds === true,
    })),
  }));
  return sortedBy(rows, row => row.path);
}

/** Every policy, by path, with the triggers that attach it. */
export function policyRows(load: LoadResult, triggers: TriggerRow[]): PolicyRow[] {
  const rows = load.registry.all('policy').map(policy => ({
    path: policy.path,
    decides: load.resolve(policy.doc.decide.run),
    proves: sorted(policy.doc.proves ?? []),
    gates: sorted(triggers.filter(trigger => trigger.policies.includes(policy.path)).map(trigger => trigger.path)),
    included: policy.included ?? null,
  }));
  return sortedBy(rows, row => row.path);
}

/** Every connection, by path, with the secret keys its settings read and never a secret's value. */
export function connectionRows(scope: Scope): ConnectionRow[] {
  const rows = scope.registry.all('connection').map(connection => ({
    path: connection.path,
    kind: scope.canon(connection.doc.kind),
    settings: settingsOf(connection.doc.settings),
    secrets: sorted(
      scope.templateReads(connection.doc.settings).flatMap(([root, key]) => (root === 'secrets' && key ? [key] : [])),
    ),
  }));
  return sortedBy(rows, row => row.path);
}

/** The secrets the project declares, key to variable, by key. */
export function secretRows(load: LoadResult): Record<string, string> {
  const declared = load.registry.project?.doc.secrets ?? {};
  return Object.fromEntries(sorted(Object.keys(declared)).map(key => [key, declared[key]]));
}

/** The startup steps in the order declared, which is the order they run in: `required` defaulted, as it runs. */
export function startupRows(load: LoadResult): StartupRow[] {
  return (load.registry.project?.doc.startup ?? []).map(step => ({
    label: step.label ?? null,
    run: load.resolve(step.run),
    required: step.required ?? true,
    profiles: step.profiles ? sorted(step.profiles) : null,
  }));
}
