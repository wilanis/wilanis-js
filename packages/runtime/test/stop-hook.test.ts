import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { CAP, COUNTER, gateOf, stopHook } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

/** A copy of the example has no node_modules, so the plugins and the included tree are handed in as the harness does. */
const loading = async (root: string) => loadTree(root, PLUGINS, INCLUDES);

const trees: string[] = [];

/** A copy of the example the case may break; every copy is removed once the case is done. */
function tree(): string {
  const dir = copyOfExample();
  trees.push(dir);
  return dir;
}

const PORT = join('features', 'hello', 'domain', 'greeting.port.json');
const SHAPE = '@hello/domain/Greeting.shape.json';

/** Point one operation of the copied tree at a shape that is not there, so `wilanis check` refuses it. */
const returns = (dir: string, shape: string) => {
  const path = join(dir, PORT);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  doc.operations.hello.returns = shape;
  writeFileSync(path, JSON.stringify(doc, null, 2));
};

/** The copy, refusing: the greeting answers a shape no document declares. */
const refusing = (dir: string) => returns(dir, '@hello/domain/Nothing.shape.json');

/** The copy, put back the way the example ships it, so it checks clean again. */
const fixed = (dir: string) => returns(dir, SHAPE);

/** A gate script the tree declares, writing what the case wants it to say. */
function declaresGate(dir: string, says: string, args: string[] = []): void {
  const script = join(dir, 'accept.sh');
  writeFileSync(script, `#!/bin/sh\necho "$@"\necho '${says}'\n`);
  chmodSync(script, 0o755);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'wilanis.json'), JSON.stringify({ gate: { run: script, args } }));
}

afterEach(() => {
  for (const dir of trees.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the Stop hook', () => {
  it('blocks the stop over a refusing tree, and allows it once the document is fixed', {
    timeout: 20_000,
  }, async () => {
    const dir = tree();
    refusing(dir);
    const blocked = await stopHook({}, dir, loading);
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('wilanis refuses this tree');
    expect(blocked.reason).toContain('R00'); // the refusal itself, not just that there was one
    expect(blocked.reason).toContain(`block 1 of ${CAP}`);

    fixed(dir);
    const allowed = await stopHook({}, dir, loading);
    expect(allowed.decision).toBeUndefined();
    expect(allowed).toEqual({});
  });

  it('counts the blocks under .wilanis/, caps them, then allows the stop with the verdict attached', {
    timeout: 20_000,
  }, async () => {
    const dir = tree();
    refusing(dir);
    for (let at = 1; at <= CAP; at++) {
      const answer = await stopHook({}, dir, loading);
      expect(answer.decision).toBe('block');
      expect(answer.reason).toContain(`block ${at} of ${CAP}`);
      expect(readFileSync(join(dir, COUNTER), 'utf8').trim()).toBe(String(at));
    }
    const capped = await stopHook({}, dir, loading);
    expect(capped.decision).toBeUndefined();
    expect(capped.systemMessage).toContain(`still refuses this tree after ${CAP} attempts`);
    // the count is spent, so the next session starts over rather than being capped from the first stop
    expect(existsSync(join(dir, COUNTER))).toBe(false);
  });

  it('clears the count when the tree checks clean, so a long healthy session never spends the cap', {
    timeout: 20_000,
  }, async () => {
    const dir = tree();
    refusing(dir);
    await stopHook({}, dir, loading);
    await stopHook({}, dir, loading);
    expect(readFileSync(join(dir, COUNTER), 'utf8').trim()).toBe('2');
    fixed(dir);
    await stopHook({}, dir, loading);
    expect(existsSync(join(dir, COUNTER))).toBe(false);
    refusing(dir);
    expect((await stopHook({}, dir, loading)).reason).toContain(`block 1 of ${CAP}`);
  });

  it('allows the stop when the harness says it is already inside this hook, whatever the tree says', async () => {
    const dir = tree();
    refusing(dir);
    const answer = await stopHook({ stop_hook_active: true }, dir, loading);
    expect(answer.decision).toBeUndefined();
    expect(answer.systemMessage).toContain('the stop stands');
  });

  it('runs the gate the tree declares, with the arguments its file names, and blocks on REJECTED', async () => {
    const dir = tree();
    declaresGate(dir, 'REJECTED', ['--suite', 'tasks']);
    expect(gateOf(dir)).toEqual({ run: join(dir, 'accept.sh'), args: ['--suite', 'tasks'] });
    const blocked = await stopHook({}, dir, loading);
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('gate REJECTED');
    expect(blocked.reason).toContain('--suite tasks'); // the arguments reached the script
  });

  it('lets a gate that accepts through, and runs no gate at all where the tree declares none', {
    timeout: 20_000,
  }, async () => {
    const dir = tree();
    declaresGate(dir, 'ACCEPTED');
    expect(await stopHook({}, dir, loading)).toEqual({});
    unlinkSync(join(dir, '.claude', 'wilanis.json'));
    expect(gateOf(dir)).toBeUndefined();
    expect(await stopHook({}, dir, loading)).toEqual({});
  });

  it('blocks rather than letting the stop through when judging the tree throws', async () => {
    const dir = tree();
    const thrown = async () => {
      throw new Error('the tree could not be loaded');
    };
    const answer = await stopHook({}, dir, thrown);
    expect(answer.decision).toBe('block');
    expect(answer.reason).toContain('wilanis could not judge this tree');
    expect(answer.reason).toContain('the tree could not be loaded');
  });

  it('leaves a directory that is no tree of ours alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-bare-'));
    trees.push(dir);
    expect(await stopHook({}, dir)).toEqual({});
  });
});
