/**
 * L019: a field the compiler provides (RFC 0032) is declared where the compiler can provide it, and as what it
 * provides. `provided: site` sits on a field of a native operation's `accepts` and nowhere else -- a domain operation
 * is met by a binding, and a shape is a type, not a call -- and that field is `@std/Site.shape.json`, never secret,
 * always given, since the compiler writes two public strings at every site and no author can leave them out.
 */
import type { Fields, Loaded, Operation, PortDoc } from '@wilanis/core';
import { SITE_SHAPE } from '../std-ops.js';
import type { Judge } from './judge.js';

const NOT_HERE = 'drop provided, or ask for the site in the native operation the binding runs';
const AS_SITE = 'a provided site is @std/Site.shape.json, never secret, always given';

/** Where fields that may not be provided were written: the file, the fields, their path in it, and what wrote them. */
interface Written {
  file: string;
  fields: Fields | undefined;
  at: string;
  /** `shape '<path>'` or `domain operation '<name>'`, for the message */
  what: string;
}

/** L019 over fields written somewhere no field may be provided: a shape, a domain operation. */
export function checkProvidedAt(judge: Judge, written: Written): void {
  const why = written.what.startsWith('shape')
    ? 'a shape is a type, not a call'
    : 'a domain operation is met by a binding';
  for (const [key, field] of Object.entries(written.fields ?? {})) {
    if (!field.provided) continue;
    const message = `${written.what} marks '${key}' provided -- ${why}; the site is a native operation's to ask for`;
    judge.refuser(written.file)('L019', message, `${written.at}/${key}`, NOT_HERE);
  }
}

/**
 * L019 over an operation's own fields: refused on a domain operation, and on a native operation wherever the field
 * is not what the compiler writes -- another type than the site's shape, or secret, or optional.
 */
export function checkProvidedFields(judge: Judge, port: Loaded<PortDoc>, name: string, op: Operation): void {
  // a shape named whole is judged as a shape; only fields written here can mark themselves provided
  const fields = typeof op.accepts === 'string' ? undefined : op.accepts;
  const at = `operations/${name}/accepts`;
  if (!port.native) {
    checkProvidedAt(judge, { file: port.path, fields, at, what: `domain operation '${name}'` });
    return;
  }
  for (const [key, field] of Object.entries(fields ?? {})) {
    if (!field.provided) continue;
    const wrong = notASite(judge, field.type, field);
    if (!wrong) continue;
    const message = `native operation '${name}' marks '${key}' provided, but ${wrong}`;
    judge.refuser(port.path)('L019', message, `${at}/${key}`, AS_SITE);
  }
}

/** Why a provided field is not the site the compiler writes; nothing when it is. */
function notASite(judge: Judge, type: Fields[string]['type'], field: Fields[string]): string | undefined {
  const site = judge.scope.canon(SITE_SHAPE);
  if (typeof type !== 'string' || judge.scope.canon(type) !== site) return `its type is not ${SITE_SHAPE}`;
  if (field.secret) return 'it is secret, and a site is two public strings';
  if (field.required === false) return 'it is optional, and the compiler writes it at every site';
  return undefined;
}
