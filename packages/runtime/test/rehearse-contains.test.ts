/**
 * The rehearsal steers a `contains` rule both ways (RFC 0040): `satisfy` makes a text that holds the words a case
 * demands and lacks the words it forbids, or says no value of the type can, and a switch over such a rule has both
 * of its branches run.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, rehearse } from '../src/index.js';
import { NO_MEMBER, satisfy } from '../src/stubs.js';
import { decide, edge, graph, HERE, make, refuse, STRING, shape, treeOf, trigger } from './rehearse-stubs-trees.js';

const TEXT = { kind: 'string' } as const;

describe('making a text that holds or lacks a word', () => {
  it('appends a word the text must hold, after a space', () => {
    expect(satisfy({ contains: ['@'], present: true }, 'echo', TEXT)).toBe('echo @');
  });
  it('keeps a generated text that already holds it', () => {
    expect(satisfy({ contains: ['@'], present: true }, 'a@b', TEXT)).toBe('a@b');
  });
  it('takes out a word the text must lack, again until none is left', () => {
    expect(satisfy({ omits: ['hp'] }, 'hhpp', TEXT)).toBe('');
    expect(satisfy({ omits: ['@'] }, 'a@b@c', TEXT)).toBe('abc');
  });
  it('holds one word and lacks another at once', () => {
    expect(satisfy({ contains: ['.'], omits: ['@'], present: true }, 'a@b', TEXT)).toBe('ab .');
  });
  it('makes a fresh text where none was generated', () => {
    const made = satisfy({ contains: ['@'], present: true }, undefined, TEXT, 3);
    expect(typeof made === 'string' && made.includes('@')).toBe(true);
  });
  it('pads to the least length the text may be', () => {
    expect(satisfy({ contains: ['@'], present: true, minLen: 4 }, '', TEXT)).toBe('@xxx');
  });
  it('falls back to the words alone where the generated text is too long', () => {
    expect(satisfy({ contains: ['@'], present: true, maxLen: 3 }, 'abcdef', TEXT)).toBe('@');
  });
  it('falls back to the words alone where an append makes a word the text must lack across the join', () => {
    expect(satisfy({ contains: ['b'], omits: ['a b'], present: true }, 'a', TEXT)).toBe('b');
  });
  it('answers NO_MEMBER where no text it can make fits', () => {
    expect(satisfy({ contains: ['@'], present: true, ne: ['@'] }, '', TEXT)).toBe(NO_MEMBER);
  });
  it('takes the generated member of an enum where it fits, else the first member that does', () => {
    const tier = { kind: 'string', enum: ['gold', 'silver', 'bronze'] } as const;
    expect(satisfy({ contains: ['o'], present: true }, 'bronze', tier)).toBe('bronze');
    expect(satisfy({ contains: ['l'], present: true }, 'bronze', tier)).toBe('gold');
    expect(satisfy({ omits: ['o'] }, 'gold', tier)).toBe('silver');
  });
  it('answers NO_MEMBER for a text paired with another, equal or not, that misses its words', () => {
    for (const paired of ['equal', 'unequal'] as const) {
      expect(satisfy({ paired, present: true, contains: ['@'] }, undefined, TEXT, 1)).toBe(NO_MEMBER);
      expect(typeof satisfy({ paired, present: true, omits: ['@'] }, undefined, TEXT, 1)).toBe('string');
    }
  });
  it('answers NO_MEMBER for an enum no member of which fits, never a text outside it', () => {
    const tier = { kind: 'string', enum: ['gold', 'silver'] } as const;
    expect(satisfy({ contains: ['@'], present: true }, 'gold', tier)).toBe(NO_MEMBER);
  });
});

/**
 * `sort` routes an address on `when`, by default whether it holds an `@`: one the rule holds for is answered, any other
 * is refused. The address and a second one, `alt`, come from the trigger's input.
 */
