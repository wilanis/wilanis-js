/**
 * What the rehearsal says about a guard (RFC 0007, step 6). A guard is a switch the compiler lowered where a
 * field invariant could not be proved, so the branch solver inverts its rule like any other and the walk tries
 * both branches: nothing new is solved. What is held here is only what a reader is told -- that the decision is
 * headed by the invariant it stands for rather than by a node the author never wrote, that its two branches
 * read `holds` and `violated`, that the violated one is refused on purpose as a declared refusal is, and that
 * the summary says, invariant by invariant, where the tree met each one.
 *
 * The example's own invariants carry most of the claims: the field form is guarded at every site of `Customer`,
 * which is what the checker could prove and no more. `proved at N site(s)` with an N above zero needs a site the
 * proof rules do settle, so the last case plants one, the way `invariant-proof.test.ts` plants its own.
 *
 * One case counts the guards the walk reaches rather than only checking that each one it found settles 2/2, since
 * the looser claim is true of a walk that reaches one guard and of a walk that reaches them all. It reaches every
 * guard the profile binds, of either arity: a list site lowers to a `map` over a nested spec, and the walk opens
 * that spec by the name the compiler keys it under, so its `in:check` is a decision like any other (#437).
 *
 * The walked count and the summary's count answer different questions and are held separately: the walk reaches
 * what a run under this profile can reach, while `heldWhollyAt` counts guarded sites over the whole tree, the
 * `-postgres` copies of the data graphs among them. A profile that binds none of them still states the same rules.
 */

import { rmSync } from 'node:fs';
import { loadTree, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { rehearse } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedWith, PLUGINS } from './example-harness.js';

