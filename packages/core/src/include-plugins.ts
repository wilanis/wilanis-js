/**
 * Which plugins an include needs from its host (D010): those its walked features use. A feature uses a plugin by
 * naming one of its documents -- a port it runs or binds, a trigger kind, a shape, a codec -- and a reference is the
 * one way it can, since everything a plugin grants is a document under its root. A reference may reach that root
 * through an alias, so each is read through the aliases in force. What a feature leans on without naming the plugin
 * is judged where the host chooses it: a codec by content type against the host's own codec table (the plugin's X
 * rules), the guard by the A family. A plugin the include names only for what a host leaves behind -- its
 * connections, its startup, its run alone -- stays behind with them.
 */
import { PROJECT_FILE } from './documents.js';
import type { ProjectDoc } from './model.js';
import type { Refusal } from './registry.js';

/** The root a reference starts with: @http/http.port.json#request -> @http. */
const ROOT = /^(@[a-z][a-z0-9-]*)(?:[/#]|$)/;

/** Every string a value holds, its object keys among them. */
function stringsOf(value: unknown, into: string[]): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, into);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      stringsOf(item, into);
    }
  return into;
}

/** The roots the references in these documents start with, once each is read through `resolve` (the aliases in force). */
export function rootsReferenced(docs: readonly unknown[], resolve: (ref: string) => string): Set<string> {
  const roots = new Set<string>();
  for (const text of stringsOf(docs, [])) {
    // prose and plain values start with no root, and name no document
    if (!ROOT.test(text)) continue;
    const root = ROOT.exec(resolve(text))?.[1];
    if (root) roots.add(root);
  }
  return roots;
}

/** What an include is, for D010: the package it comes from, where project.json names it, and the plugins its own names. */
export interface IncludeUses {
  from: string;
  at: string;
  plugins: ProjectDoc['plugins'];
}

/** D010: the plugins an include names and its walked features use (`used`), which this project does not name (`named`). */
export function unnamedPlugins(include: IncludeUses, used: Set<string>, named: Set<string>): Refusal[] {
  return include.plugins
    .filter(use => used.has(use.use) && !named.has(use.use))
    .map(use => {
      const from = use.use === '@std' || use.use === '@cli' ? '' : `, "from": "..."`;
      return {
        code: 'D010',
        file: PROJECT_FILE,
        at: include.at,
        message: `'${include.from}' uses plugin '${use.use}', which this project does not name`,
        hint: `add { "use": "${use.use}"${from} } to project.json → plugins, with the settings its README says`,
      };
    });
}
