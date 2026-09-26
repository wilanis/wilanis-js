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
/** What a schema's address is on either side of the ref it is read at, which is the only part a version changes. */
const RAW = `https://raw.githubusercontent.com/${REPO}`;
const SCHEMAS = 'packages/core/schemas';
/**
 * Where the schemas are published, so editors and agents can fetch them. The branch name carries the
 * schema version: main until 1.0 is published; from then on a tag (schemas-v1, later schemas-v2) that a
 * document written against it keeps validating under for as long as that version is read.
 */
export const SCHEMA_BASE = `${RAW}/${BRANCH}/${SCHEMAS}`;
/** The short `$schema` a kind's documents carry, the form a reader writes: `@wilanis/graph.schema.json`. */
export const schemaRef = (kind: Kind) => `${WILANIS}/${kind}.schema.json`;
/** Where a kind's schema is fetched from, so an editor or an agent can resolve what the short form names. */
export const schemaUrl = (kind: Kind) => `${SCHEMA_BASE}/${kind}.schema.json`;
/** A code that has a page: one of the eleven checker families, or X, what a plugin of this workspace refuses with. */
const CODE_WITH_PAGE = /^[DRLGPBTAICSX][0-9]{3}$/;
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

/**
 * The schema version a base URL serves, RFC 0008's segment of it: `v1` while the base is on `main` or on the tag
 * `schemas-v1`, and `vN` once it moves to `schemas-vN`.
 */
export const irOf = (base: string): string => /\/schemas-(v[0-9]+)\//.exec(base)?.[1] ?? 'v1';
/** The one IR version this runtime reads (RFC 0008): the version its schema base serves. */
export const IR_READ = irOf(SCHEMA_BASE);

const AT_A_TAG = new RegExp(`^${escapeRe(RAW)}/schemas-(v[0-9]+)/${escapeRe(SCHEMAS)}/[a-z-]+\\.schema\\.json$`);
/**
 * The IR version a $schema names: the one this runtime reads for the alias, which names no version of its own, and
 * for a kind under SCHEMA_BASE; `vN` for a schema at the tag `schemas-vN`, whatever the kind, since a version this
 * runtime does not read may have kinds it does not know; undefined for anything else.
 */
export function irOfSchema(schema: unknown): string | undefined {
  if (kindOfSchema(schema)) return IR_READ;
  return typeof schema === 'string' ? AT_A_TAG.exec(schema)?.[1] : undefined;
}
