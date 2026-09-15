/**
 * Where what this repository publishes is read from: a kind's JSON Schema, and a refusal code's page. One
 * repository and one branch carry both, so a document's $schema and a diagnostic's url move together.
 */

import { KINDS, type Kind } from './model.js';

/** The short alias a document may use as its $schema: @wilanis/<kind>.schema.json. */
export const WILANIS = '@wilanis';
/** The repository the schemas and the refusal pages are read from, and the branch that carries the version. */
const REPO = 'wilanis/wilanis-js';
const BRANCH = 'main';
/**
 * Where the schemas are published, so editors and agents can fetch them. The branch name carries the
 * schema version: main until 1.0 is published; from then on a tag (schemas-v1, later schemas-v2) that a
 * document written against it keeps validating under for as long as that version is read.
 */
export const SCHEMA_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/packages/core/schemas`;
/** The short `$schema` a kind's documents carry, the form a reader writes: `@wilanis/graph.schema.json`. */
export const schemaRef = (kind: Kind) => `${WILANIS}/${kind}.schema.json`;
/** Where a kind's schema is fetched from, so an editor or an agent can resolve what the short form names. */
export const schemaUrl = (kind: Kind) => `${SCHEMA_BASE}/${kind}.schema.json`;
/** A code that has a page: one of the ten checker families, or X, what a plugin of this workspace refuses with. */
const CODE_WITH_PAGE = /^[DRLGPBTACSX][0-9]{3}$/;
/** Where a refusal code's page is read, so a diagnostic can link its long form; undefined for a code of no family. */
export const pageUrl = (code: string) =>
  CODE_WITH_PAGE.test(code) ? `https://github.com/${REPO}/blob/${BRANCH}/docs/refusals/${code}.md` : undefined;

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const KIND_OF_SCHEMA = new RegExp(`^(?:${escapeRe(WILANIS)}|${escapeRe(SCHEMA_BASE)})/([a-z-]+)\\.schema\\.json$`);
/** The kind a $schema names, in either form; undefined when it is not a wilanis schema. */
export function kindOfSchema(schema: unknown): Kind | undefined {
  if (typeof schema !== 'string') return undefined;
  const match = KIND_OF_SCHEMA.exec(schema);
  return match && (KINDS as string[]).includes(match[1]) ? (match[1] as Kind) : undefined;
}
