/**
 * What `wilanis describe` says about the kinds that carry no body of their own: a binding, a resolvers
 * document, a feature, a connection, a codec, a scenario and the project. Each used to print
 * `JSON.stringify(doc.doc)` and leave a reader to parse the document they had just asked about in words.
 *
 * The viewer never shows raw JSON by default and the CLI should not either: a reader who wanted the file can
 * open the file, whose path is on the second line of every `describe`. What they asked `describe` for is what
 * the document means. Each body here says that in the voice the port, policy and shape bodies already use --
 * a fact shared by every row said once above them, and a list of paths on one line.
 */
import type {
  BindingDoc,
  CodecDoc,
  ConnectionDoc,
  FeatureDoc,
  Loaded,
  LoadResult,
  ProjectDoc,
  ResolversDoc,
  ScenarioDoc,
  Scope,
} from '@wilanis/core';
import { attemptsSaid } from './attempts-said.js';
import { profilesLines, standInLines } from './profiles-said.js';
import { type Reader, readersOf, readsLines } from './reads-said.js';

/** One list of paths on one line, as `gates:` says a policy's triggers; nothing where the list is empty. */
const listLine = (label: string, values: string[] | undefined): string[] =>
  values?.length ? [`${label}  ${values.join(', ')}`] : [];

/**
 * A binding: the port it meets, the reads its operations take from the request, and how each is answered --
 * by a graph, or by delegating to another operation, and how often and how long it is tried. The port is said once above, since every row shares it,
 * and the reads stand above the operations, since a delegation's `{{name}}` is one of them.
 */
export function bindingLines(doc: Loaded, scope: Reader): string[] {
  const declared = doc.doc as BindingDoc;
  const lines = [`meets  ${declared.port}`, ...readsLines(declared.reads, scope)];
  lines.push('answers:');
  for (const [name, op] of Object.entries(declared.operations))
    lines.push(`    #${name}  ${answeredBy(op)}${attemptsSaid(op)}${op.description ? `  -- ${op.description}` : ''}`);
  return lines;
}

/** How one bound operation is answered: by a graph of its own, or by delegating to another operation. */
function answeredBy(op: { graph?: string; run?: string }): string {
  if (op.graph) return `graph ${op.graph}`;
  return op.run ? `→ ${op.run}` : '?? neither a graph nor a run';
}

/**
 * A resolvers document: each named read, what it runs, whether a binding must give it, and who reads it. A
 * resolver is a read and never an operation, so the line says what it reads rather than what it does; and
 * since `reads` binds one resolver at a time under a name of the reader's choosing, this document is the one
 * place both ends of that binding can be seen at once -- a reader here is told where each read is used and
 * under which local name, rather than opening every data graph to find out.
 */
export function resolversLines(doc: Loaded, load: LoadResult): string[] {
  const declared = doc.doc as ResolversDoc;
  const readers = readersOf(doc.path, load);
  const lines = ['reads, each bound under a binding\u2019s or a data graph\u2019s reads as @path#name:'];
  for (const [name, read] of Object.entries(declared.resolvers)) {
    const must = read.required ? '  (required: every trigger reaching it must prove it, A006)' : '';
    lines.push(`    ${name}  ← ${read.read}${must}${read.description ? `  -- ${read.description}` : ''}`);
    lines.push(...usedLines(readers(name)));
  }
  return lines;
}

/** Who binds one resolver, a line each; one nothing binds says so, since a read declared and unbound is worth seeing. */
const usedLines = (used: string[]): string[] =>
  used.length
    ? used.map(one => `        ${one}`)
    : ['        used by nothing yet -- bind it under a data graph’s or a binding’s reads'];

/** A feature: the features it may name, what it lets others name, and the effects its graphs may run. */
export function featureLines(doc: Loaded): string[] {
  const declared = doc.doc as FeatureDoc;
  const lines = [
    ...listLine('depends on ', declared.dependsOn),
    ...listLine('exports    ', declared.exports),
    ...listLine('effects    ', declared.effects),
  ];
  return lines.length ? lines : ['names no other feature, exports nothing, and allows no effect'];
}

