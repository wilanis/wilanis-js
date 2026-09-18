/**
 * What the rehearsal says about a guard (RFC 0007, step 6). A guard is a switch the compiler lowered where a
 * field invariant could not be proved, so the branch solver inverts its rule like any other and the walk tries
 * both branches: nothing new is solved. What is held here is only what a reader is told -- that the decision is
 * headed by the invariant it stands for rather than by a node the author never wrote, that its two branches
 * read `holds` and `violated`, that the violated one is refused on purpose as a declared refusal is, and that
 * the summary says, invariant by invariant, where the tree met each one.
 *
 * The example's own invariants carry most of the claims: the field form is guarded at every site of `Entry`,
 * which is what the checker could prove and no more. `proved at N site(s)` with an N above zero needs a site the
 * proof rules do settle, so the last case plants one, the way `invariant-proof.test.ts` plants its own.
 *
 * One case counts the guards the walk reaches rather than only checking that each one it found settles 2/2, since
 * the looser claim is true of a walk that reaches one guard and of a walk that reaches them all. It reaches four
 * of the thirteen today -- the ones of arity `one` -- and that case says so with the number, so the day a list
 * guard's nested spec is walked, it fails and is updated rather than passing quietly on a different tree.
 */

import { rmSync } from 'node:fs';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { rehearse } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedWith, PLUGINS } from './example-harness.js';

const ENTRY = '@monitor/domain/Entry.shape.json';

/** The example rehearsed under the profile whose bindings reach the store, where the guards are lowered. */
const localRun = () => rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, profile: 'local' });

/** The lines of a decision: its header and every branch under it, up to the next header. */
function decision(lines: string[], head: string): string[] {
  const at = lines.findIndex(line => line.includes(head));
  if (at < 0) throw new Error(`no decision '${head}' in:\n${lines.join('\n')}`);
  const after = lines.slice(at + 1).findIndex(line => !line.startsWith('  '));
  return lines.slice(at, after < 0 ? undefined : at + 1 + after);
}

/** The invariant lines of the summary: everything under the count, which is where the tree states its rules. */
function stated(lines: string[]): string[] {
  const at = lines.findIndex(line => /^\d+ invariant\(s\) declared:$/.test(line));
  if (at < 0) throw new Error(`no invariant summary in:\n${lines.join('\n')}`);
  return lines.slice(at + 1).filter(line => line.startsWith('  '));
}

describe('the rehearsal reports a guard', () => {
  it('heads a guard by the invariant it stands for, where a switch is headed by itself', async () => {
    const run = await localRun();
    expect(run.ok).toBe(true);
    // the compiler's own node, named by the rule it tests rather than by an id nobody wrote
    expect(run.lines).toContain(
      "features/monitor/data/kept-get  guard 'row:check' An entry names a call  2/2 branches",
    );
    // and the switch the author did write is untouched, still headed as a switch
    expect(run.lines).toContain("features/monitor/data/kept-get  switch 'route'  2/2 branches");
  });

  it("labels a guard's branches holds and violated, and refuses the violated one on purpose", async () => {
    const said = decision((await localRun()).lines, "kept-get  guard 'row:check'");
    expect(said[1]).toBe("  ok  holds     answered from 'row'");
    expect(said[2]).toMatch(/^ {2}ok {2}violated {2}refused on purpose at 'row:violated' as invariant: /);
    // the message is the invariant's own, so a reader sees which rule the value did not satisfy
    expect(said[2]).toContain(
      "'An entry names a call' does not hold: len(url) > 0 && (method != 'DELETE' || has(agent))",
    );
    expect(said).toHaveLength(3);
  });

  it('solves both branches of every guard, at every seed: a guard is a switch and nothing new is solved', async () => {
    for (const seed of [1, 2, 3, 7]) {
      const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed, profile: 'local' });
      const guards = run.lines.filter(line => line.includes(" guard '"));
      expect(guards.length).toBeGreaterThan(0);
      for (const line of guards) expect(line).toContain('2/2 branches');
    }
  });

  /**
   * How many guards the walk reaches, named rather than counted loosely, because "every guard it found settles
   * 2/2" is true of a walk that finds one of them and of a walk that finds them all. The example's `Entry` has
   * thirteen guarded sites and the walk reaches four: the four of arity `one`. The nine list sites lower to a
   * `map` over `guard:<graph>#<id>`, and `nested` in `rehearse.ts` opens a `graph:` handler and a binding's and
   * neither matches, so their `in:check` never becomes a decision. That is a known gap with an issue of its
   * own (#437) -- closing it needs the compiler to hand a guard's spec back by name -- and this case is what
   * will fail, loudly and with the number, on the day it closes: update the count, do not loosen the claim.
   */
  it('reaches the guards of arity one, and not yet those a list lowers to a nested spec', async () => {
    const run = await localRun();
    const guards = run.lines.filter(line => line.includes(" guard '"));
    expect(guards).toHaveLength(4);
    // every one of them is the single-value form, at the `<id>:check` the RFC names
    for (const line of guards) expect(line).toContain("guard 'row:check'");
    // while the summary counts every site the checker could not prove, walked or not
    expect(stated(run.lines)).toContain('  An entry names a call  proved at 0 site(s), guarded at 13');
  });

  it('says how many invariants the tree declares, and where each is met', async () => {
    const said = stated((await localRun()).lines);
    expect(said).toHaveLength(3);
    // the access form holds at the triggers that reach what it gates and meet what it requires
    expect(said).toContain('  Writes are for recorders  holds at 5 trigger(s)');
    expect(said).toContain("  The session is the caller's  holds at 3 trigger(s)");
    // and the field form counts its sites: every site of Entry in the example is one the checker could not prove
    expect(said).toContain('  An entry names a call  proved at 0 site(s), guarded at 13');
  });

  it('counts the same invariants under a profile whose bindings lower no guard at all', async () => {
    // an invariant is stated over the tree, not over a profile: the sites are the same however the tree is bound
    const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, profile: 'live' });
    expect(run.ok).toBe(true);
    expect(stated(run.lines)).toContain('  An entry names a call  proved at 0 site(s), guarded at 13');
  });

  it('counts a site the proof rules settle as proved rather than guarded', async () => {
    // a node whose every read is a literal satisfying the rule: `literal`, which is a proof and lowers no guard
    const { load, dir } = loadedWith({
      'features/monitor/data/proving.graph.json': {
        $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json',
        label: 'Proving',
        description: 'A graph planted so that one site of Entry is proved and the count is not all guarded.',
        out: { type: ENTRY, from: 'row' },
        nodes: [
          {
            type: '@wilanis/node/run.schema.json',
            id: 'row',
            label: 'row',
            run: '@std/object.port.json#make',
            in: { value: { id: 'a', url: 'https://x', method: 'GET', agent: 'probe' }, type: ENTRY },
          },
        ],
      },
    });
    try {
      const said = stated((await rehearse(load, { seed: 1, profile: 'local' })).lines);
      const line = said.find(one => one.includes('An entry names a call'));
      // one more site than the example has, and it is the proved one: the other thirteen still carry a guard
      expect(line).toBe('  An entry names a call  proved at 1 site(s), guarded at 13');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
