/**
 * Reading one document into the registry: parsed, judged against its kind's schema, placed where its kind
 * lives (D000, D001, D003, D004, D008), and registered under its canonical path. A plugin's documents are
 * registered the same way, under the plugin's root, marked native (D006) -- save a port it requires, which is
 * the host's to bind (D012) -- and its ports are held to what a contract may say for itself (D011).
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { badResolves } from './contracts.js';
import { type AnyDoc, type Kind, layerOf, type PluginDoc, type PortDoc, type ProjectDoc } from './model.js';
import { featureOf, stem, treePath, walk } from './paths.js';
import { misplaced } from './placement.js';
import type { PluginModule } from './plugin.js';
import type { Loaded, Refusal, RefusalList, Registry } from './registry.js';
import { validateDocument } from './validate.js';

/** Kinds a plugin ships and a tree never authors. */
const NATIVE_KINDS = new Set<Kind>(['plugin', 'trigger-kind', 'connection-kind', 'codec']);
export const PROJECT_FILE = 'project.json';

/** A file parsed as JSON, or the refusal for one that is not. */
export function parseJson(abs: string, file: string): { doc: unknown } | { refusal: Refusal } {
  try {
    return { doc: JSON.parse(readFileSync(abs, 'utf8')) };
  } catch (error) {
    return {
      refusal: {
        code: 'D000',
        file,
        message: `not JSON: ${(error as Error).message}`,
        hint: 'fix the JSON at the position the parser names',
      },
    };
  }
}

/**
 * The array project.json holds under one key, read before it is judged, or none when the file, its JSON or the key is
 * not there: what the runtime reads to find the packages a tree names, and the version rules the plugins whose docs
 * they read. loadTree reports D000 / D005.
 */
export function listedIn(root: string, key: 'plugins' | 'includes'): unknown[] {
  const parsed = parseJson(join(root, PROJECT_FILE), PROJECT_FILE);
  const found = 'doc' in parsed ? (parsed.doc as Record<string, unknown> | null)?.[key] : undefined;
  return Array.isArray(found) ? found : [];
}

/** The path a plugin's document is registered and refused under: the plugin's root, then its place under docs/. */
export const nativePath = (plugin: PluginModule, abs: string): string =>
  `${plugin.root}/${treePath(relative(plugin.docs, abs))}`;

/** Whether an include takes one of the features it ships: every one, unless it names the ones it takes. */
export const takes = (include: { features?: string[] }, name: string): boolean =>
  !include.features || include.features.includes(name);

/** A project document read from a directory, or nothing when there is none that validates. */
export function readProject(dir: string, file: string): ProjectDoc | undefined {
  const parsed = parseJson(join(dir, PROJECT_FILE), file);
  if ('refusal' in parsed) return undefined;
  const judged = validateDocument(parsed.doc, file);
  return !judged.refusals.length && judged.kind === 'project' ? (parsed.doc as ProjectDoc) : undefined;
}

/** The way into the registry: every document, a tree's or a plugin's, is judged and registered through here. */
export class Documents {
  constructor(
    private readonly registry: Registry,
    private readonly refusals: RefusalList,
  ) {}

  private refuse(refusal: Refusal): void {
    this.refusals.add(refusal);
  }

  /** Judge and register one tree document, the host's or an include's. */
  register(abs: string, file: string, from?: string): void {
    const parsed = parseJson(abs, file);
    if ('refusal' in parsed) {
      this.refuse(parsed.refusal);
      return;
    }
    const judged = validateDocument(parsed.doc, file);
    for (const refusal of judged.refusals) this.refuse(refusal);
    if (judged.refusals.length || !judged.kind) return;
    const kind = judged.kind;
    const feature = featureOf(file);
    const bad = this.misplacedKind(kind, file, feature) ?? misplaced({ kind, file, feature, doc: parsed.doc });
    if (bad) {
      this.refuse(bad);
      return;
    }
    this.registry.add({
      doc: parsed.doc as AnyDoc,
      kind,
      path: `@${file}`,
      name: kind === 'feature' ? (feature ?? stem(file)) : stem(file),
      feature,
      layer: layerOf(`@${file}`),
      file: abs,
      ...(from ? { included: from } : {}),
    });
  }