function wordsTree(when = "email contains '@'"): string {
  const port = `${HERE}/domain/mail.port.json`;
  const result = shape('Result');
  return treeOf({
    'domain/Ask.shape.json': { layer: 'core', fields: { email: STRING, alt: STRING } },
    'domain/Result.shape.json': { layer: 'core', fields: { email: STRING } },
    'edge/AskIn.shape.json': { layer: 'edge', fields: { email: STRING, alt: STRING } },
    'edge/Out.shape.json': { layer: 'edge', fields: { email: STRING } },
    'domain/mail.port.json': {
      operations: {
        sort: { description: 'd', accepts: { email: STRING, alt: STRING }, returns: result, refuses: true },
      },
    },
    'data/mail.binding.json': { port, operations: { sort: { graph: `${HERE}/domain/sort.graph.json` } } },
    'domain/sort.graph.json': graph('Sort', shape('Ask'), { type: result, from: ['address', 'name'] }, [
      decide('byWord', { email: '{{in.email}}', alt: '{{in.alt}}' }, [{ when, to: 'address' }], 'name'),
      make('address', { email: '{{in.email}}' }, result),
      refuse('name', 'name', result),
    ]),
    'edge/sort.trigger.json': trigger('sort', { in: edge('AskIn'), out: edge('Out') }, `${port}#sort`),
  });
}

/** The rehearsal of a `wordsTree` under each of four seeds, as its lines and whether it was ok. */
async function rehearsedWith(when?: string): Promise<{ said: string; ok: boolean }[]> {
  const dir = wordsTree(when);
  const load = loadTree(dir, BUILTIN_PLUGINS);
  expect(checkTree(load).format()).toBe('');
  const runs = [];
  for (const seed of [1, 2, 3, 4]) {
    const run = await rehearse(load, { seed });
    runs.push({ said: `seed ${seed}\n${run.lines.join('\n')}`, ok: run.ok });
  }
  rmSync(dir, { recursive: true, force: true });
  return runs;
}

describe('rehearsing a switch over a contains rule', () => {
  it('runs both of its branches under every seed', { timeout: 60_000 }, async () => {
    for (const { said, ok: done } of await rehearsedWith()) {
      expect(said).toMatch(/ok {2}when email contains '@' +answered from 'address'/);
      expect(said).toMatch(/ok {2}anything else +refused on purpose at 'name' as name/);
      expect(said).not.toMatch(/cannot name|BROKE|NEVER RUN/);
      expect(done, said).toBe(true);
    }
  });
  it('reports a rule that pairs the text with another and asks a word of it never run, not run on the wrong route', {
    timeout: 60_000,
  }, async () => {
    for (const when of ["email == alt && email contains '@'", "email != alt && email contains '@'"]) {
      for (const { said, ok: done } of await rehearsedWith(when)) {
        expect(said).toMatch(
          /when .+ +NEVER RUN -- email is compared with another value, so the rehearsal cannot change it to hold and lack the words this branch asks for$/m,
        );
        expect(said).not.toMatch(/enum/);
        expect(said).toMatch(/ok {2}anything else +refused on purpose at 'name' as name/);
        expect(said).not.toMatch(/WRONG ROUTE|BROKE/);
        expect(done, said).toBe(false);
      }
    }
  });
  it('says a plain text it cannot make holds and lacks its words is never run, and names no enum', {
    timeout: 60_000,
  }, async () => {
    // 'abc def' is the text the rehearsal makes, and it is longer than the rule lets it be
    const when = "email contains 'abc' && email contains 'def' && len(email) <= 6";
    for (const { said, ok: done } of await rehearsedWith(when)) {
      expect(said).toMatch(
        /when .+ +NEVER RUN -- the rehearsal can make no text for email that holds and lacks every word this branch asks for$/m,
      );
      expect(said).not.toMatch(/enum|WRONG ROUTE|BROKE/);
      expect(done, said).toBe(false);
    }
  });
});
