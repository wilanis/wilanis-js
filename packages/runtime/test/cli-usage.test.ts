/**
 * #842: a command missing the word it needs is a usage error, as `new` is: it says what is missing, prints the usage
 * on stderr and exits 2 before any tree is loaded. `describe` of a path that names no document exits 1. Read off the
 * built command line, run inside the example as a consumer would.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXAMPLE } from './example-harness.js';

const RUNTIME = fileURLToPath(new URL('..', import.meta.url));

/** The CLI from the built runtime, run inside the example: its exit code and what it wrote on each stream. */
function wilanis(...args: string[]) {
  const ran = spawnSync(process.execPath, [join(RUNTIME, 'bin/wilanis.js'), ...args], {
    cwd: EXAMPLE,
    encoding: 'utf8',
  });
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

describe('a command missing the word it needs', () => {
  it('describe with no path says so, prints the usage and exits 2', { timeout: 60_000 }, () => {
    const ran = wilanis('describe');
    expect(ran.code).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toMatch(/^wilanis describe: name the document to describe/);
    expect(ran.stderr).toContain('wilanis describe <path> [root]');
    expect(ran.stderr).not.toContain('Cannot read properties');
  });

  it('run with no trigger says so, prints the usage and exits 2', { timeout: 60_000 }, () => {
    const ran = wilanis('run');
    expect(ran.code).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toMatch(/^wilanis run: name the trigger to fire/);
    expect(ran.stderr).toContain('wilanis run      <trigger> [root]');
    expect(ran.stderr).not.toContain("no trigger at 'undefined'");
  });

  it('new with no kind or name still says what is missing, as describe and run do', { timeout: 60_000 }, () => {
    const ran = wilanis('new', 'shape');
    expect(ran.code).toBe(2);
    expect(ran.stderr).toMatch(/^wilanis new: name the kind and the name or path to write/);
    expect(ran.stderr).toContain('wilanis new      <kind> <name|path>');
  });
});

describe('describe of a path that names no document', () => {
  it('says so on stderr and exits 1', { timeout: 60_000 }, () => {
    const ran = wilanis('describe', '@features/nowhere/nothing.port.json');
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe("no document at '@features/nowhere/nothing.port.json'\n");
  });

  it('still describes one that does, and exits 0', { timeout: 60_000 }, () => {
    const ran = wilanis('describe', 'project.json');
    expect(ran.code).toBe(0);
    expect(ran.stdout).toMatch(/^project {2}@project\.json\n/);
  });
});
