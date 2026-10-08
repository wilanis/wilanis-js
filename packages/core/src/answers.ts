/**
 * How a recorded scenario's pointers are read (RFC 0036): a node answer or a stub value is written once in the answers
 * document of its directory, under the digest of its canonical JSON, and a scenario writes the digest in its place.
 * Every reader of `expect.nodes` and of a scenario's stubs goes through `nodesOf` and `stubsOf`, so no reader resolves
 * a pointer its own way.
 */
import { createHash } from 'node:crypto';
import { ANSWERS_FILE, answersHome } from './placement.js';
import type { AnswersDoc, ScenarioDoc, ScenarioNode } from './recorded.js';
import type { Loaded, Registry } from './registry.js';

/** One value as JSON, read inside an array: an absent value is `null` there, as `JSON.stringify` writes it. */
const inArray = (item: unknown) => canonicalJson(item === undefined ? null : item);

/**
 * A value's canonical JSON (RFC 8785), for the values a run records: no whitespace, and the keys of every object sorted
 * by UTF-16 code unit, which is the order JavaScript's default sort gives. A key whose value is absent is left out.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inArray).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** The digest a node answer or a stub value is shared under: the first 16 hex characters of SHA-256 of its canonical JSON. */
export function answerDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The answers document a scenario's pointers read: the one `answersAbove` finds, where the command that wrote the
 * scenario wrote it too. Nothing where no directory above holds one, or where the nearest one is another command's.
 */
export function answersFor(registry: Registry, scenarioPath: string): Loaded<AnswersDoc> | undefined {
  return answersAbove(registry, scenarioPath).own;
}

/**
 * The `answers.json` of the nearest directory above a scenario that holds one, strictly below `scenarios/` -- where
 * `answersHome` says an answers document belongs. It is `own` where it carries the scenario's `generated` mark, and
 * `other` where it carries another, or the scenario was written by hand: a file with another mark is not this
 * scenario's answers file. Neither where no such directory holds one.
 */
export function answersAbove(
  registry: Registry,
  scenarioPath: string,
): { own?: Loaded<AnswersDoc>; other?: Loaded<AnswersDoc> } {
  const nearest = nearestAnswers(registry, scenarioPath);
  if (!nearest) return {};
  const mark = registry.get('scenario', scenarioPath)?.doc.generated;
  return nearest.doc.generated === mark ? { own: nearest } : { other: nearest };
}

/** The answers document of the nearest directory above a path that holds one, below `scenarios/`, whatever its mark. */
function nearestAnswers(registry: Registry, scenarioPath: string): Loaded<AnswersDoc> | undefined {
  const dirs = scenarioPath.replace(/^@/, '').split('/').slice(0, -1);
  for (let depth = dirs.length; depth > 0; depth--) {
    const candidate = `${dirs.slice(0, depth).join('/')}/${ANSWERS_FILE}`;
    if (answersHome(candidate) !== candidate) return undefined;
    const found = registry.get('answers', `@${candidate}`);
    if (found) return found;
  }
  return undefined;
}

/** The value a map of an answers document holds under a digest, or nothing where it holds none. */
const heldUnder = <T>(map: Record<string, T> | undefined, digest: string): T | undefined =>
  map && Object.hasOwn(map, digest) ? map[digest] : undefined;

/**
 * What each node of a scenario did, by its dotted path: an answer written inline as it is, a digest replaced by the
 * answer the answers document holds under it. A digest it does not hold is left out of `nodes`, and its node's path
 * is listed in `unresolved`.
 */
export function nodesOf(
  scenario: ScenarioDoc,
  answers: AnswersDoc | undefined,
): { nodes: Record<string, ScenarioNode>; unresolved: string[] } {
  const nodes: Record<string, ScenarioNode> = {};
  const unresolved: string[] = [];
  for (const [path, node] of Object.entries(scenario.expect.nodes ?? {})) {
    const answer = typeof node === 'string' ? heldUnder(answers?.nodes, node) : node;
    if (answer) nodes[path] = answer;
    else unresolved.push(path);
  }
  return { nodes, unresolved };
}

/**
 * What each stubbed effect of a scenario answers, by its dotted path: `stubs` as written, and each path of
 * `sharedStubs` given the value the answers document holds under its digest. A digest it does not hold is left out
 * of `stubs`, and its path is listed in `unresolved`.
 */
export function stubsOf(
  scenario: ScenarioDoc,
  answers: AnswersDoc | undefined,
): { stubs: Record<string, unknown>; unresolved: string[] } {
  const stubs: Record<string, unknown> = { ...scenario.stubs };
  const unresolved: string[] = [];
  for (const [path, digest] of Object.entries(scenario.sharedStubs ?? {})) {
    if (answers && Object.hasOwn(answers.stubs, digest)) stubs[path] = answers.stubs[digest];
    else unresolved.push(path);
  }
  return { stubs, unresolved };
}
