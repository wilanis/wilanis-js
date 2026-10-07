/**
 * The solver on a consumer's tree (#845): an else case of a switch over an enum field is steered with a member the
 * rules do not name, never with a value outside the enum, and a rule comparing two fields is solved by making them
 * equal rather than called a contradiction. Under seed 7 the generated status is `clean`, a member the rules name, so
 * the else case has to replace it, and the generated `agrees` is true, so the switches after `status` are reached
 * without laying two cases over the same answer (#844).
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, rehearse } from '../src/index.js';
import { scanTree } from './scan-tree.js';

describe('rehearsing a tree whose switches read an enum and compare two fields', () => {
  it('settles every branch', { timeout: 30_000 }, async () => {
    const dir = scanTree();
    const load = loadTree(dir, BUILTIN_PLUGINS);
    expect(checkTree(load).format()).toBe('');
    const run = await rehearse(load, { seed: 7 });
    rmSync(dir, { recursive: true, force: true });
    const said = run.lines.join('\n');
    // the else of `status` is `broke`, the member neither rule names, and `ok` makes a Result of it
    expect(said).toMatch(/ok {2}anything else +answered from 'ok'/);
    // `has(previous) && previous == commit` is met by a previous equal to the commit
    expect(said).toMatch(/ok {2}when has\(previous\) && previous == commit +refused on purpose at 'same' as same/);
    expect(said).not.toMatch(/contradicts itself|BROKE|NEVER RUN/);
    expect(run.ok, said).toBe(true);
  });
});
