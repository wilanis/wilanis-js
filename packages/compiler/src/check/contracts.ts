/**
 * Shapes, ports and connections. A shape's fields resolve and speak their own layer (R001, L001, L005). A
 * port's operations resolve; a domain operation speaks core shapes and fixes no value itself (L001, L006);
 * what an operation says about repeating it names its own fields and types as boolean (C015).
 * A connection names a kind and its settings fit it, reading secrets only (R001, C001, C002). What a store
 * declares is judged beside it, in `stores.ts`.
 */
import {
  type ConnectionDoc,
  expr,
  type Loaded,
  type Operation,
  type PortDoc,
  type ShapeDoc,
  show,
} from '@wilanis/core';
import type { Judge } from './judge.js';
import { mismatch } from './typing.js';

/**
 * The refusals for a shape: its fields resolve (R001) and, in a tree's own shape, name only shapes of its
 * own layer, visibly (L001, L005). A native shape is exempt, the way a native port is: it may name a type
 * variable, which reads as unknown unless the port that returns the shape binds it.
 */
export function checkShape(judge: Judge, shape: Loaded<ShapeDoc>): void {
  const spec = { fields: shape.doc.fields, open: shape.doc.open };
  judge.type(spec, shape.path, 'fields');
  if (!shape.native)
    judge.checkLayer({ spec, from: shape, at: 'fields', layer: shape.doc.layer, what: `shape '${shape.path}'` });
}

/**
 * The refusals for a port: every operation's accepts and returns resolve (R001), and a domain port's speak
 * core shapes it may see (L001, L005) and fix no value of their own (L006).
 */
export function checkPort(judge: Judge, port: Loaded<PortDoc>): void {
  for (const [name, op] of Object.entries(port.doc.operations)) {
    judge.fieldsType(op.accepts, port.path, `operations/${name}/accepts`);
    judge.type(op.returns, port.path, `operations/${name}/returns`);
    if (op.transactional) checkTransactional(judge, port, name, op);
    if (!port.native) checkDomainOperation(judge, port, name, op);
    else checkRepeatable(judge, port, name, op);
  }
}

const REPEATABLE_HINT =
  'key names one accepted field; idempotent is true, or an expression over the accepted fields that is boolean; a pure operation is idempotent already';

/**
 * C015: what a native operation says about repeating it is one fact and a sound one. A `key` is a field it
 * accepts, and is not written beside `idempotent`; a `pure` operation says neither, being idempotent already;
 * an `idempotent` expression types as boolean over the accepted fields, as a switch rule types over its inputs.
 */
function checkRepeatable(judge: Judge, port: Loaded<PortDoc>, name: string, op: Operation): void {
  const refuse = (message: string, at: string) =>
    judge.refuser(port.path)('C015', message, `operations/${name}${at}`, REPEATABLE_HINT);
  for (const [message, at] of repeatableFaults(name, op)) refuse(message, at);
  if (typeof op.idempotent !== 'string') return;
  const wrong = notBoolean(judge, op, op.idempotent);
  if (wrong) refuse(`operation '${name}' is idempotent when ${wrong}`, '/idempotent');
}

/** What is wrong with how an operation's words about repeating it sit together, each with where below it. */
function repeatableFaults(name: string, op: Operation): [string, string][] {
  const faults: [string, string][] = [];
  const keyed = op.key !== undefined;
  if (keyed && !(String(op.key) in (op.accepts ?? {})))
    faults.push([`operation '${name}' names key '${op.key}', which is not a field it accepts`, '/key']);
  if (keyed && op.idempotent !== undefined) faults.push([`operation '${name}' declares both idempotent and key`, '']);
  if (op.pure && (op.idempotent !== undefined || keyed))
    faults.push([`pure operation '${name}' declares ${keyed ? 'key' : 'idempotent'}`, '']);
  return faults;
}

