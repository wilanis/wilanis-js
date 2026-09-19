/**
 * X104: where files.port.json keeps records. A relative dir is under the tree, so it must stay under it and out of
 * the directories the loader reads: a record written under features/ or connections/ would be read back as a
 * document, and one written above the tree is not the tree's to keep.
 */
import { isAbsolute, normalize } from 'node:path';
import type { PluginCheckContext } from '@wilanis/core';
import { doc } from './settings.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

/** The directories of a tree the loader reads documents from. */
const READ = new Set(['features', 'connections']);

/** Why a dir written in a delegation cannot hold records, or nothing when it can. */
function wrongDir(dir: string): string | undefined {
  if (isAbsolute(dir)) return undefined;
  const clean = normalize(dir).replaceAll('\\', '/');
  if (clean === '.' || clean === '') return 'is the tree itself';
  if (clean === '..' || clean.startsWith('../')) return 'is outside the tree';
  const first = clean.split('/')[0];
  return READ.has(first) ? `is under ${first}/, which the loader reads` : undefined;
}

/** Every delegation a binding makes to files.port.json, by operation name, with the dir it writes. */
function delegations(scope: Scope): { path: string; name: string; dir: unknown }[] {
  const files = doc('files.port.json');
  return scope.registry.all('binding').flatMap(binding =>
    Object.entries(binding.doc.operations)
      .filter(([, operation]) => operation.run && scope.canon(operation.run.split('#')[0]) === files)
      .map(([name, operation]) => ({ path: binding.path, name, dir: operation.in?.dir })),
  );
}

/** X104: every delegation to files.port.json names a dir under the tree the loader never reads, or an absolute one. */
export function checkDirs(scope: Scope, refuse: Refuse) {
  for (const { path, name, dir } of delegations(scope)) {
    const why = typeof dir === 'string' ? wrongDir(dir) : undefined;
    if (why)
      refuse({
        code: 'X104',
        file: path,
        message: `'${name}' keeps records in '${dir}', which ${why}`,
        at: `operations/${name}/in/dir`,
        hint: '.wilanis/auth, or an absolute path outside the tree',
      });
  }
}
