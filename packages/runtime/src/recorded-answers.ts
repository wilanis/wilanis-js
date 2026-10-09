/**
 * What the scenarios of one recorded directory share (RFC 0036): each distinct node answer and each distinct stub
 * value once, in the answers document at the top of the directory, under the digest of its canonical JSON, and each
 * scenario written with the digest in the value's place. `writeRecorded` and `checkRecorded` call `sharedOf`, so a
 * command that records builds its scenarios inline and never learns the form they are written in.
 */
import {
  type AnswersDoc,
  answerDigest,
  canonicalJson,
  type ScenarioDoc,
  type ScenarioNode,
  schemaUrl,
} from '@wilanis/core';
import type { Owner } from './recorded-owner.js';
import { WRITTEN_BY } from './scenario-said.js';

/** The scenarios of one directory as a command writes them, and the answers document they point into, if any. */
export interface Shared {
  docs: Record<string, ScenarioDoc>;
  /** Absent where no scenario has a node or a stub: nothing is shared, and no answers file is written. */
  answers?: AnswersDoc;
}

/**
 * A value as the JSON written for it reads back: a `Date` as its text, a key whose value is absent left out, an
 * absent item of a list as `null`. The digest is taken over this, so it names exactly the text the file holds.
 * Nothing where `JSON.stringify` writes nothing, as for an absent value.
 */
export function asWritten(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

/** The values one directory shares, each under its digest, and the canonical text each digest was taken over. */
class Held {
  readonly nodes: Record<string, ScenarioNode> = {};
  readonly stubs: Record<string, unknown> = {};
  private readonly texts = new Map<string, string>();

  constructor(private readonly digestOf: (value: unknown) => string) {}

  /** The digest a value is held under in `map`; throws where another value already has that digest, naming both. */
  hold<T>(map: Record<string, T>, value: T): string {
    const text = canonicalJson(value);
    const digest = this.digestOf(value);
    const other = this.texts.get(digest);
    if (other !== undefined && other !== text)
      throw new Error(
        `two different values share the digest ${digest}, and an answers file holds one value under a digest: ` +
          `${other} and ${text} -- report it, since a digest of 64 bits should not collide`,
      );
    this.texts.set(digest, text);
    map[digest] = value;
    return digest;
  }

  /** Each node of a scenario as the digest of its answer; a digest already written stays as it is. */
  nodesOf(nodes: Record<string, ScenarioNode | string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, node] of Object.entries(nodes))
      out[path] = typeof node === 'string' ? node : this.hold(this.nodes, asWritten(node) as ScenarioNode);
    return out;
  }

  /** Each stubbed path of a scenario as the digest of its value; a path whose value JSON leaves out is left out. */
  stubsOf(stubs: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, value] of Object.entries(stubs)) {
      const written = asWritten(value);
      if (written !== undefined) out[path] = this.hold(this.stubs, written);
    }
    return out;
  }
}

/** One scenario with a digest per node and `sharedStubs` where `stubs` was, every other field as it was, in its place. */
function pointing(doc: ScenarioDoc, held: Held): ScenarioDoc {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'expect') out.expect = { ...doc.expect, nodes: held.nodesOf(doc.expect.nodes) };
    else if (key !== 'stubs') out[key] = value;
    else if (doc.stubs && Object.keys(doc.stubs).length) out.sharedStubs = held.stubsOf(doc.stubs);
  }
  return out as unknown as ScenarioDoc;
}

/** A map's entries sorted by digest, so the document is the same whatever order the scenarios were shared in. */
const sorted = <T>(map: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(map).sort(([one], [other]) => (one < other ? -1 : 1)));

/**
 * The scenarios a command writes under `dir`, given inline, as they are written: each node answer and each stub value
 * replaced by its digest, and the one answers document that holds each value once. No answers document where nothing
 * is shared. Throws where two different values share a digest, naming both; `digestOf` is `answerDigest` but in a test.
 */
export function sharedOf(
  docs: Record<string, ScenarioDoc>,
  dir: string,
  owner: Owner,
  digestOf: (value: unknown) => string = answerDigest,
): Shared {
  const held = new Held(digestOf);
  const out = Object.fromEntries(Object.entries(docs).map(([file, doc]) => [file, pointing(doc, held)]));
  if (!Object.keys(held.nodes).length && !Object.keys(held.stubs).length) return { docs: out };
  const answers: AnswersDoc = {
    $schema: schemaUrl('answers'),
    description:
      `The node answers and stub values the scenarios under ${dir}/ share, each once, under its digest. ` +
      `Written by ${WRITTEN_BY[owner.generated]}; regenerate it, do not edit it.`,
    generated: owner.generated,
    nodes: sorted(held.nodes),
    stubs: sorted(held.stubs),
  };
  return { docs: out, answers };
}

/** One map of the answers file: each value on its own line, in its canonical form, sorted by digest; `{}` when empty. */
function mapLines(map: Record<string, unknown>): string {
  const lines = Object.keys(map)
    .sort()
    .map(digest => `${JSON.stringify(digest)}:${canonicalJson(map[digest])}`);
  return lines.length ? `{\n${lines.join(',\n')}\n}` : '{}';
}

/**
 * The bytes an answers document is written as: the envelope opens the first line, each map opens on its own line,
 * and each value is on a line of its own, so a diff of the file lists the values added and removed one line each.
 */
export function renderedAnswers(doc: AnswersDoc): string {
  const { nodes, stubs, ...envelope } = doc;
  return `${JSON.stringify(envelope).slice(0, -1)},"nodes":${mapLines(nodes)},"stubs":${mapLines(stubs)}}\n`;
}
