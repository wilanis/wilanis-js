/**
 * `wilanis ls` and `wilanis describe`: what one tree holds and what one document says, each answered as lines one
 * terminal prints. How the tree hangs together is `wilanis map`, in `map.ts` beside this.
 */
import type { LoadResult } from '@wilanis/core';
import {
  type ConnectionKindDoc,
  type Kind,
  type Loaded,
  type PolicyDoc,
  policyPath,
  Scope,
  splitRef,
  type TriggerDoc,
  type TriggerKindDoc,
} from '@wilanis/core';
import { deliveryKindLines, receivingLines } from './delivery-said.js';
import { bindingLines, codecLines, connectionLines, featureLines, projectLines, resolversLines } from './doc-said.js';
import { graphLines } from './graph-said.js';
import { holdsLines, invariantLines } from './invariant-lines.js';
import { LIMIT_SETTINGS, limitLines } from './limits-said.js';
import { fieldLine, portLines, shower, storeLines } from './lines.js';
import { triggersGatedBy } from './policy-gates.js';
import { permittedLines } from './profiles-said.js';
import { requiredByLines, requiresLines } from './required-said.js';
import { answersLines, scenarioLines, triggerScenarioLines, writtenMark } from './scenario-said.js';
import { viewsOfTrigger } from './scope-said.js';
import { shapeLines } from './shape-said.js';

// ---- discovery --------------------------------------------------------------------------------------

/**
 * Every document one tree holds, one line each, sorted by kind then path, saying which are not the tree's own and
 * which scenarios a command wrote.
 */
export function ls(load: LoadResult, kind?: Kind): string[] {
  return load.registry.files
    .filter(file => !kind || file.kind === kind)
    .sort((one, other) => one.kind.localeCompare(other.kind) || one.path.localeCompare(other.path))
    .map(file => `${file.kind.padEnd(16)} ${file.path}${whereFrom(file)}${writtenMark(file)}`);
}

/** Where one document came from, when it is not the tree's own. */
function whereFrom(file: { native?: string; requiredBy?: string; included?: string }): string {
  if (file.native) return '  (native)';
  if (file.requiredBy) return `  (required by ${file.requiredBy})`;
  return file.included ? `  (included from ${file.included})` : '';
}

/** A trigger kind, one connection kind or one plugin: its settings, the context it hands, and its guard. */
function kindLines(doc: Loaded, showType: (spec: unknown) => string): string[] {
  const lines: string[] = [];
  const declared = doc.doc as TriggerKindDoc;
  if (declared.settings) {
    lines.push('settings:');
    for (const [name, field] of Object.entries(declared.settings.fields)) lines.push(fieldLine(name, field, showType));
  }
  if ('context' in declared) {
    lines.push('context:');
    for (const [name, field] of Object.entries(declared.context.fields)) lines.push(fieldLine(name, field, showType));
  }
  if (declared.refusals)
    lines.push(
      `refusals: settings.${declared.refusals} maps each reason one trigger can reach to how it is answered (T005, T006)`,
    );
  if (declared.correlation)
    lines.push(
      `correlation: context.${declared.correlation} correlates a run with the caller's trace, copied opaquely (T007)`,
    );
  if ('grants' in (declared as unknown as { grants?: unknown }))
    lines.push(`grants: ${JSON.stringify((declared as unknown as { grants: unknown }).grants)}`);
  lines.push(...guardLines(declared, showType));
  return lines;
}

