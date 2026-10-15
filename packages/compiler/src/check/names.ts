/**
 * C025: what a field's `names` marks (RFC 0037). The compiler finds the connections a call reaches by the fields
 * its contract marks `"names": "connection"` or `"names": "store"`, never by a field's name, so a mark is held to
 * what reading it needs: a string or a list of strings, and on a contract a static one, since a call's connections
 * are known before anything runs. Only a native contract and a connection kind name a document; a shape or a
 * domain operation that marks a field is refused, and so is a native static field called `connection` or `store`
 * that does not say `names`, which the compiler once read by its name and now would pass over in silence.
 */
import {
  type ConnectionKindDoc,
  type Field,
  type Fields,
  type Loaded,
  type Names,
  type PortDoc,
  type ShapeDoc,
  show,
  type Type,
} from '@wilanis/core';
import type { Judge, Refuser } from './judge.js';

const MARK_HINT = 'mark it "names": "connection" or "names": "store", static, of type string or string[]';
const DROP_HINT =
  'drop "names": only a native contract\'s static field or a connection kind\'s setting names a connection or a store';

/** The names a field was once read by, each the word its mark now says. */
const READ_BY_NAME: Record<string, Names> = { connection: 'connection', store: 'store' };

/** Where a mark is judged: the document's refuser, and what the document is, which decides what a mark may be. */
interface Marking {
  judge: Judge;
  refuse: Refuser;
  /** A native contract's field must be static; a connection kind's setting need not; anywhere else no field names. */
  where: 'contract' | 'setting' | 'shape' | 'domain';
}

/** C025 for every field of a port's operations, what each accepts and what each returns. */
export function checkPortNames(judge: Judge, port: Loaded<PortDoc>): void {
  const marking: Marking = { judge, refuse: judge.refuser(port.path), where: port.native ? 'contract' : 'domain' };
  for (const [name, op] of Object.entries(port.doc.operations)) {
    // a shape named whole is judged as a shape
    if (typeof op.accepts !== 'string') checkFields(marking, op.accepts, `operations/${name}/accepts`);
    if (typeof op.returns === 'object') checkFields(marking, op.returns.fields, `operations/${name}/returns/fields`);
    if (port.native && typeof op.accepts === 'object')
      checkReadByName(marking, op.accepts, `operations/${name}/accepts`);
  }
}

/** C025 for a shape's fields: a shape names no document, whoever's it is. */
export function checkShapeNames(judge: Judge, shape: Loaded<ShapeDoc>): void {
  checkFields({ judge, refuse: judge.refuser(shape.path), where: 'shape' }, shape.doc.fields, 'fields');
}

/** C025 for a connection kind's settings: a setting that names connections or stores is a string or a list of them. */
export function checkKindNames(judge: Judge, kind: Loaded<ConnectionKindDoc>): void {
  checkFields(
    { judge, refuse: judge.refuser(kind.path), where: 'setting' },
    kind.doc.settings.fields,
    'settings/fields',
  );
}

/** Every field marked `names`, at any depth of inline objects, held to what the document may mark. */
function checkFields(marking: Marking, fields: Fields | undefined, at: string): void {
  for (const [name, field] of Object.entries(fields ?? {})) {
    const where = `${at}/${name}`;
    if (typeof field.type === 'object') checkFields(marking, field.type.fields, `${where}/type/fields`);
    if (field.names) checkMark(marking, name, field, `${where}/names`);
  }
}

/** One mark: refused outright on a shape or a domain operation, else held to its type and, on a contract, to static. */
function checkMark({ judge, refuse, where }: Marking, name: string, field: Field, at: string): void {
  const said = `field '${name}' says "names": "${field.names}"`;
  if (where === 'shape' || where === 'domain') {
    const what = where === 'shape' ? 'a shape' : 'a domain operation, which a binding meets';
    refuse('C025', `${said}, and is a field of ${what}`, at, DROP_HINT);
    return;
  }
  const type = judge.quiet(field.type);
  if (type && !namesType(type)) {
    refuse('C025', `${said}, but is ${show(type)}, not a string or a list of strings`, at, MARK_HINT);
  }
  if (where === 'contract' && field.static !== true) {
    const message = `${said}, but is not static: what a call names is read before anything runs, so it is a literal`;
    refuse('C025', message, at, MARK_HINT);
  }
}

/** Whether a type is one a mark may sit on: a string, or a list of strings. */
function namesType(type: Type): boolean {
  return type.kind === 'string' || (type.kind === 'list' && type.of.kind === 'string');
}

/** A native static field called `connection` or `store` that says no `names`: read by its name once, by nothing now. */
function checkReadByName({ refuse }: Marking, accepts: Fields, at: string): void {
  for (const [name, field] of Object.entries(accepts)) {
    const word = READ_BY_NAME[name];
    if (!word || field.static !== true || field.names) continue;
    const message = `static field '${name}' does not say "names": the compiler would read no ${word} from it`;
    const hint = `the compiler reads a field by its mark, no longer by its name: add "names": "${word}"`;
    refuse('C025', message, `${at}/${name}`, hint);
  }
}
