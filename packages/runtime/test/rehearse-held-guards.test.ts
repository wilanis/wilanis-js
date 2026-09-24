/**
 * What the rehearsal does with a guard whose value is already judged upstream, and with the stand-in it makes to
 * steer a guard at a made site (#625, RFC 0035). A small tree of its own, since the example is rewritten by the
 * RFC's first step:
 *
 * - `register` fires a domain graph that makes a `Person` (a made site, guarded at `person:check`) and hands it,
 *   field for field, to `keep`, bound to a data graph whose `in` is a `Person` (a taken site, guarded at
 *   `in:check`). On that path the second guard judges the value the first already judged, so it is held there:
 *   nothing the rehearsal can set reaches it, and nothing on this path can make it refuse.
 * - `rename` fires `store` straight from the trigger's input, into a data graph of its own with the same taken
 *   guard. Nothing upstream judges that value, so the guard is steered through the trigger's input as before.
 * - A variant hands `keep` the draft's name rather than the person's, so the value reaching the data graph is not
 *   one the upstream guard judged. That guard is still a branch the rehearsal cannot reach, and says so.
 *
 * `person:check` is steered by stubbing `person:made`, a pure `#make` no seed records, so the stand-in is built from
 * the type the `#make` is given. Its holds branch must answer through `card`, which makes a `Card` from the person's
 * email and refuses one that is not a string -- what a stand-in built from the rule alone handed it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { type Kind, loadTree, schemaUrl } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, rehearse } from '../src/index.js';

const HERE = '@features/people';
const PERSON = `${HERE}/domain/Person.shape.json`;
const PORT = `${HERE}/domain/people.port.json`;
const CARD = `${HERE}/domain/Card.shape.json`;
const FIELDS = { name: { type: 'string' }, email: { type: 'string' } };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (id: string, op: string, input: object) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run: op,
  in: input,
});

/** A data graph over a taken `Person`: it makes the person again from `in`, as a write's answer would be read. */
const keepGraph = (label: string) => ({
  label,
  in: PERSON,
  out: { type: PERSON, from: 'kept' },
  nodes: [
    run('kept', '@std/object.port.json#make', { value: { name: '{{in.name}}', email: '{{in.email}}' }, type: PERSON }),
  ],
});

/** The tree, with `keep` handed the person's fields or, in the variant, the draft's name beside the person's email. */
function peopleTree(handed: 'person' | 'draft' = 'person'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-held-'));
  dirs.push(dir);
  const put = (rel: string, doc: object) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    const kind = rel
      .replace(/\.json$/, '')
      .split(/[./]/)
      .at(-1) as Kind;
    writeFileSync(join(dir, rel), JSON.stringify({ $schema: schemaUrl(kind), description: 'd', ...doc }));
  };
  put('project.json', { name: 'people', plugins: [{ use: '@std' }, { use: '@cli' }] });
  put('features/people/feature.json', {});
  put('features/people/domain/Person.shape.json', { layer: 'core', fields: FIELDS });
  put('features/people/domain/Draft.shape.json', { layer: 'core', fields: FIELDS });
  put('features/people/domain/Card.shape.json', { layer: 'core', fields: FIELDS });
  put('features/people/edge/Signup.shape.json', { layer: 'edge', fields: FIELDS });
  put('features/people/edge/PersonView.shape.json', { layer: 'edge', fields: FIELDS });
  put('features/people/domain/a-person-is-reachable.invariant.json', {
    label: 'A person is reachable',
    holds: { on: PERSON, when: 'len(name) > 0 && len(email) > 0' },
  });
  put('features/people/domain/people.port.json', {
    operations: {
      register: { description: 'd', accepts: FIELDS, returns: CARD },
      keep: { description: 'd', accepts: FIELDS, returns: PERSON },
      store: { description: 'd', accepts: FIELDS, returns: PERSON },
    },
  });
  put('features/people/data/people.binding.json', {
    port: PORT,
    operations: {
      register: { graph: `${HERE}/domain/register-person.graph.json` },
      keep: { graph: `${HERE}/data/keep-person.graph.json` },
      store: { graph: `${HERE}/data/store-person.graph.json` },
    },
  });
  put('features/people/domain/register-person.graph.json', {
    label: 'Register a person',
    in: `${HERE}/domain/Draft.shape.json`,
    out: { type: CARD, from: 'card' },
    nodes: [
      run('person', '@std/object.port.json#make', {
        value: { name: '{{in.name}}', email: '{{in.email}}' },
        type: PERSON,
      }),
      run('kept', `${PORT}#keep`, {
        name: handed === 'person' ? '{{person.name}}' : '{{in.name}}',
        email: '{{person.email}}',
      }),
      run('card', '@std/object.port.json#make', {
        value: { name: '{{kept.name}}', email: '{{person.email}}' },
        type: CARD,
      }),
    ],
  });
  put('features/people/data/keep-person.graph.json', keepGraph('Keep a person'));
  put('features/people/data/store-person.graph.json', keepGraph('Store a person'));
  for (const [command, op] of [
    ['register', 'register'],
    ['rename', 'store'],
  ])
    put(`features/people/edge/${command}.trigger.json`, {
      label: command,
      kind: '@cli/cli.trigger-kind.json',
      settings: { command },
      in: `${HERE}/edge/Signup.shape.json`,
      out: `${HERE}/edge/PersonView.shape.json`,
      fire: { run: `${PORT}#${op}` },
    });
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
    const done = await rehearsed(peopleTree());
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
    const done = await rehearsed(peopleTree());
    expect(decision(done.lines, "data/store-person  guard 'in:check'")).toEqual([
      "features/people/data/store-person  guard 'in:check' A person is reachable  2/2 branches",
      "  ok  holds     answered from 'in:ok'",
      expect.stringMatching(/^ {2}ok {2}violated {2}refused on purpose at 'in:violated' as invariant/),
    ]);
  });

  it('is still unreachable where the value is not the one upstream judged', { timeout: 30_000 }, async () => {
    const done = await rehearsed(peopleTree('draft'));
    const lines = decision(done.lines, "data/keep-person  guard 'in:check'");
    expect(lines[0]).toBe("features/people/data/keep-person  guard 'in:check' A person is reachable  0/2 branches");
    for (const line of lines.slice(1)) expect(line).toMatch(/NEVER RUN -- .* the rehearsal cannot vary it$/);
    expect(done.ok).toBe(false);
  });
});

describe('the stand-in for a guard at a made site', () => {
  it('is a value of the made type, so holds answers and violated reaches the refusal', {
    timeout: 30_000,
  }, async () => {
    const done = await rehearsed(peopleTree());
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
