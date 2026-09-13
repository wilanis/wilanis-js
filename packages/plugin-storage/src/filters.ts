/**
 * X208, X209, X210: what a call asks of the records, against the shape the collection declares. A filter is
 * held to the `where` grammar -- the same parse an engine compiles -- and then every value it tests with is
 * judged: a literal as written, a read by the type it reads, as far as this plugin can type one.
 */
import {
  assignable,
  conforms,
  type ObjField,
  type PluginCheckContext,
  type ResolveRoot,
  show,
  type Type,
  typeAt,
} from '@wilanis/core';
import { type Call, collectionOf } from './calls.js';
import { type Test, type Where, WhereError, type WhereFault, whereOf } from './where.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

/** Which code each way of being wrong carries, and where it sends the reader for the fix. */
const CODE_OF: Record<WhereFault, string> = { name: 'X208', value: 'X209', grammar: 'X210' };
const HINT_OF: Record<WhereFault, (store: string) => string> = {
  name: store => `wilanis describe ${store}`,
  value: store => `wilanis describe ${store}`,
  grammar: () => 'see The where grammar in @storage/store.port.json',
};

/** X208, X209, X210: the filter a call gives, held to the grammar against the collection's shape. */
function checkWhere(call: Call, shape: Type, site: Site): Where | undefined {
  try {
    // a read is not yet the value it will be, so the grammar judges its shape nowhere but at run time
    return whereOf(call.given?.where, shape, value => !site.scope.literal(value));
  } catch (error) {
    if (!(error instanceof WhereError)) throw error;
    site.refuse({
      code: CODE_OF[error.fault],
      file: call.file,
      message: error.message.replace(/^where: /, ''),
      at: [`${call.at}/where`, ...error.at].join('/'),
      hint: HINT_OF[error.fault](String(call.given?.store)),
    });
    return undefined;
  }
}

/** X208: every `order` entry names a field of the collection's shape. */
function checkOrder(call: Call, fields: Record<string, ObjField>, refuse: Refuse): void {
  const order = call.given?.order;
  if (!Array.isArray(order)) return;
  for (const [index, one] of order.entries()) {
    const by = (one as { by?: unknown })?.by;
    if (typeof by !== 'string' || fields[by]) continue;
    refuse({
      code: 'X208',
      file: call.file,
      message: `'${by}' is not a field of the collection's shape (fields: ${Object.keys(fields).join(', ')})`,
      at: `${call.at}/order/${index}/by`,
      hint: `wilanis describe ${call.given?.store}`,
    });
  }
}

/** What one operator compares with: the field's own type, a list of it, a boolean, or text. */
function wanted(test: Test, type: Type): Type {
  if (test.op === 'has') return { kind: 'boolean' };
  if (test.op === 'contains' || test.op === 'startsWith') return { kind: 'string' };
  if (test.op === 'in' || test.op === 'notIn') return { kind: 'list', of: type };
  return type;
}

/**
 * X209: one test's value is one the field would accept -- a literal judged as written, a read judged by the
 * type it reads. A read this plugin cannot see the type of is left unjudged; see the note on `check`.
 */
function checkTest(call: Call, field: string, test: Test, site: Site): void {
  const type = wanted(test, site.fields[field].type);
  const bad = site.scope.literal(test.value) ? conforms(test.value, type, field) : readMismatch(test.value, type, site);
  if (!bad) return;
  site.refuse({
    code: 'X209',
    file: call.file,
    message: bad,
    at: [`${call.at}/where`, ...test.at].join('/'),
    hint: `${field} is ${show(site.fields[field].type)}`,
  });
}

/** What a filter's values are judged against, carried down the tree rather than threaded through four params. */
interface Site {
  scope: Scope;
  refuse: Refuse;
  fields: Record<string, ObjField>;
  /** how a `{{...}}` read is typed here; it answers nothing for a root this plugin cannot see */
  resolve: ResolveRoot;
}

/**
 * What a read is typed as where this plugin can see it. `in` it can: a graph's in shape and an operation's
 * accepts are documents. A node's output it cannot -- that table is the graph checker's, and so is the
 * narrowing a switch does -- so such a read answers nothing and is left unjudged.
 */
function readsOf(reads: Type | undefined): ResolveRoot {
  return (root, path) => {
    if (root !== 'in' || !reads) return undefined;
    const read = typeAt(reads, path);
    return typeof read === 'string' ? undefined : read;
  };
}

/** Why a read does not fit, or nothing -- including where it is a read this plugin cannot type. */
function readMismatch(value: unknown, want: Type, site: Site): string | null {
  const read = site.scope.valueRead(value, site.resolve);
  if (!read || typeof read === 'string') return null;
  return assignable(read.type, want);
}

/** X209: every value the parsed filter tests with, wherever it sits under a combinator. */
function checkValues(call: Call, where: Where, site: Site): void {
  if (where.kind === 'not') {
    checkValues(call, where.of, site);
    return;
  }
  if (where.kind === 'all' || where.kind === 'any') {
    for (const one of where.of) checkValues(call, one, site);
    return;
  }
  if (!site.fields[where.field]) return;
  for (const test of where.tests) checkTest(call, where.field, test, site);
}

/** X208, X209, X210: what a call asks of the records, against the shape the collection declares. */
export function checkFilter(call: Call, scope: Scope, refuse: Refuse): void {
  const collection = collectionOf(call, scope);
  if (!collection) return; // X204, or R001 where the store is judged
  const { shape, fields } = collection;
  checkOrder(call, fields, refuse);
  const site: Site = { scope, refuse, fields, resolve: readsOf(call.reads) };
  const where = checkWhere(call, shape, site);
  if (where) checkValues(call, where, site);
}
