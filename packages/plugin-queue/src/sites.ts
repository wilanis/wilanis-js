/**
 * Where a tree names this plugin's words, gathered once so a rule over one reads what a rule over all of them
 * does: every queue trigger with its settings, every call of `publish` -- a graph's node or a binding's
 * delegation -- with what it was given, and every startup step that names `consume`.
 */
import {
  isMap,
  isRun,
  type PluginCheckContext,
  type StartupStep,
  type TriggerDoc,
  type Type,
  type Values,
} from '@wilanis/core';
import { CONSUME, KIND, PUBLISH } from './paths.js';

type Scope = PluginCheckContext['scope'];

/** One queue trigger, as a rule reads it: where it is written and what its settings say. */
export interface Queued {
  file: string;
  settings: Record<string, unknown>;
  doc: TriggerDoc;
}

/** One call of publish: the document it is written in, where in it, and what it was given. */
export interface Published {
  file: string;
  at: string;
  given: Values;
}

/** Every queue trigger of the tree, by the path each is written at. */
export function queued(scope: Scope): Queued[] {
  const kind = scope.canon(KIND);
  return scope.registry
    .all('trigger')
    .filter(trigger => scope.canon(trigger.doc.kind) === kind)
    .map(trigger => ({ file: trigger.path, settings: trigger.doc.settings ?? {}, doc: trigger.doc }));
}

/** The operation a run names, canonical, so it is compared against the one this plugin ships. */
function canonical(run: string | undefined, scope: Scope): string {
  const [port, operation] = String(run).split('#');
  return `${scope.canon(port ?? '')}#${operation ?? ''}`;
}

/** Every graph node that runs publish, itself or once per element. */
function graphCalls(scope: Scope): Published[] {
  return scope.registry
    .all('graph')
    .flatMap(graph =>
      graph.doc.nodes
        .filter(node => (isRun(node) || isMap(node)) && canonical(node.run, scope) === PUBLISH)
        .map(node => ({ file: graph.path, at: `nodes/${node.id}/in`, given: (node as { in?: Values }).in ?? {} })),
    );
}

/** Every binding operation that delegates to publish. */
function bindingCalls(scope: Scope): Published[] {
  return scope.registry.all('binding').flatMap(binding =>
    Object.entries(binding.doc.operations)
      .filter(([, operation]) => canonical(operation.run, scope) === PUBLISH)
      .map(([name, operation]) => ({ file: binding.path, at: `operations/${name}/in`, given: operation.in ?? {} })),
  );
}

/** Every call of publish: each graph node that runs it, and each binding operation that delegates to it. */
export function published(scope: Scope): Published[] {
  return [...graphCalls(scope), ...bindingCalls(scope)];
}

/** The startup steps that name consume, with the index each sits at, so a refusal points at the step itself. */
export function consumeSteps(scope: Scope): { step: StartupStep; index: number }[] {
  return (scope.project?.startup ?? [])
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => canonical(step.run, scope) === CONSUME);
}

/** The type a written reference names, or nothing where it names none -- R001 or T001 says so where it is judged. */
export function typeOf(scope: Scope, ref: unknown): Type | undefined {
  if (typeof ref !== 'string') return undefined;
  try {
    return scope.types.ref(ref);
  } catch {
    return undefined;
  }
}