/**
 * A connection: the kind that gives it meaning, the settings it is configured with, and, where a profile names
 * it under `connections`, what it stands in for or what replaces it there -- a reader of the connection a data
 * graph names learns it is not what every profile reaches.
 */
export function connectionLines(doc: Loaded, scope: Scope): string[] {
  const declared = doc.doc as ConnectionDoc;
  const lines = [`kind  ${declared.kind}`];
  const settings = Object.entries(declared.settings ?? {});
  if (settings.length) lines.push('settings:');
  for (const [name, value] of settings) lines.push(`    ${name}: ${JSON.stringify(value)}`);
  return [...lines, ...standInLines(scope, doc.path)];
}

/** A codec: what it yields, which is either the type a call declares or one type it always answers in. */
export function codecLines(doc: Loaded): string[] {
  const { yields } = doc.doc as CodecDoc;
  const said = yields === 'declared' ? "the type its call site declares ('declared')" : JSON.stringify(yields);
  return [`yields  ${said}`];
}

/** A scenario: the trigger it drives, the seed it runs under, and what it expects back. */
export function scenarioLines(doc: Loaded): string[] {
  const declared = doc.doc as ScenarioDoc;
  const lines = [`drives  ${declared.trigger}`, `seed    ${declared.seed}`];
  if (declared.in !== undefined) lines.push(`in      ${JSON.stringify(declared.in)}`);
  if (declared.stubs) lines.push(...listLine('stubs  ', Object.keys(declared.stubs)));
  lines.push('expects:');
  for (const [name, value] of Object.entries(declared.expect)) lines.push(`    ${name}: ${JSON.stringify(value)}`);
  return lines;
}

/** The plugins a project loads, each with the package it came from and whether it is configured. */
function pluginLines(declared: ProjectDoc): string[] {
  if (!declared.plugins?.length) return [];
  return [
    'plugins:',
    ...declared.plugins.map(one => {
      const from = one.from ? `  (${one.from})` : '  (built into the runtime)';
      return `    ${one.use}${from}${one.settings ? '  configured' : ''}`;
    }),
  ];
}

/** The trees a project includes, each with the features it takes from them. */
function includeLines(declared: ProjectDoc): string[] {
  if (!declared.includes?.length) return [];
  return [
    'includes:',
    ...declared.includes.map(one => `    ${one.from}${one.features?.length ? `  (${one.features.join(', ')})` : ''}`),
  ];
}

/**
 * What the tree starts, in the order it starts them: everything a tree starts is declared here and nowhere
 * else, so a reader of the project document is told what `wilanis start` will run before it runs anything.
 * A step that is not required lets serving proceed when it refuses, which is the difference worth saying.
 */
function startupLines(declared: ProjectDoc): string[] {
  if (!declared.startup?.length) return ['starts  nothing -- a tree that names no startup step serves nothing'];
  return [
    'starts, in order:',
    ...declared.startup.map(step => {
      const must = step.required ? '  (required: serving stops if it refuses)' : '  (serving proceeds if it refuses)';
      const only = step.profiles ? `  (under ${step.profiles.join(', ')} only)` : '';
      return `    ${step.run}${must}${only}${step.label ? `  -- ${step.label}` : ''}`;
    }),
  ];
}

/**
 * The project: what it is called, what it loads, what it includes, the aliases it gives every reference, what
 * it starts, and a block per profile saying what the tree binds, stands in, reaches, holds, starts and needs
 * there (RFC 0013). The last two are what the document is chiefly for -- nothing a tree starts is decided by
 * the runtime -- so neither may be left for a reader to open the file, or run the tree, to find.
 */
export function projectLines(doc: Loaded, scope: Scope): string[] {
  const declared = doc.doc as ProjectDoc;
  const aliases = Object.entries(declared.aliases ?? {}).map(([name, target]) => `${name} → ${target}`);
  return [
    `name  ${declared.name}`,
    ...pluginLines(declared),
    ...includeLines(declared),
    ...listLine('aliases  ', aliases),
    ...listLine('secrets  ', Object.keys(declared.secrets ?? {})),
    ...startupLines(declared),
    ...profilesLines(scope),
  ];
}
