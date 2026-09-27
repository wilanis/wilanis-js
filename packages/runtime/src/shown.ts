/**
 * What a run a trigger starts shows of the roots it starts from: its operation's run, and each policy's decision
 * before it. The context with every field the kind's context marks secret as the marker -- an open map such as a
 * queue message's headers is marked whole -- and the input built from it with the same fields where what fills it
 * (`fire.in`, or a policy's `decide.in`) reads them, and those the input's own type marks. A startup step's run
 * is started from its `in` alone, every field filled from a secret shown as the marker. The run is handed the
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
  const read = given === undefined ? below(marked, ['body'], []) : readInto(given, marked, 'context');
  return { context, in: redactValue(roots.input, [...secretPaths(roots.inType), ...read]) };
}

/**
 * The input a startup step's run starts from as its reports show it: every field its `in` fills from a
 * `{{secrets.*}}` read, whole or inside text, a list or an object, is the marker, whatever the operation marks.
 */
export function shownStep(written: Record<string, unknown>, input: Record<string, unknown>): { in: unknown } {
  return { in: redactValue(input, readInto(written, [[]], 'secrets')) };
}

/** The paths of the input `fire.in` fills from a marked field of the root it reads, one input at a time. */
function readInto(given: Record<string, unknown>, marked: string[][], root: string): string[][] {
  return Object.entries(given).flatMap(([name, value]) => {
    const whole = typeof value === 'string' ? WHOLE_TEMPLATE.exec(value) : null;
    const read = whole ? pathBelow(whole[1], root) : undefined;
    if (read) return below(marked, read, [name]);
    // a read inside text, a list or an object: the input is shown as the marker whole where any read is marked
    return readsIn(value, root).some(path => below(marked, path, []).length) ? [[name]] : [];
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

/** Every read of the root inside a value of `fire.in`, however deep it sits in text, lists and objects. */
function readsIn(value: unknown, root: string): string[][] {
  if (typeof value === 'string')
    return [...value.matchAll(TEMPLATE)]
      .map(match => pathBelow(match[1], root))
      .filter((path): path is string[] => path !== undefined);
  if (Array.isArray(value)) return value.flatMap(part => readsIn(part, root));
  if (value && typeof value === 'object') return Object.values(value).flatMap(part => readsIn(part, root));
  return [];
}

/** The segments a template reads below `root`, or nothing where it reads another root. */
function pathBelow(template: string, root: string): string[] | undefined {
  const [read, ...path] = splitPath(template);
  return read === root ? path : undefined;
}