/** Why an `idempotent` expression is not a boolean over the operation's accepted fields, or nothing. */
function notBoolean(judge: Judge, op: Operation, rule: string): string | undefined {
  const accepts = judge.acceptsType(op);
  const inputs: expr.Inputs = {};
  if (accepts?.kind === 'object') {
    for (const [field, typed] of Object.entries(accepts.fields))
      inputs[field] = { type: typed.type, optional: !typed.required };
  }
  try {
    const type = expr.check(expr.parse(rule), inputs);
    return type.kind === 'boolean' ? undefined : `'${rule}', which is ${show(type)}, not boolean`;
  } catch (error) {
    return `'${rule}', which cannot be typed: ${(error as Error).message}`;
  }
}

/**
 * C009: a transactional operation says where it goes, statically. One of the two fields the compiler knows
 * how to follow -- `connection`, a connection document, or `store`, a store document that names one -- must
 * be accepted and marked static, since an atomic graph's one transaction is judged before anything runs and
 * a value only known at run time could not be judged at all.
 */
function checkTransactional(judge: Judge, port: Loaded<PortDoc>, name: string, op: Operation): void {
  const says = (field: string) => op.accepts?.[field]?.static === true;
  if (says('connection') || says('store')) return;
  judge.refuser(port.path)(
    'C009',
    `operation '${name}' is transactional but accepts no static 'connection' or 'store' to resolve one from`,
    `operations/${name}/accepts`,
    'accept "connection" (a connection document) or "store" (a store document that names one), marked "static": true',
  );
}

/**
 * A domain operation speaks core shapes (L001), marks nothing static (L006) -- a binding fixes values -- and
 * promises only `idempotent: true` about repeating it (C015): the field a key names, and the inputs an
 * expression reads, belong to the native operation its binding reaches.
 */
function checkDomainOperation(judge: Judge, port: Loaded<PortDoc>, name: string, op: Operation): void {
  const at = `operations/${name}`;
  const accepts = Object.entries(op.accepts ?? {});
  for (const [key, field] of accepts) {
    judge.checkLayer({
      spec: field.type,
      from: port,
      at: `${at}/accepts/${key}`,
      layer: 'core',
      what: `${name}.accepts.${key}`,
    });
  }
  if (op.returns)
    judge.checkLayer({ spec: op.returns, from: port, at: `${at}/returns`, layer: 'core', what: `${name}.returns` });
  for (const [key, field] of accepts) {
    if (!field.static) continue;
    const message = `domain operation '${name}' marks '${key}' static -- static fields belong to native contracts; a binding fixes values`;
    judge.refuser(port.path)('L006', message, `${at}/accepts/${key}`, 'drop static, or fix the value in the binding');
  }
  checkDomainPromise(judge, port, name, op);
}

/** C015 for a domain operation: a `key`, or an `idempotent` that is an expression, is refused. */
function checkDomainPromise(judge: Judge, port: Loaded<PortDoc>, name: string, op: Operation): void {
  const hint =
    'a domain operation may say "idempotent": true; the field a key names belongs to the native operation its binding reaches';
  const refuse = judge.refuser(port.path);
  if (op.key !== undefined)
    refuse('C015', `domain operation '${name}' declares key '${op.key}'`, `operations/${name}/key`, hint);
  if (typeof op.idempotent === 'string') {
    const message = `domain operation '${name}' is idempotent when '${op.idempotent}'; only true is a promise its bindings can be held to`;
    refuse('C015', message, `operations/${name}/idempotent`, hint);
  }
}

/**
 * The refusals for a connection: the kind it names exists (R001), its settings read secrets only (C001) and
 * fit what that kind declares (C002).
 */
export function checkConnection(judge: Judge, connection: Loaded<ConnectionDoc>): void {
  const refuse = judge.refuser(connection.path);
  const kind = judge.scope.get('connection-kind', connection.doc.kind);
  if (!kind) {
    refuse('R001', `unknown connection kind '${connection.doc.kind}'`, 'kind', 'wilanis ls connection-kind');
    return;
  }
  const declared = judge.type(kind.doc.settings, connection.path, 'settings');
  const read = judge.settingsRead(connection.doc.settings, connection.path, 'settings');
  const bad = mismatch(read?.type, declared);
  if (bad) refuse('C002', `settings: ${bad}`, 'settings', `wilanis describe ${connection.doc.kind}`);
}
