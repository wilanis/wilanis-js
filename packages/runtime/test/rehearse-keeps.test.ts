/**
 * A keep is run, never stubbed (#1027). A switch on what a keep answers is steered through the list the keep runs
 * over: its `where` is solved as a switch's rule, so `len(kept) > 0` makes an element the rule holds for, and
 * `len(kept) == 0` makes every element one it does not. A stub on the keep itself is one the kernel never reads, and
 * the branch it aimed at was taken only where the list happened to agree.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, Embedder, rehearse } from '../src/index.js';
import { keptTree } from './rehearse-keep-trees.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a switch on what a keep answers', () => {
  it('takes every branch, each from the list the keep runs over, never a stub on the keep', {
    timeout: 30_000,
  }, async () => {
    const dir = keptTree();
    dirs.push(dir);
    const load = loadTree(dir, BUILTIN_PLUGINS);
    expect(checkTree(load).format()).toBe('');
    const stubbed: string[][] = [];
    const fire = Embedder.prototype.fire;
    Embedder.prototype.fire = function (trigger, input, context, opts) {
      stubbed.push(Object.keys(opts?.stubs ?? {}));
      return fire.call(this, trigger, input, context, opts);
    };
    try {
      const done = await rehearse(load, { seed: 1 });
      const decision = done.decisions.find(one => one.graph.endsWith('domain/page.graph.json') && one.node === 'any');
      const said = decision?.branches.map(one => [
        one.to,
        one.settled?.misrouted ?? one.settled?.declared?.reason ?? one.settled?.status,
      ]);
      expect(said, done.lines.join('\n')).toEqual([
        ['n', 'done'],
        ['none', 'empty'],
      ]);
      expect(done.ok, done.lines.join('\n')).toBe(true);
    } finally {
      Embedder.prototype.fire = fire;
    }
    expect(stubbed.flat().filter(path => path.endsWith('.kept'))).toEqual([]);
  });
});