  /** D003, D004: the project and a feature manifest have one place each; a plugin's kinds are never authored in a tree. */
  private misplacedKind(kind: Kind, file: string, feature: string | undefined): Refusal | null {
    if (kind === 'project')
      return {
        code: 'D003',
        file,
        message: 'the project document is project.json at the root',
        hint: 'move it to project.json, or change its $schema to the kind this file is',
      };
    if (kind === 'feature' && file !== `features/${feature}/feature.json`) {
      return {
        code: 'D003',
        file,
        message: 'a feature lives at features/<name>/feature.json',
        hint: `move it to features/${feature ?? '<name>'}/feature.json`,
      };
    }
    if (NATIVE_KINDS.has(kind))
      return {
        code: 'D004',
        file,
        message: `${kind} documents are shipped by plugins, never authored in a tree`,
        hint: `remove the file; wilanis ls ${kind} shows the ones a plugin grants`,
      };
    return null;
  }

  // ---- plugins ------------------------------------------------------------------------------------

  /** A plugin's documents, under its root: judged like any tree document, marked native (D006 when it ships none, or no plugin.json). */
  registerPlugin(plugin: PluginModule): void {
    let docs: string[];
    try {
      docs = walk(plugin.docs);
    } catch (error) {
      this.refuse({
        code: 'D006',
        file: PROJECT_FILE,
        message: `plugin '${plugin.root}' has no documents at ${plugin.docs}: ${(error as Error).message}`,
        hint: "check the plugin's docs directory is published in its package files",
      });
      return;
    }
    const manifest = docs.find(file => relative(plugin.docs, file) === 'plugin.json');
    if (!manifest) {
      this.refuse({
        code: 'D006',
        file: PROJECT_FILE,
        message: `plugin '${plugin.root}' ships no plugin.json in ${plugin.docs}`,
        hint: `add plugin.json under ${plugin.docs}; it says what the plugin grants`,
      });
    } else this.registerNative(plugin, manifest, new Set());
    // the manifest first, so what it requires is known before the ports it names are registered
    const declared = this.registry.get('plugin', `${plugin.root}/plugin.json`);
    const required = new Set(declared?.doc.requires?.ports ?? []);
    for (const abs of docs) if (abs !== manifest) this.registerNative(plugin, abs, required);
    if (declared) for (const refusal of requiresRefused(declared, this.registry)) this.refuse(refusal);
  }

  /** One document a plugin ships: native, unless it is a port the plugin requires, which is the host's to bind. */
  private registerNative(plugin: PluginModule, abs: string, required: Set<string>): void {
    const path = nativePath(plugin, abs);
    const parsed = parseJson(abs, path);
    if ('refusal' in parsed) {
      this.refuse(parsed.refusal);
      return;
    }
    const judged = validateDocument(parsed.doc, path);
    for (const refusal of judged.refusals) this.refuse(refusal);
    if (judged.refusals.length || !judged.kind) return;
    if (judged.kind === 'port') {
      const bad = badResolves(parsed.doc as PortDoc, path);
      for (const refusal of bad) this.refuse(refusal);
      if (bad.length) return;
    }
    this.registry.add({
      doc: parsed.doc as AnyDoc,
      kind: judged.kind,
      path,
      name: stem(path),
      ...ownedBy(plugin.root, judged.kind === 'port' && required.has(path)),
      file: abs,
    } as Loaded);
  }
}

/** Whose a plugin's document is: the plugin's own (native), or, for a port it requires, the host's to bind. */
function ownedBy(root: string, required: boolean): Pick<Loaded, 'native' | 'requiredBy'> {
  return required ? { requiredBy: root } : { native: root };
}

/** D012: a port a plugin requires is a port under its docs/, and one it does not also grant. */
function requiresRefused(manifest: Loaded<PluginDoc>, registry: Registry): Refusal[] {
  const granted = new Set(manifest.doc.grants.ports ?? []);
  const refusals: Refusal[] = [];
  for (const [index, path] of (manifest.doc.requires?.ports ?? []).entries()) {
    const at = `requires/ports/${index}`;
    if (granted.has(path))
      refusals.push({
        code: 'D012',
        file: manifest.path,
        at,
        message: `'${path}' is both granted and required: a port is the plugin's to implement or the host's to bind, never both`,
        hint: 'list it once: under grants.ports if the plugin implements it, under requires.ports if the host binds it',
      });
    if (registry.get('port', path)?.requiredBy !== manifest.native)
      refusals.push({
        code: 'D012',
        file: manifest.path,
        at,
        message: `'${path}' is required, but no port by that path is under ${manifest.native}'s docs/`,
        hint: `add the port document under the plugin's docs/, or remove '${path}' from requires.ports`,
      });
  }
  return refusals;
}
