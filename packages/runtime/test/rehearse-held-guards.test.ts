/**
 * What the rehearsal does with a guard whose value is already judged upstream, and with the stand-in it makes to
 * steer a guard at a made site (#625, RFC 0035). A small tree of its own, `peopleTree` in `rehearse-handed-trees.ts`,
 * since the example is rewritten by the RFC's first step:
 *
 * - `register` fires a domain graph that makes a `Person` (a made site, guarded at `person:check`) and hands it,
 *   field for field, to `keep`, bound to a data graph whose `in` is a `Person` (a taken site, guarded at
 *   `in:check`). On that path the second guard judges the value the first already judged, so it is held there:
 *   nothing the rehearsal can set reaches it, and nothing on this path can make it refuse.
 * - `rename` fires `store` straight from the trigger's input, into a data graph of its own with the same taken
 *   guard. Nothing upstream judges that value, so the guard is steered through the trigger's input as before.
 * - A variant hands `keep` the draft's name rather than the person's. The rehearsal follows the name out to the
 *   trigger's input and steers it there, which answers `holds`; but the person is made from that same name and judged
 *   at `person:check` first, so a name that breaks the rule never gets past it to `keep` (#1027).
 *
 * `person:check` is steered through `person:made`, a pure `#make`: never stubbed, it is followed to the draft it copies,
 * the trigger's input (#1027). Its holds branch must answer through `card`, which makes a `Card` from the person's
 * email and refuses one that is not a string.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, rehearse } from '../src/index.js';
import { type People, peopleTree } from './rehearse-handed-trees.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The people tree, with `keep` handed what the variant says, removed once the case is done. */
function treeOf(handed?: People): string {
  const dir = peopleTree(handed);
  dirs.push(dir);
  return dir;
}

/** The tree rehearsed, once the checker has let it through: a case about the walk must stand on a tree that passes. */
async function rehearsed(dir: string) {
  const load = loadTree(dir, BUILTIN_PLUGINS);
  const refused = checkTree(load).format();
  if (refused) throw new Error(`the tree a case rehearses must itself pass:\n${refused}`);
  return rehearse(load, { seed: 1 });
}

/** The lines of one decision: its header and every branch under it. */
function decision(lines: string[], head: string): string[] {
  const at = lines.findIndex(line => line.includes(head));
  if (at < 0) throw new Error(`no decision '${head}' in:\n${lines.join('\n')}`);
  const after = lines.slice(at + 1).findIndex(line => !line.startsWith('  '));
  return lines.slice(at, after < 0 ? undefined : at + 1 + after);
}

describe('a guard whose value an enclosing graph already judged', () => {
  it('is held at the upstream guard, named, and is no problem', { timeout: 30_000 }, async () => {
    const done = await rehearsed(treeOf());
    const held =
      "held upstream by guard 'person:check' in features/people/domain/register-person, which judged this value first";
    expect(decision(done.lines, "data/keep-person  guard 'in:check'")).toEqual([
      "features/people/data/keep-person  guard 'in:check' A person is reachable  2/2 branches",
      expect.stringMatching(new RegExp(`^ {2}ok {2}holds {5}${literally(held)}$`)),
      expect.stringMatching(new RegExp(`^ {2}ok {2}violated {2}${literally(held)}$`)),
    ]);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });

  it('is steered as before where nothing upstream judged it', { timeout: 30_000 }, async () => {
    const done = await rehearsed(treeOf());
    expect(decision(done.lines, "data/store-person  guard 'in:check'")).toEqual([
      "features/people/data/store-person  guard 'in:check' A person is reachable  2/2 branches",
      "  ok  holds     answered from 'in:ok'",
      expect.stringMatching(/^ {2}ok {2}violated {2}refused on purpose at 'in:violated' as invariant/),
    ]);
  });

  it('is steered where the value is not the one upstream judged, and held where its rule was', {
    timeout: 30_000,
  }, async () => {
    // the name is the draft's, handed down from the trigger's input: the trace follows it there and patches it; the
    // person made of that name is judged first, so a name that breaks the rule is refused there and never reaches keep
    const done = await rehearsed(treeOf('draft'));
    expect(decision(done.lines, "data/keep-person  guard 'in:check'")).toEqual([
      "features/people/data/keep-person  guard 'in:check' A person is reachable  2/2 branches",
      "  ok  holds     answered from 'in:ok'",
      "  ok  violated  held upstream by guard 'person:check' in features/people/domain/register-person, which judged this value first",
    ]);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });
});

describe('the stand-in for a guard at a made site', () => {
  it('is a value of the made type, so holds answers and violated reaches the refusal', {
    timeout: 30_000,
  }, async () => {
    const done = await rehearsed(treeOf());
    expect(decision(done.lines, "register-person  guard 'person:check'")).toEqual([
      "features/people/domain/register-person  guard 'person:check' A person is reachable  2/2 branches",
      "  ok  holds     answered from 'person'",
      expect.stringMatching(/^ {2}ok {2}violated {2}refused on purpose at 'person:violated' as invariant/),
    ]);
  });
});

/** A literal string as a pattern. */
function literally(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
