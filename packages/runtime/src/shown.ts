/**
 * What a trigger's run shows of the roots it starts from. The request with every field the kind's context marks
 * secret as the marker -- an open map such as a queue message's headers is marked whole -- and the input built
 * from it with the same fields where `fire.in` reads them, and those the trigger's own `in` marks. The run is handed
 * the values; only its reports read these.
 */
import {
  type Scope,
  secretPaths,
  splitPath,
  TEMPLATE,
  type TriggerDoc,
  type Type,
  WHOLE_TEMPLATE,
} from '@wilanis/core';
import { redactValue } from '@wilanis/engine';

/** The request and the input as a trigger's reports show them. */
export function shownRoots(
  scope: Scope,
  trigger: TriggerDoc,
  roots: { request: Record<string, unknown>; input: unknown; inType: Type | undefined },
): { request: unknown; in?: unknown } {
  const kind = scope.get('trigger-kind', trigger.kind);
  const marked = kind ? secretPaths(scope.contextType(kind.doc, trigger.settings)) : [];
  const request = redactValue(roots.request, marked);
  if (roots.input === undefined) return { request };
  const read = trigger.fire.in === undefined ? below(marked, ['body'], []) : readInto(trigger.fire.in, marked);
  return { request, in: redactValue(roots.input, [...secretPaths(roots.inType), ...read]) };
}

/** The paths of the input `fire.in` fills from a marked field of the request, one input at a time. */
function readInto(given: Record<string, unknown>, marked: string[][]): string[][] {
  return Object.entries(given).flatMap(([name, value]) => {
    const whole = typeof value === 'string' ? WHOLE_TEMPLATE.exec(value) : null;
    const read = whole ? requestPath(whole[1]) : undefined;
    if (read) return below(marked, read, [name]);
    // a read inside text, a list or an object: the input is shown as the marker whole where any read is marked
    return readsIn(value).some(path => below(marked, path, []).length) ? [[name]] : [];
  });
}

/** The marked paths under a read of the request, moved to where the read lands: a mark above the read covers it whole, a mark below it lands below. */
function below(marked: string[][], read: string[], at: string[]): string[][] {
  return marked.flatMap(path => {
    const shared = Math.min(path.length, read.length);
    if (path.slice(0, shared).some((segment, index) => segment !== read[index])) return [];
    return [[...at, ...path.slice(read.length)]];
  });
}

/** Every read of the request inside a value of `fire.in`, however deep it sits in text, lists and objects. */
function readsIn(value: unknown): string[][] {
  if (typeof value === 'string')
    return [...value.matchAll(TEMPLATE)]
      .map(match => requestPath(match[1]))
      .filter((path): path is string[] => path !== undefined);
  if (Array.isArray(value)) return value.flatMap(readsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(readsIn);
  return [];
}

/** The segments a template reads below `request`, or nothing where it reads another root. */
function requestPath(template: string): string[] | undefined {
  const [root, ...path] = splitPath(template);
  return root === 'request' ? path : undefined;
}