/** What one guard declares: the context it adds, the reasons it refuses with, and the credentials it takes. */
function guardLines(declared: TriggerKindDoc, showType: (spec: unknown) => string): string[] {
  const guard = (
    declared as unknown as {
      guard?: {
        context: { fields: Record<string, { type: unknown; required?: boolean; description?: string }> };
        refuses?: Record<string, string>;
        credentials?: Record<string, { type: unknown; yields: string[]; description?: string }>;
      };
    }
  ).guard;
  if (!guard) return [];
  const lines = ['guard: identifies callers before any policy runs', '  adds to context:'];
  for (const [name, field] of Object.entries(guard.context.fields)) lines.push(fieldLine(name, field, showType));
  for (const [reason, why] of Object.entries(guard.refuses ?? {})) lines.push(`  refuses '${reason}': ${why}`);
  lines.push('  takes, where one trigger attaches one policy ("in"):');
  for (const [name, credential] of Object.entries(guard.credentials ?? {}))
    lines.push(
      `    ${name}: ${typeof credential.type === 'string' ? credential.type : showType(credential.type)}  yields context.${credential.yields.join(', context.')}${credential.description ? `  -- ${credential.description}` : ''}`,
    );
  return lines;
}
/** A policy: what decides it, what it can answer, and the triggers it gates. */
function policyLines(doc: Loaded, scope: Scope): string[] {
  const lines: string[] = [];
  const declared = doc.doc as PolicyDoc;
  lines.push(`decides through  ${declared.decide.run}`);
  for (const [name, read] of Object.entries(declared.decide.in ?? {}))
    lines.push(`    ${name} ← ${typeof read === 'string' ? read : JSON.stringify(read)}`);
  lines.push('outcomes (allow is the decision answering):');
  for (const [reason, outcome] of Object.entries(declared.outcomes))
    lines.push(
      `    ${reason} → ${outcome.effect}${outcome.method ? ` (${outcome.method})` : ''}${outcome.description ? `  -- ${outcome.description}` : ''}`,
    );
  const gated = triggersGatedBy(scope, doc.path);
  lines.push(
    gated.length
      ? `gates: ${gated.map(trigger => trigger.path).join(', ')}`
      : "gates: nothing yet -- name it under one trigger's policies",
  );
  return lines;
}

/**
 * A trigger: the document, the bounds its run ends up with and where each came from, the connection it receives
 * from and who sends to it there, the policies it attaches, what each gives the guard, the scenarios that replay it,
 * and the invariants that hold over it -- a rule stated once elsewhere is a rule about this trigger, and a reader of
 * the trigger sees it.
 */
function triggerLines(doc: Loaded, scope: Scope): string[] {
  const declared = doc.doc as TriggerDoc;
  return [
    `kind  ${declared.kind}`,
    ...settingLines(declared.settings),
    ...faultLines(declared, scope),
    ...limitLines(doc as Loaded<TriggerDoc>, scope),
    ...receivingLines(doc as Loaded<TriggerDoc>, scope),
    ...crossesLines(declared),
    ...fireLines(declared, scope),
    ...gatedLines(declared, scope),
    ...triggerScenarioLines(doc, scope),
    ...viewLines(doc as Loaded<TriggerDoc>, scope),
    ...holdsLines(doc as Loaded<TriggerDoc>, scope),
  ];
}

/**
 * What a trigger's refusal table leaves out (RFC 0014): a node that breaks where no switch catches it gives no
 * reason to map. The viewer's trigger page closes its table with the same sentence.
 */
export const UNCAUGHT_FAULT =
  "Anything that breaks and no switch catches is a fault: answered the kind's one way, never mapped.";

/** The line closing the refusal table, which the settings print, where the trigger's kind maps refusals at all. */
function faultLines(declared: TriggerDoc, scope: Scope): string[] {
  return scope.get('trigger-kind', declared.kind)?.doc.refusals ? [UNCAUGHT_FAULT] : [];
}

/**
 * The views this trigger reaches, after its policies: a view is the one way across a scope, so a reader of
 * the trigger is told which crossings it makes and whether each carries the policy the store put it behind.
 * A trigger that attaches none is not refused here -- A008 has already done that -- but is said to a reader
 * who has the trigger open rather than the store.
 */
function viewLines(trigger: Loaded<TriggerDoc>, scope: Scope): string[] {
  return viewsOfTrigger(trigger, scope).map(view => {
    const says = view.attached ? 'attached' : 'not attached -- wilanis check refuses this (A008)';
    return `reaches ${view.collection} (a view) behind ${view.behind}: ${says}`;
  });
}

