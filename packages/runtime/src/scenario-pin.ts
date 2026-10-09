/**
 * `wilanis scenarios --pin <file>` (RFC 0036): one run a command recorded, kept by hand. A recorded scenario points
 * into an answers document its command rewrites whole, so a copy that kept the pointers could lose a value on the next
 * record. The pinned copy writes every answer and stub inline, carries no `generated` mark, and sits directly under
 * `scenarios/`, the one place no command owns.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { answersAbove, type LoadResult, nodesOf, type ScenarioDoc, type ScenarioNode, stubsOf } from '@wilanis/core';
import { HOME_DIR } from './recorded-owner.js';
import { unreadSaid, WRITTEN_BY } from './scenario-said.js';

/** What `--pin` answers: whether it wrote the copy, the one line it says, and the file it wrote, below the root. */
export interface Pinned {
  ok: boolean;
  line: string;
  wrote?: string;
}

/** A scenario's description up to the end of its first sentence: a period followed by a space or the end. */
function firstSentence(text: string): string {
  return /^.*?\.(?=\s|$)/s.exec(text.trim())?.[0] ?? text.trim();
}

/** The values a pinned copy writes in place of its pointers: each node's answer and each stub's value. */
interface Inline {
  nodes: Record<string, ScenarioNode>;
  stubs: Record<string, unknown>;
}

/**
 * The copy of a scenario that `--pin` writes: every field in its place, the nodes and stubs written inline (the stubs
 * where `stubs` or `sharedStubs` was), no `generated` and no `sharedStubs`, and the description's first sentence
 * followed by where it was pinned from.
 */
function pinnedDoc(doc: ScenarioDoc, from: string, inline: Inline): ScenarioDoc {
  const written: Record<string, unknown> = {
    description: `${firstSentence(doc.description)} Pinned from ${from}; say here why it is kept.`,
    stubs: inline.stubs,
    expect: { ...doc.expect, nodes: inline.nodes },
  };
  const kept = Object.keys(doc)
    .filter(key => key !== 'generated')
    .map(key => (key === 'sharedStubs' ? 'stubs' : key))
    .map(key => [key, Object.hasOwn(written, key) ? written[key] : doc[key as keyof ScenarioDoc]]);
  return Object.fromEntries(kept) as ScenarioDoc;
}

/** The answers documents `answersAbove` finds above a scenario: its own, or another command's. */
type Above = ReturnType<typeof answersAbove>;

/** Why a scenario's pointers cannot be written inline, and what to run so they can. */
function unresolvedSaid(doc: ScenarioDoc, above: Above, where: { from: string; paths: string[] }): string {
  const why = above.own ? `${above.own.path.slice(1)} does not hold them` : unreadSaid(above, doc);
  const fix = doc.generated
    ? `run ${WRITTEN_BY[doc.generated]}, which writes the scenario and what it points at again, then pin it again`
    : 'run wilanis check: S006 names the value to write in place of each digest';
  return `${where.from} points at values --pin cannot read (${where.paths.join(', ')}): ${why} -- ${fix}`;
}

/**
 * Copy one scenario of the tree, named by its path below the root (`@` or not), to `scenarios/<its file name>` with
 * every answer and stub inline (`nodesOf`, `stubsOf`). Writes nothing where a pointer does not resolve, or where
 * that file is already there, and says why.
 */
export function pinScenario(load: LoadResult, file: string): Pinned {
  const from = file.replace(/^@/, '').replace(/^\.\//, '');
  const found = load.registry.get('scenario', `@${from}`);
  if (!found)
    return {
      ok: false,
      line: `${from} is no scenario of this tree: name one by its path below the root, as wilanis ls scenario lists it`,
    };
  const above = answersAbove(load.registry, found.path);
  const [nodes, stubs] = [nodesOf(found.doc, above.own?.doc), stubsOf(found.doc, above.own?.doc)];
  const paths = [...nodes.unresolved, ...stubs.unresolved.map(path => `stub ${path}`)];
  if (paths.length) return { ok: false, line: unresolvedSaid(found.doc, above, { from, paths }) };
  const wrote = `${HOME_DIR}/${basename(from)}`;
  if (existsSync(join(load.root, wrote)))
    return {
      ok: false,
      line: `${wrote} is there already, and --pin never writes over a file: move it away, then pin again`,
    };
  const doc = pinnedDoc(found.doc, from, { nodes: nodes.nodes, stubs: stubs.stubs });
  writeFileSync(join(load.root, wrote), `${JSON.stringify(doc, null, 2)}\n`, { flag: 'wx' });
  const line = `wrote ${wrote} with every answer and stub inline -- give it a description of your own`;
  return { ok: true, line, wrote };
}
