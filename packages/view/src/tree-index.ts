/**
 * The document list: every document of one tree, a line each with what a list shows of it, and every refusal the
 * checker made. What one document's page draws is `viewOf`, in `model.ts`.
 */
import { checkTree } from '@wilanis/compiler';
import { type Kind, type Layer, type LoadResult, type Refusal, SCHEMA_BASE } from '@wilanis/core';
import { labelOf } from './types.js';

export interface IndexEntry {
  path: string;
  kind: Kind;
  name: string;
  label: string;
  feature?: string;
  layer?: Layer;
  native?: string;
  included?: string;
  file?: string;
  description: string;
}

export interface TreeIndex {
  root: string;
  project?: string;
  /** Every alias in force -- the project's and the includes' -- so a page can canonicalise a reference written through one. */
  aliases: Record<string, string>;
  /** Where the schemas are published, so a page can recognise a $schema written as a URL. */
  schemaBase: string;
  docs: IndexEntry[];
  refusals: Refusal[];
}

/** Every document of the tree and every refusal, for the document list. */
export function indexOf(load: LoadResult): TreeIndex {
  const refusals = checkTree(load).items;
  const docs = load.registry.files
    .slice()
    .sort((one, other) => one.kind.localeCompare(other.kind) || one.path.localeCompare(other.path))
    .map(file => ({
      path: file.path,
      kind: file.kind,
      name: file.name,
      label: labelOf(file),
      feature: file.feature,
      layer: file.layer,
      native: file.native,
      file: file.file,
      description: file.doc.description,
    }));
  return {
    root: load.root,
    project: load.registry.project?.doc.name,
    aliases: load.aliases,
    schemaBase: SCHEMA_BASE,
    docs,
    refusals,
  };
}