const CUSTOMER = '@customers/domain/Customer.shape.json';

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
      "features/customers/data/kept-get  guard 'row:check' A customer is reachable  2/2 branches",
    );
    // and the switch the author did write is untouched, still headed as a switch
    expect(run.lines).toContain("features/customers/data/kept-get  switch 'route'  2/2 branches");
  });

  it("labels a guard's branches holds and violated, and refuses the violated one on purpose", async () => {
    const said = decision((await localRun()).lines, "kept-get  guard 'row:check'");
    expect(said[1]).toBe("  ok  holds     answered from 'row'");
    expect(said[2]).toMatch(/^ {2}ok {2}violated {2}refused on purpose at 'row:violated' as invariant: /);
    // the message is the invariant's own, so a reader sees which rule the value did not satisfy
    expect(said[2]).toContain(
      "'A customer is reachable' does not hold: len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))",
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
   * 2/2" is true of a walk that finds one of them and of a walk that finds them all. It reaches eight, which is
   * every guard this profile can run: `local` binds eight of the sixteen guarded sites -- the four of arity
   * `one` at `<id>:check`, and four of arity `list` (the listing, the listing across tenants, the listing by
   * tier and the CSV export), whose guard is the `in:check` of the nested spec the compiler keys as
   * `guard:<graph>#<id>` and the walk now opens by that name (#437). Seven of the other eight are the
   * `-postgres` copies of the same graphs, which only the `production` profile binds, and the last is the REST
   * listing by tier, which only `live` binds, so no run under this one reaches them; the summary's sixteen
   * counts sites over the whole tree and is not a per-profile number.
   *
   * The two counts are therefore different questions and neither is loosened here: change either only when the
   * example gains or loses a guarded site, and say which of the two moved.
   */
  it('reaches every guard the profile binds, whatever the arity of its site', async () => {
    const run = await localRun();
    const guards = run.lines.filter(line => line.includes(" guard '"));
    expect(guards).toHaveLength(8);
    // the four made sites of a single value, at the `<id>:check` the RFC names
    expect(guards.filter(line => line.includes("guard 'row:check'"))).toHaveLength(4);
    // and the four lists, each judged element by element inside a nested spec whose ids are the fixed `in:*`
    expect(guards.filter(line => line.includes("guard 'in:check'"))).toHaveLength(4);
    // every one of them walks both branches, a list's exactly as a single value's
    for (const line of guards) expect(line).toContain('2/2 branches');
    // while the summary counts every site the checker could not prove, over the tree rather than the profile
    expect(stated(run.lines)).toContain('  A customer is reachable  proved at 0 site(s), guarded at 16');
  });

  it("labels a list guard's branches holds and violated, as a guard of arity one's are", async () => {
    // the element arrives whole as `in`, so the nested spec's ids are the fixed `in:*` of a taken site
    const said = decision((await localRun()).lines, "kept-list  guard 'in:check'");
    expect(said[1]).toBe("  ok  holds     answered from 'in:ok'");
    expect(said[2]).toMatch(/^ {2}ok {2}violated {2}refused on purpose at 'in:violated' as invariant: /);
    // the map runs with onItemFailure 'fail', so the list refuses with the first element's reason
    expect(said[2]).toContain(
      "'A customer is reachable' does not hold: len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))",
    );
    expect(said).toHaveLength(3);
  });

  it('says how many invariants the tree declares, and where each is met', async () => {
    const said = stated((await localRun()).lines);
    expect(said).toHaveLength(3);
    // the access form holds at the triggers that reach what it gates and meet what it requires
    expect(said).toContain('  Writes are for registrars  holds at 5 trigger(s)');
    expect(said).toContain("  The session is the caller's  holds at 3 trigger(s)");
    // and the field form counts its sites: every site of Customer in the example is one the checker could not prove
    expect(said).toContain('  A customer is reachable  proved at 0 site(s), guarded at 16');
  });

  it('counts the same invariants under a profile that reaches almost none of the guarded sites', async () => {
    // an invariant is stated over the tree, not over a profile: the sites are the same however the tree is bound
    const run = await rehearse(loadTree(EXAMPLE, PLUGINS, INCLUDES), { seed: 1, profile: 'live' });
    expect(run.ok).toBe(true);
    expect(stated(run.lines)).toContain('  A customer is reachable  proved at 0 site(s), guarded at 16');
    // while the walk reaches only the two guards this profile binds -- the CSV export, whose graph every profile
    // shares, and the tier listing's empty answer -- which is the difference between what a tree states and what
    // one profile's run can exercise
    expect(run.lines.filter(line => line.includes(" guard '"))).toHaveLength(2);
  });

  /**
   * A site two invariants are unproved at is one guard with one refusal per rule (#492): the conjunction holds,
   * or the first rule broke, or what remains -- the second -- did. The report reads the two refusals as two
   * `violated` branches, each quoting the sentence of its own invariant, so a reader is told which rule a value
   * can break here and never that both broke at once.
   */
  it('reports a guard two invariants share as one decision with a violated branch per rule', async () => {
    const { load, dir } = loadedWith({
      'features/customers/domain/a-customer-has-an-id.invariant.json': {
        $schema: schemaUrl('invariant'),
        label: 'A customer has an id',
        description: 'A second rule over the same shape, unproved at the same sites, so one guard stands for both.',
        holds: { on: CUSTOMER, when: 'len(id) > 0' },
      },
    });
    try {
      const run = await rehearse(load, { seed: 1, profile: 'local' });
      expect(run.ok).toBe(true);
      const said = decision(run.lines, "kept-get  guard 'row:check'");
      expect(said[0]).toBe(
        "features/customers/data/kept-get  guard 'row:check' A customer has an id; A customer is reachable  3/3 branches",
      );
      expect(said[1]).toBe("  ok  holds     answered from 'row'");
      expect(said[2]).toBe(
        `  ok  violated  refused on purpose at 'row:violated' as invariant: "'A customer has an id' does not hold: len(id) > 0"`,
      );
      expect(said[3]).toBe(
        `  ok  violated  refused on purpose at 'row:violated:2' as invariant: "'A customer is reachable' does not hold: len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))"`,
      );
      expect(said).toHaveLength(4);
      // a list site's nested spec is the same three ways round, at the fixed `in:*`
      const list = decision(run.lines, "kept-list  guard 'in:check'");
      expect(list[0]).toContain('3/3 branches');
      expect(list[2]).toContain("at 'in:violated' as invariant: \"'A customer has an id' does not hold");
      expect(list[3]).toContain("at 'in:violated:2' as invariant: \"'A customer is reachable' does not hold");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a site the proof rules settle as proved rather than guarded', async () => {
    // a node whose every read is a literal satisfying the rule: `literal`, which is a proof and lowers no guard
    const { load, dir } = loadedWith({
      'features/customers/data/proving.graph.json': {
        $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json',
        label: 'Proving',
        description: 'A graph planted so that one site of Customer is proved and the count is not all guarded.',
        out: { type: CUSTOMER, from: 'row' },
        nodes: [
          {
            type: '@wilanis/node/run.schema.json',
            id: 'row',
            label: 'row',
            run: '@std/object.port.json#make',
            in: { value: { id: 'a', name: 'Ada', email: 'ada@example.com', tier: 'bronze' }, type: CUSTOMER },
          },
        ],
      },
    });
    try {
      const said = stated((await rehearse(load, { seed: 1, profile: 'local' })).lines);
      const line = said.find(one => one.includes('A customer is reachable'));
      // one more site than the example has, and it is the proved one: the other sixteen still carry a guard
      expect(line).toBe('  A customer is reachable  proved at 1 site(s), guarded at 16');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