/** What crosses the edge at this trigger: the shape it takes from the caller, and the one it answers in. */
function crossesLines(declared: TriggerDoc): string[] {
  return [...(declared.in ? [`takes   ${declared.in}`] : []), ...(declared.out ? [`answers ${declared.out}`] : [])];
}

/** The domain operation this trigger fires, where each of its inputs is read from, and who hands what they read. */
function fireLines(declared: TriggerDoc, scope: Scope): string[] {
  const reads = Object.entries(declared.fire.in ?? {});
  return [
    `fires   ${declared.fire.run}`,
    ...reads.map(([name, read]) => `    ${name} ← ${typeof read === 'string' ? read : JSON.stringify(read)}`),
    ...handedLines(declared.kind, reads, '    ', scope),
  ];
}

/** The policies gating this trigger, in order, the credentials each attachment gives the guard, and who hands them. */
function gatedLines(declared: TriggerDoc, scope: Scope): string[] {
  if (!declared.policies?.length) return [];
  const given = declared.policies.flatMap(use => Object.entries((typeof use === 'string' ? undefined : use.in) ?? {}));
  return [
    `policies, in order: ${declared.policies.map(policyPath).join(', ')}`,
    ...given.map(([name, read]) => `  gives the guard '${name}' read from ${JSON.stringify(read)}`),
    ...handedLines(declared.kind, given, '  ', scope),
  ];
}

/**
 * The kind that hands the context the reads above read, said once where any of them is rooted at it (RFC 0034):
 * `{{context.params.id}}` is `context.fields.params` in that kind, and a reader of the trigger is told where to look.
 */
function handedLines(kind: string, reads: [string, unknown][], indent: string, scope: Scope): string[] {
  const readsContext = reads.some(([, read]) => scope.templateReads(read).some(([root]) => root === 'context'));
  return readsContext ? [`${indent}context is what ${kind} hands  → wilanis describe ${kind}`] : [];
}

/** Whether a setting's value has parts of its own worth their own lines, rather than fitting on one. */
const nested = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * What a trigger's kind is configured with, a setting to a line, and a setting with parts of its own opened
 * one level -- which is where a reader looks for the status a kind answers with and the refusals it maps. A
 * bound is said on its own line below, with where it came from, so it is not said here as well.
 */
function settingLines(settings: Record<string, unknown> | undefined): string[] {
  const bounds: readonly string[] = LIMIT_SETTINGS;
  const entries = Object.entries(settings ?? {}).filter(
    ([name, value]) => !(bounds.includes(name) && typeof value === 'number'),
  );
  if (!entries.length) return [];
  const lines = ['settings:'];
  for (const [name, value] of entries) {
    if (!nested(value)) lines.push(`    ${name}: ${JSON.stringify(value)}`);
    else {
      lines.push(`    ${name}:`);
      for (const [part, held] of Object.entries(value)) lines.push(`        ${part}: ${JSON.stringify(held)}`);
    }
  }
  return lines;
}

/**
 * The lines one document's kind adds, beyond what every kind says. Every kind has a body: none falls back to
 * the raw JSON, since a reader who wanted the file has its path on the line above and what they asked
 * `describe` for is what the document means.
 */
function kindBody(doc: Loaded, load: LoadResult, scope: Scope, showType: (spec: unknown) => string): string[] {
  if (doc.kind === 'port') return portLines(doc, showType);
  if (doc.kind === 'plugin') return [...kindLines(doc, showType), ...requiresLines(doc, scope)];
  if (doc.kind === 'trigger-kind') return kindLines(doc, showType);
  if (doc.kind === 'connection-kind')
    return [...deliveryKindLines(doc), ...kindLines(doc, showType), ...capabilityLines(doc.doc as ConnectionKindDoc)];
  if (doc.kind === 'shape') return shapeLines(doc, scope, load, showType);
  if (doc.kind === 'store') return storeLines(doc, load, scope);
  if (doc.kind === 'policy') return policyLines(doc, scope);
  if (doc.kind === 'trigger') return triggerLines(doc, scope);
  if (doc.kind === 'invariant') return invariantLines(doc, scope);
  if (doc.kind === 'graph') return graphLines(doc, scope);
  return plainBody(doc, load, scope);
}

