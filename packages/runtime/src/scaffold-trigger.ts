/**
 * The trigger `wilanis new trigger` writes. Without `--kind` it is a route, the one kind every fresh project names;
 * with any other kind the settings come from that kind's own document, read where its plugin ships it, so a kind
 * published tomorrow scaffolds without this module learning its vocabulary. The settings a kind requires are
 * written with a placeholder of their type; a kind that requires none, as one taking either of two settings,
 * gets the first it declares, so the author sees where the setting goes and `wilanis check` says what it takes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Field } from '@wilanis/core';
import { BUILTIN_PLUGINS } from './plugins/index.js';

/** The kind a trigger is scaffolded as when `--kind` names none. */
export const ROUTE_KIND = '@http/http.trigger-kind.json';

/** A route's settings, written out: the demo's scaffold and every fresh project's first trigger. */
const ROUTE_SETTINGS = { route: '/todo', method: 'GET', produces: 'application/json' };

/**
 * The directory a package's entry sits under: the nearest one holding a package.json. Resolving the entry finds
 * the package without loading it, so no plugin's code runs to scaffold a document.
 */
function packageDir(entry: string): string | undefined {
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir))
    if (existsSync(join(dir, 'package.json'))) return dir;
  return undefined;
}

/**
 * Where one plugin's documents live: a builtin's own, or the `docs/` directory a plugin package ships beside its
 * package.json -- the directory its `PluginModule.docs` names and its `files` publishes.
 */
function docsOf(root: string, use: string): string | undefined {
  if (BUILTIN_PLUGINS[use]) return BUILTIN_PLUGINS[use].docs;
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as {
    plugins?: { use?: string; from?: string }[];
  };
  const from = project.plugins?.find(plugin => plugin.use === use)?.from;
  if (!from) return undefined;
  const dir = packageDir(createRequire(join(root, 'package.json')).resolve(from));
  return dir ? join(dir, 'docs') : undefined;
}

/** The settings one trigger kind declares, read off its document; a kind the tree cannot reach is said to be so. */
function declaredSettings(root: string, kind: string): Record<string, Field> {
  const [use, ...rest] = kind.split('/');
  let fields: Record<string, Field> | undefined;
  try {
    const docs = docsOf(root, use);
    const doc = docs ? JSON.parse(readFileSync(join(docs, ...rest), 'utf8')) : undefined;
    fields = doc?.settings?.fields;
  } catch {
    fields = undefined;
  }
  if (!fields)
    throw new Error(
      `cannot read the trigger kind '${kind}'; name its plugin in project.json → plugins (with from) and npm install it`,
    );
  return fields;
}

/** A value of one setting's type for the author to replace: its first word where it has a closed set. */
function placeholder(field: Field): unknown {
  if (field.enum?.length) return field.enum[0];
  if (field.type === 'string') return 'TODO';
  if (field.type === 'number') return 0;
  if (field.type === 'boolean') return false;
  return undefined;
}

/** The settings a trigger of one kind is first written with: those it requires, else the first it declares. */
export function triggerSettings(root: string, kind: string): Record<string, unknown> {
  if (kind === ROUTE_KIND) return { ...ROUTE_SETTINGS };
  const fields = Object.entries(declaredSettings(root, kind));
  const required = fields.filter(([, field]) => field.required !== false);
  const written: Record<string, unknown> = {};
  for (const [name, field] of required.length ? required : fields.slice(0, 1)) {
    const value = placeholder(field);
    if (value !== undefined) written[name] = value;
  }
  return written;
}
