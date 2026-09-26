/**
 * RFC 0008, step 2: `wilanis check` and `wilanis describe project.json` print the tree's IR version beside the one
 * this runtime reads, as `IR v1, runtime reads v1`. Both are read off the built command line, since the check line
 * is printed by the CLI and nowhere else.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const RUNTIME = fileURLToPath(new URL('..', import.meta.url));
const IR = 'IR v1, runtime reads v1';

/** The CLI from the built runtime, run beside the example: its exit code and what it wrote on stdout. */
function wilanis(...args: string[]) {
  const cwd = join(EXAMPLE, '..');
  const ran = spawnSync(process.execPath, [join(RUNTIME, 'bin/wilanis.js'), ...args], { cwd, encoding: 'utf8' });
  return { code: ran.status, stdout: ran.stdout };
}

describe('the IR line', () => {
  it('ends what check prints on an accepted tree, after the count', { timeout: 60_000 }, () => {
    const count = loadTree(EXAMPLE, PLUGINS, INCLUDES).registry.files.length;
    const ran = wilanis('check', 'example');
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe(`ok: ${count} documents, ${IR}\n`);
  });

  it('stands under the name in describe project.json', { timeout: 60_000 }, () => {
    const ran = wilanis('describe', 'project.json', 'example');
    expect(ran.code).toBe(0);
    const lines = ran.stdout.split('\n');
    expect(lines).toContain('name  customers');
    expect(lines[lines.indexOf('name  customers') + 1]).toBe(IR);
  });
});
