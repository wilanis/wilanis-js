/**
 * `wilanis ls` and `wilanis describe`: what one tree holds and what one document says, each answered as lines one
 * terminal prints. How the tree hangs together is `wilanis map`, in `map.ts` beside this.
 */
import type { LoadResult } from '@wilanis/core';
import {
  type Kind,
  type Loaded,
  type PolicyDoc,
  policyPath,
  Scope,
  splitRef,
  type TriggerDoc,
  type TriggerKindDoc,
} from '@wilanis/core';
import {
  bindingLines,
  codecLines,
  connectionLines,
  featureLines,
  projectLines,
  resolversLines,
  scenarioLines,
} from './doc-said.js';
import { graphLines } from './graph-said.js';
import { holdsLines, invariantLines } from './invariant-lines.js';
import { LIMIT_SETTINGS, limitLines } from './limits-said.js';
import { fieldLine, portLines, shower, storeLines } from './lines.js';
import { requiredByLines, requiresLines } from './required-said.js';
import { viewsOfTrigger } from './scope-said.js';
import { shapeLines } from './shape-said.js';

// ---- discovery --------------------------------------------------------------------------------------

/** Every document one tree holds, one line each, sorted by kind then path, and saying which are not the tree's own. */
export function ls(load: LoadResult, kind?: Kind): string[] {
  return load.registry.files
    .filter(file => !kind || file.kind === kind)
    .sort((one, other) => one.kind.localeCompare(other.kind) || one.path.localeCompare(other.path))
    .map(file => `${file.kind.padEnd(16)} ${file.path}${whereFrom(file)}`);
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
    lines.push('context (request.*):');
    for (const [name, field] of Object.entries(declared.context.fields)) lines.push(fieldLine(name, field, showType));
  }
  if (declared.refusals)
    lines.push(
      `refusals: settings.${declared.refusals} maps each reason one trigger can reach to how it is answered (T005, T006)`,
    );
  if (declared.correlation)
    lines.push(
      `correlation: request.${declared.correlation} correlates a run with the caller's trace, copied opaquely (T007)`,
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
  const lines = ['guard: identifies callers before any policy runs', '  adds to request.*:'];
  for (const [name, field] of Object.entries(guard.context.fields)) lines.push(fieldLine(name, field, showType));
  for (const [reason, why] of Object.entries(guard.refuses ?? {})) lines.push(`  refuses '${reason}': ${why}`);
  lines.push('  takes, where one trigger attaches one policy ("in"):');
  for (const [name, credential] of Object.entries(guard.credentials ?? {}))
    lines.push(
      `    ${name}: ${typeof credential.type === 'string' ? credential.type : showType(credential.type)}  yields request.${credential.yields.join(', request.')}${credential.description ? `  -- ${credential.description}` : ''}`,
    );
  return lines;
}
/** A policy: what decides it, what it can answer, and the triggers it gates. */
function policyLines(doc: Loaded, load: LoadResult): string[] {
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
  const gated = load.registry
    .all('trigger')
    .filter(trigger => (trigger.doc.policies ?? []).some(ref => load.resolve(policyPath(ref)) === doc.path));
  lines.push(
    gated.length
      ? `gates: ${gated.map(trigger => trigger.path).join(', ')}`
      : "gates: nothing yet -- name it under one trigger's policies",
  );
  return lines;
}

/**
 * A trigger: the document, the bounds its run ends up with and where each came from, the policies it attaches,
 * what each gives the guard, and the invariants that hold over it -- a rule stated once elsewhere is a rule about
 * this trigger, and a reader of the trigger sees it.
 */
function triggerLines(doc: Loaded, scope: Scope): string[] {
  const declared = doc.doc as TriggerDoc;
  return [
    `kind  ${declared.kind}`,
    ...settingLines(declared.settings),
    ...limitLines(doc as Loaded<TriggerDoc>, scope),
    ...crossesLines(declared),
    ...fireLines(declared),
    ...gatedLines(declared),
    ...viewLines(doc as Loaded<TriggerDoc>, scope),
    ...holdsLines(doc as Loaded<TriggerDoc>, scope),
  ];
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

/** The domain operation this trigger fires, and where each of its inputs is read from. */
function fireLines(declared: TriggerDoc): string[] {
  const reads = Object.entries(declared.fire.in ?? {});
  return [
    `fires   ${declared.fire.run}`,
    ...reads.map(([name, read]) => `    ${name} ← ${typeof read === 'string' ? read : JSON.stringify(read)}`),
  ];
}

/** The policies gating this trigger, in order, and the credentials each attachment gives the guard. */
function gatedLines(declared: TriggerDoc): string[] {
  if (!declared.policies?.length) return [];
  const lines = [`policies, in order: ${declared.policies.map(policyPath).join(', ')}`];
  for (const use of declared.policies)
    for (const [name, read] of Object.entries((typeof use === 'string' ? undefined : use.in) ?? {}))
      lines.push(`  gives the guard '${name}' read from ${JSON.stringify(read)}`);
  return lines;
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
  if (doc.kind === 'trigger-kind' || doc.kind === 'connection-kind') return kindLines(doc, showType);
  if (doc.kind === 'shape') return shapeLines(doc, scope, load, showType);
  if (doc.kind === 'store') return storeLines(doc, load, scope);
  if (doc.kind === 'policy') return policyLines(doc, load);
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
  if (doc.kind === 'connection') return connectionLines(doc);
  if (doc.kind === 'codec') return codecLines(doc);
  if (doc.kind === 'scenario') return scenarioLines(doc);
  if (doc.kind === 'project') return projectLines(doc);
  return [];
}

/** Who granted one document: the plugin that ships it, or the tree it was included from. */
function grantLine(doc: { native?: string; included?: string }, from: string | undefined): string[] {
  if (doc.native) return [`granted by  ${doc.native}${from ? `  (${from})` : '  (built into the runtime)'}`];
  return doc.included ? [`included from  ${doc.included}`] : [];
}

/** One document said in full: where it lives, who granted it, what it describes, and what its kind adds. */
export function describe(load: LoadResult, ref: string): string {
  const scope = new Scope(load.registry, load.resolve);
  const { path } = splitRef(ref.includes('#') ? ref : `${ref}#`);
  const doc = scope.any(path || ref);
  if (!doc) return `no document at '${ref}'`;
  // one native or required document is one plugin's: say which, and the package it came from, so who implements it is not one code detail
  const owner = doc.native ?? doc.requiredBy;
  const from = owner ? scope.project?.plugins.find(plugin => plugin.use === owner)?.from : undefined;
  const grantedBy = doc.requiredBy ? requiredByLines(doc, from, scope) : grantLine(doc, from);
  const lines = [
    `${doc.kind}  ${doc.path}`,
    ...(doc.file ? [`file  ${doc.file}`] : []),
    ...grantedBy,
    doc.doc.description,
    '',
  ];
  const showType = shower(scope);
  lines.push(...kindBody(doc, load, scope, showType));
  return lines.join('\n');
}
