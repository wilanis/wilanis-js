/**
 * RFC 0024's command, step 3, from the built package over the example: the usage where no profile is asked for, RFC
 * 0013's message for a profile the tree does not declare, the checker's refusals and nothing written for a tree that
 * fails check, and the plan on stdout as JSON the published schema accepts.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const DEPLOY = fileURLToPath(new URL('..', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const planValid = new Ajv2020({ allErrors: true }).compile(read(join(DEPLOY, 'schemas/plan.schema.json')));

/** The command from the built package, run in `dir`: its exit code and what it wrote on each stream. */
function deploy(dir: string, ...args: string[]) {
  const ran = spawnSync(process.execPath, [join(DEPLOY, 'bin/wilanis-deploy.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

/** Every path under a directory, `node_modules` aside, sorted: what a command that writes nothing leaves as it was. */
const pathsUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(path => !path.startsWith('node_modules'))
    .sort();

/** Every file directly under a directory with its text, by name: what a command that writes nothing leaves as it was. */
const contentsUnder = (dir: string): [string, string][] =>
  readdirSync(dir)
    .sort()
    .map(name => [name, readFileSync(join(dir, name), 'utf8')]);

/** The profiles project.json declares, as RFC 0013's message lists them, the default marked. */
function declared(): string {
  const profiles: Record<string, { default?: boolean }> = read(join(EXAMPLE, 'project.json')).profiles;
  return Object.entries(profiles)
    .map(([name, one]) => (one.default ? `${name} (default)` : name))
    .join(', ');
}

describe('wilanis-deploy', () => {
  it('exits 1 with the usage where no profile is asked for, and prints nothing on stdout', () => {
    const ran = deploy(join(EXAMPLE, '..'), 'example');
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toMatch(/^--profile is required/);
    expect(ran.stderr).toContain(
      'wilanis-deploy [root] --profile <name> [--profile <name>]... [--target image,compose,plan] [-o <dir>]',
    );
  });

  it('exits 1 naming the targets it renders where a target is not one of them', () => {
    const ran = deploy(join(EXAMPLE, '..'), 'example', '--profile', 'production', '--target', 'helm');
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toMatch(/^no target helm; this version renders: image, compose, plan\n/);
  });

  it('exits 1 with RFC 0013’s message where no profile has the name, and prints no plan', { timeout: 60_000 }, () => {
    const ran = deploy(join(EXAMPLE, '..'), 'example', '--profile', 'staging');
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr.trim()).toBe(`no profile 'staging'; project.json declares: ${declared()}`);
  });

  it('prints the refusals of a tree that fails check, as check does, writes nothing, and exits 1', {
    timeout: 60_000,
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-deploy-'));
    try {
      cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
      symlinkSync(join(EXAMPLE, '../node_modules'), join(dir, 'node_modules'));
      const feature = join(dir, 'features/customers/feature.json');
      const doc = read(feature);
      doc.effects = doc.effects.filter((one: string) => one !== '@http/http.port.json#request');
      writeFileSync(feature, JSON.stringify(doc, null, 2));
      const before = pathsUnder(dir);
      const ran = deploy(dir, '.', '--profile', 'production');
      expect(ran.code).toBe(1);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toMatch(/^L003 {2}/);
      expect(ran.stderr).toMatch(/\d+ refusal\(s\)\n$/);
      expect(pathsUnder(dir)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the example’s checked-in deploy/ as the tree renders it, as CI checks it', { timeout: 60_000 }, () => {
    const ran = deploy(
      join(EXAMPLE, '..'),
      'example',
      '--profile',
      'production',
      '--target',
      'image,compose',
      '--check',
    );
    expect(ran).toEqual({ code: 0, stdout: '', stderr: 'example/deploy: every file is as the tree renders it\n' });
  });

  it('prints the plan with --target plan as JSON the published schema accepts, and writes no file', {
    timeout: 60_000,
  }, () => {
    const generated = contentsUnder(join(EXAMPLE, 'deploy'));
    const ran = deploy(
      join(EXAMPLE, '..'),
      'example',
      '--profile',
      'production',
      '--profile',
      'live',
      '--target',
      'plan',
    );
    expect(ran.stderr).toBe('');
    expect(ran.code).toBe(0);
    const plan = JSON.parse(ran.stdout);
    expect(planValid(plan) ? [] : planValid.errors).toEqual([]);
    expect(plan.image.reference).toBe(`customers:${read(join(EXAMPLE, 'package.json')).version}`);
    expect(plan.workloads.map((one: { profile: string }) => one.profile)).toEqual(['live', 'production']);
    expect(contentsUnder(join(EXAMPLE, 'deploy'))).toEqual(generated);
  });
});