/** The kinds whose body is the document read back in words: each says what it means, none prints its JSON. */
function plainBody(doc: Loaded, load: LoadResult, scope: Scope): string[] {
  if (doc.kind === 'binding') return bindingLines(doc, scope);
  if (doc.kind === 'resolvers') return resolversLines(doc, load);
  if (doc.kind === 'feature') return featureLines(doc);
  if (doc.kind === 'connection') return connectionLines(doc, scope, capabilityLines(kindOf(doc, scope)));
  if (doc.kind === 'codec') return codecLines(doc);
  if (doc.kind === 'scenario') return scenarioLines(doc, scope);
  if (doc.kind === 'answers') return answersLines(doc);
  if (doc.kind === 'project') return projectLines(doc, scope);
  return [];
}

/**
 * What the engine behind one storage kind can do (RFC 0022), read off the `capabilities` block of the loaded kind
 * document and never off a plugin's export: the runtime sees a plugin through `PluginModule` alone.
 */
export function describeCapabilities(kind: ConnectionKindDoc): string | undefined {
  const held = kind.capabilities;
  if (!held) return undefined;
  const said = (fact: boolean) => (fact ? 'yes' : 'no');
  const unique = held.unique.length ? held.unique.join(', ') : 'none';
  return `transactional DDL: ${said(held.transactionalDdl)}; unique over: ${unique}; refs: ${said(held.refs)}`;
}

/** The capabilities line of one connection kind, where its kind is a storage kind that states them. */
function capabilityLines(kind: ConnectionKindDoc | undefined): string[] {
  const said = kind && describeCapabilities(kind);
  return said ? [`capabilities  ${said}`] : [];
}

/** The kind document one connection names, when the tree loaded it. */
function kindOf(doc: Loaded, scope: Scope): ConnectionKindDoc | undefined {
  return scope.get('connection-kind', (doc.doc as { kind: string }).kind)?.doc;
}

/** Who granted one document: the plugin that ships it, or the tree it was included from. */
function grantLine(doc: { native?: string; included?: string }, from: string | undefined): string[] {
  if (doc.native) return [`granted by  ${doc.native}${from ? `  (${from})` : '  (built into the runtime)'}`];
  return doc.included ? [`included from  ${doc.included}`] : [];
}

/** The document a path names, the part after any `#` set aside; nothing where it names none. */
function documentAt(scope: Scope, load: LoadResult, ref: string) {
  const { path } = splitRef(ref.includes('#') ? ref : `${ref}#`);
  // the project is `@project.json` in the registry and `project.json` on disk and in every sentence about it
  return scope.any(path || ref) ?? (ref === 'project.json' ? load.registry.project : undefined);
}

/** Whether a path names a document `describe` can say, so the command line can exit 1 where it names none. */
export function describes(load: LoadResult, ref: string): boolean {
  return documentAt(new Scope(load.registry, load.resolve), load, ref) !== undefined;
}

/**
 * One document said in full: where it lives, who granted it and, for a native port, which profiles permit it
 * (RFC 0016), what it describes, and what its kind adds.
 */
export function describe(load: LoadResult, ref: string): string {
  const scope = new Scope(load.registry, load.resolve);
  const doc = documentAt(scope, load, ref);
  if (!doc) return `no document at '${ref}'`;
  // one native or required document is one plugin's: say which, and the package it came from, so who implements it is not one code detail
  const owner = doc.native ?? doc.requiredBy;
  const from = owner ? scope.project?.plugins.find(plugin => plugin.use === owner)?.from : undefined;
  const grantedBy = doc.requiredBy ? requiredByLines(doc, from, scope) : grantLine(doc, from);
  const lines = [
    `${doc.kind}  ${doc.path}`,
    ...(doc.file ? [`file  ${doc.file}`] : []),
    ...grantedBy,
    ...(doc.kind === 'port' ? permittedLines(scope, doc) : []),
    doc.doc.description,
    '',
  ];
  const showType = shower(scope);
  lines.push(...kindBody(doc, load, scope, showType));
  return lines.join('\n');
}
