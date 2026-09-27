/**
 * RFC 0024's writer, step 4, against temporary directories: files written into a clean directory and then judged
 * unchanged by `--check`; a changed port that `--check` names and does not write; a file whose header was removed,
 * kept without `--force` and replaced with it; and a tree every target has written into, which `wilanis check` still
 * reads as it did -- the regression that would catch a target writing a `.json` the loader would take for a document.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree } from '@wilanis/compiler';
import { loadProject } from '@wilanis/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { GENERATED, type Rendered, writeInto } from '../src/index.js';

const DEPLOY = fileURLToPath(new URL('..', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const made: string[] = [];

/** A fresh temporary directory, removed after the case. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-deploy-write-'));
  made.push(dir);
  return dir;
}

/** A copy of the example with none of its generated files, its node_modules the workspace's, to write into. */
function exampleCopy(): string {
  const dir = scratch();
  const kept = (path: string) => !/^(node_modules|deploy)(\/|$)/.test(relative(EXAMPLE, path));
  cpSync(EXAMPLE, dir, { recursive: true, filter: kept });
  symlinkSync(join(EXAMPLE, '../node_modules'), join(dir, 'node_modules'));
  return dir;
}

/** The command from the built package, run in `dir`: its exit code and what it wrote on each stream. */
function deploy(dir: string, ...args: string[]) {
  const ran = spawnSync(process.execPath, [join(DEPLOY, 'bin/wilanis-deploy.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

/** Every file under a directory with its text, sorted by path: what a command that writes nothing leaves as it was. */
const contentsUnder = (dir: string): [string, string][] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8', withFileTypes: false })
    .filter(path => !path.startsWith('node_modules'))
    .sort()
    .flatMap(path => {
      try {
        return [[path, readFileSync(join(dir, path), 'utf8')] as [string, string]];
      } catch {
        return [];
      }
    });

const FILES: Rendered[] = [
  {
    path: 'Dockerfile',
    contents: `${GENERATED} from . (profile production) -- do not edit\n# regenerate: x\nFROM a\n`,
  },
  {
    path: 'compose.yaml',
    contents: `${GENERATED} from . (profile production) -- do not edit\n# regenerate: x\nb: 1\n`,
  },
];
const WRITE = { check: false, force: false };
const CHECK = { check: true, force: false };

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('writeInto', () => {
  it('writes every file into a clean directory, and a check then finds nothing to change', () => {
    const dir = scratch();
    const out = join(dir, 'deploy');
    expect(writeInto(out, FILES, WRITE)).toEqual({
      ok: true,
      refused: false,
      said: [`wrote ${join(out, 'Dockerfile')}`, `wrote ${join(out, 'compose.yaml')}`],
    });
    expect(readFileSync(join(out, 'compose.yaml'), 'utf8')).toBe(FILES[1]?.contents);
    expect(writeInto(out, FILES, CHECK)).toEqual({ ok: true, refused: false, said: [] });
    expect(writeInto(out, FILES, WRITE).said).toEqual([
      `unchanged ${join(out, 'Dockerfile')}`,
      `unchanged ${join(out, 'compose.yaml')}`,
    ]);
  });

  it('checks without writing: a file not there, and the first line a changed one differs at', () => {
    const dir = scratch();
    writeInto(dir, FILES.slice(1), WRITE);
    const changed = FILES.map(file => ({ ...file, contents: file.contents.replace(/\n[^\n]*\n$/, '\nb: 2\n') }));
    expect(writeInto(dir, changed, CHECK)).toEqual({
      ok: false,
      refused: false,
      said: [
        `${join(dir, 'Dockerfile')} would be written`,
        `${join(dir, 'compose.yaml')} would change at line 3: b: 1 → b: 2`,
      ],
    });
    expect(readdirSync(dir)).toEqual(['compose.yaml']);
    expect(readFileSync(join(dir, 'compose.yaml'), 'utf8')).toBe(FILES[1]?.contents);
  });

  it('keeps a file whose header was removed, naming --force, writes nothing else, and replaces it with --force', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:22\nRUN apk add --no-cache git\n');
    const refused = writeInto(dir, FILES, WRITE);
    expect(refused.ok).toBe(false);
    expect(refused.refused).toBe(true);
    expect(refused.said).toEqual([
      `${join(dir, 'Dockerfile')} is not one wilanis-deploy wrote: its first line is not the generated header, so it ` +
        'is left as it is\n→ to keep it, render only the other targets with --target; to replace it with the ' +
        'generated one, pass --force',
    ]);
    expect(readdirSync(dir)).toEqual(['Dockerfile']);
    expect(readFileSync(join(dir, 'Dockerfile'), 'utf8')).toContain('apk add');
    expect(writeInto(dir, FILES, CHECK).refused).toBe(true);
    expect(writeInto(dir, FILES, { check: true, force: true }).said[0]).toBe(
      `${join(dir, 'Dockerfile')} would be overwritten, though wilanis-deploy did not write it`,
    );
    expect(writeInto(dir, FILES, { check: false, force: true }).ok).toBe(true);
    expect(readFileSync(join(dir, 'Dockerfile'), 'utf8')).toBe(FILES[0]?.contents);
  });
});

describe('wilanis-deploy, writing into a tree', () => {
  it('writes the default targets into <root>/deploy, and --check then exits 0', { timeout: 120_000 }, () => {
    const dir = exampleCopy();
    const wrote = deploy(dir, '.', '--profile', 'production');
    expect(wrote.stderr).toMatch(/^plan: 1 workload \(production\), 1 port, 3 variables, 0 hosts required\n/);
    expect(wrote.code).toBe(0);
    expect(wrote.stdout).toBe('');
    expect(readdirSync(join(dir, 'deploy')).sort()).toEqual([
      '.env.example',
      'Dockerfile',
      'Dockerfile.dockerignore',
      'compose.yaml',
    ]);
    const checked = deploy(dir, '.', '--profile', 'production', '--target', 'image,compose', '--check');
    expect(checked).toEqual({ code: 0, stdout: '', stderr: 'deploy: every file is as the tree renders it\n' });
  });

  it('exits 1 from --check naming compose.yaml where the port changed, and writes nothing', {
    timeout: 120_000,
  }, () => {
    const dir = exampleCopy();
    expect(deploy(dir, '.', '--profile', 'production').code).toBe(0);
    const project = join(dir, 'project.json');
    writeFileSync(project, readFileSync(project, 'utf8').replace('"port": 8099', '"port": 9090'));
    const before = contentsUnder(join(dir, 'deploy'));
    const checked = deploy(dir, '.', '--profile', 'production', '--check');
    expect(checked.code).toBe(1);
    expect(checked.stdout).toBe('');
    expect(checked.stderr).toContain(
      'deploy/compose.yaml would change at line 11: ports: ["8099:8099"] → ports: ["9090:9090"]',
    );
    expect(checked.stderr).toMatch(/\n→ npx wilanis-deploy \. --profile production\n$/);
    expect(contentsUnder(join(dir, 'deploy'))).toEqual(before);
  });

  it('writes where -o says, building from the root, and says -o in the command that renders the files again', {
    timeout: 120_000,
  }, () => {
    const dir = exampleCopy();
    expect(deploy(dir, '.', '--profile', 'production', '-o', 'ops/compose').code).toBe(0);
    const compose = readFileSync(join(dir, 'ops/compose/compose.yaml'), 'utf8');
    expect(compose.split('\n').slice(1, 8)).toEqual([
      '# regenerate: npx wilanis-deploy . --profile production -o ops/compose',
      'name: "customers"',
      'services:',
      '  customers-production:',
      '    build:',
      '      context: "../.."',
      '      dockerfile: "ops/compose/Dockerfile"',
    ]);
  });

  it('refuses -o outside the tree before it loads anything, and writes nothing', { timeout: 120_000 }, () => {
    const dir = exampleCopy();
    const ran = deploy(dir, '.', '--profile', 'production', '-o', '../elsewhere');
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(/^-o \.\.\/elsewhere is outside the tree at \.: the files are written inside it/);
    expect(readdirSync(join(dir, '..'))).not.toContain('elsewhere');
  });

  it('leaves a tree every target wrote into as wilanis check reads it, with no .json in it', {
    timeout: 120_000,
  }, async () => {
    const dir = exampleCopy();
    const before = checkTree(await loadProject(dir));
    const ran = deploy(
      dir,
      '.',
      '--profile',
      'production',
      '--profile',
      'production-worker',
      '--target',
      'image,compose,plan',
    );
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout).workloads).toHaveLength(2);
    expect(readdirSync(join(dir, 'deploy')).filter(path => path.endsWith('.json'))).toEqual([]);
    const after = checkTree(await loadProject(dir));
    expect(after.ok).toBe(true);
    expect(after.format()).toBe(before.format());
  });
});
