/**
 * What the engine suite is written against: the shape its records have, the seeds it starts from, and the
 * helpers a case names a collection and begins a transaction through. It holds no case of its own -- the
 * cases are `suite.ts` (records) and `suite-transactions.ts` (transactions), and both are written against
 * exactly this, so an engine is judged by one fixture however many families of case there come to be.
 */
import { strict as assert } from 'node:assert';
import type { Type } from '@wilanis/core';
import type { At, Engine, Record_, Scope, Transaction } from './engine.js';
import { parseWhere } from './where.js';

/** The shape the suite keeps: one required field of each kind the grammar tests, and one optional. */
export const SHAPE: Type = {
  kind: 'object',
  name: 'Entry',
  open: false,
  fields: {
    id: { type: { kind: 'string' }, required: true },
    url: { type: { kind: 'string' }, required: true },
    method: { type: { kind: 'string' }, required: true },
    hits: { type: { kind: 'number' }, required: true },
    ok: { type: { kind: 'boolean' }, required: true },
    ua: { type: { kind: 'string' }, required: false },
  },
};

/** What an engine's own tests hand the suite: the engine, and the connection it was registered for. */
export interface Subject {
  engine: Engine;
  connection: { connection: string; kind: string; settings: Record<string, unknown> };
}

/** One thing every engine must do, by the name it is done under. */
export interface Case {
  name: string;
  run(subject: Subject): Promise<void>;
}

/** One record of the suite's shape: the three fields every case needs, and whatever else it asks for. */
export const entry = (id: string, url: string, method: string, rest: Partial<Record_> = {}): Record_ => ({
  id,
  url,
  method,
  hits: 1,
  ok: true,
  ...rest,
});

export const SEEDS: Record_[] = [
  entry('a', 'https://one.example/a', 'GET', { hits: 3, ua: 'curl' }),
  entry('b', 'https://two.example/b', 'POST', { hits: 7, ok: false }),
  entry('c', 'http://localhost/c', 'GET', { hits: 5, ua: 'wget' }),
];

/** The keys of the records handed back, sorted, so a case compares what was found without minding the order. */
export const ids = (records: Record_[]) => records.map(record => String(record.id)).sort();
/** A filter parsed against the suite's shape, so a case writes what it means and the grammar judges it once. */
export const where = (filter: unknown) => parseWhere(filter, SHAPE);

/** What a case declares beyond the shape: the constraints the engine is to answer for. */
export type Declared = Partial<Pick<At, 'unique' | 'refs' | 'referenced' | 'defaults'>>;

/** A collection of the subject's connection, named for the case that keeps its records there. */
export function at(subject: Subject, name: string, declared: Declared = {}): At {
  return {
    ...subject.connection,
    name,
    shape: SHAPE,
    key: 'id',
    unique: [],
    refs: [],
    referenced: [],
    defaults: {},
    ...declared,
  };
}

/** A collection made, emptied of anything a previous run left, and filled with the seeds. */
export async function seeded(
  subject: Subject,
  name: string,
  records: Record_[] = SEEDS,
  declared: Declared = {},
): Promise<At> {
  const where_ = at(subject, name, declared);
  await subject.engine.ensure([where_]);
  await emptied(subject, where_);
  for (const record of records) await subject.engine.put(where_, record, { replace: true });
  return where_;
}

/**
 * Every record of a collection removed, whatever scope it was written under. It reads and removes without
 * one, which is the view's way of seeing a table: a case that seeds a scoped collection has to start from
 * empty across every scope, or the row a previous run left under another tenant outlives it.
 */
export async function emptied(subject: Subject, where_: At): Promise<void> {
  for (const record of await subject.engine.find(where_, {})) await subject.engine.remove(where_, record.id);
}

/**
 * The two scopes every scope case is written against, and the collection they share. A scope is whatever the
 * store bound; these stand for two tenants, which is the case the rule was written for.
 */
export const ACME: Scope = { tenant: 'acme' };
export const GLOBEX: Scope = { tenant: 'globex' };

/** A scoped collection made and emptied across every scope, so a case starts from nothing under both. */
export async function scoped(subject: Subject, name: string, declared: Declared = {}): Promise<At> {
  const where_ = at(subject, name, declared);
  await subject.engine.ensure([where_]);
  await emptied(subject, where_);
  return where_;
}

/** The keys a filter finds in one collection: the reading half of nearly every case, said once. */
export const found = async (subject: Subject, where_: At, filter: unknown) =>
  ids(await subject.engine.find(where_, { where: where(filter) }));

/** The keys one scope sees of a collection, which is the reading half of nearly every scope case. */
export const foundIn = async (subject: Subject, where_: At, scope: Scope | undefined) =>
  ids(await subject.engine.find(where_, { scope }));

/**
 * The transaction the engine begins, failing the case rather than skipping it where it begins none: taking
 * part in one is what an engine is for, and an engine that cannot is one an atomic graph cannot be run on.
 */
export async function began(subject: Subject, where_: At): Promise<Transaction> {
  const opened = await subject.engine.begin?.(where_);
  assert.ok(opened, 'an engine begins a transaction, so that an atomic graph can run on it');
  return opened;
}
