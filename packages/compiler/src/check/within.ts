/**
 * G028: a path within the element is typed. A static string field a native contract marks `within: $T` names a
 * dotted path within the type `$T` is bound to where the operation is called. The checker holds the path to a field
 * that type has, required at every step, and ending at a value of the field's `reaches` type -- so the handler that
 * reads the path finds what the contract promised, and no tree can write a path it does not.
 */
import { assignable, type Field, type Fields, hasVars, show, substitute, type Type, typeAt } from '@wilanis/core';
import type { Judge } from './judge.js';

/** What the call gives and where it sits, as `checkInputs` holds it. */
export interface WithinSite {
  given: Record<string, unknown>;
  file: string;
  at: string;
}

/** How deep the hint looks for fields to offer: a shape that holds itself would otherwise never end. */
const DEPTH = 4;

/** G028 for every field of one call site marked `within`, against the variables the site has bound. */
export function checkWithin(judge: Judge, site: WithinSite, accepts: Fields, bound: Record<string, Type>): void {
  for (const [name, field] of Object.entries(accepts)) {
    const value = site.given[name];
    if (field.within && typeof value === 'string' && judge.scope.literal(value))
      checkPath(judge, site, { name, field, path: value }, bound);
  }
}

/** One field marked `within` and the path its literal writes. */
interface Written {
  name: string;
  field: Field;
  path: string;
}

/** G028 for one path, once the variable it is a path within is bound; an unbound one is refused where it binds. */
function checkPath(judge: Judge, site: WithinSite, written: Written, bound: Record<string, Type>): void {
  const element = written.field.within ? bound[written.field.within] : undefined;
  if (!element) return;
  const want = reached(judge, written.field.reaches, bound);
  const fault = faultOf(element, written.path, want);
  if (!fault) return;
  const kind = want ? `${show(want)} ` : '';
  const offered = reaching(element, want, '', 0).join(', ') || 'it has none';
  const hint = `name a required ${kind}field of the element: ${offered}`;
  judge.refuser(site.file)('G028', `${written.name}: ${fault}`, `${site.at}/${written.name}`, hint);
}

/** The type the path must end at, with the site's variables put in; nothing when the field says no `reaches`. */
function reached(judge: Judge, reaches: string | undefined, bound: Record<string, Type>): Type | undefined {
  const want = judge.quiet(reaches);
  return want && hasVars(want) ? substitute(want, bound) : want;
}

/** What is wrong with one path within the element, or nothing when it holds. */
function faultOf(element: Type, path: string, want: Type | undefined): string | undefined {
  const read = typeAt(element, path.split('.'));
  if (typeof read === 'string')
    return path.includes('.')
      ? `'${path}' is not a path within ${show(element)}: ${read}`
      : `'${path}' is not a field of ${show(element)}`;
  if (read.optional) return `'${path}' passes through a field of ${show(element)} that may be missing`;
  if (want && assignable(read.type, want)) return `'${path}' is ${show(read.type)}, not ${show(want)}`;
  return undefined;
}

/** The dotted paths within a type, required at every step, whose value is of the wanted type (any, without one). */
function reaching(type: Type, want: Type | undefined, prefix: string, depth: number): string[] {
  if (type.kind !== 'object' || depth >= DEPTH) return [];
  return Object.entries(type.fields)
    .filter(([, field]) => field.required)
    .flatMap(([name, field]) => {
      const path = `${prefix}${name}`;
      const here = !want || !assignable(field.type, want) ? [path] : [];
      return [...here, ...reaching(field.type, want, `${path}.`, depth + 1)];
    });
}
