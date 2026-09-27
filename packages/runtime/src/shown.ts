/**
 * What a run a trigger starts shows of the roots it starts from: its operation's run, and each policy's decision
 * before it. The context with every field the kind's context marks secret as the marker -- an open map such as a
 * queue message's headers is marked whole -- and the input built from it with the same fields where what fills it
 * (`fire.in`, or a policy's `decide.in`) reads them, and those the input's own type marks. The run is handed the
 * values; only its reports read these.
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

/** What a run a trigger starts is started from: the context, the input, the input's type, and what filled the input. */
export interface RunRoots {
  context: Record<string, unknown>;
  input: unknown;
  inType: Type | undefined;
  /** What the input was filled from where it is not the trigger's own: a policy's `decide.in`. Absent: `fire.in`, or the body. */
  filledBy?: Record<string, unknown>;
}

/** The context and the input as the reports of a run the trigger starts show them. */
export function shownRoots(scope: Scope, trigger: TriggerDoc, roots: RunRoots): { context: unknown; in?: unknown } {
  const kind = scope.get('trigger-kind', trigger.kind);
  const marked = kind ? secretPaths(scope.contextType(kind.doc, trigger.settings)) : [];
  const context = redactValue(roots.context, marked);
  if (roots.input === undefined) return { context };
  const given = roots.filledBy ?? trigger.fire.in;
  const read = given === undefined ? below(marked, ['body'], []) : readInto(given, marked);
  return { context, in: redactValue(roots.input, [...secretPaths(roots.inType), ...read]) };
}

/** The paths of the input `fire.in` fills from a marked field of the context, one input at a time. */
function readInto(given: Record<string, unknown>, marked: string[][]): string[][] {
  return Object.entries(given).flatMap(([name, value]) => {
    const whole = typeof value === 'string' ? WHOLE_TEMPLATE.exec(value) : null;
    const read = whole ? contextPath(whole[1]) : undefined;
    if (read) return below(marked, read, [name]);
    // a read inside text, a list or an object: the input is shown as the marker whole where any read is marked
    return readsIn(value).some(path => below(marked, path, []).length) ? [[name]] : [];
  });
}

/** The marked paths under a read of the context, moved to where the read lands: a mark above the read covers it whole, a mark below it lands below. */
function below(marked: string[][], read: string[], at: string[]): string[][] {
  return marked.flatMap(path => {
    const shared = Math.min(path.length, read.length);
    if (path.slice(0, shared).some((segment, index) => segment !== read[index])) return [];
    return [[...at, ...path.slice(read.length)]];
  });
}

/** Every read of the context inside a value of `fire.in`, however deep it sits in text, lists and objects. */
function readsIn(value: unknown): string[][] {
  if (typeof value === 'string')
    return [...value.matchAll(TEMPLATE)]
      .map(match => contextPath(match[1]))
      .filter((path): path is string[] => path !== undefined);
  if (Array.isArray(value)) return value.flatMap(readsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(readsIn);
  return [];
}

/** The segments a template reads below `context`, or nothing where it reads another root. */
function contextPath(template: string): string[] | undefined {
  const [root, ...path] = splitPath(template);
  return root === 'context' ? path : undefined;
}
