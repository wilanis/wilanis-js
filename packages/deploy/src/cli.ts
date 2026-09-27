#!/usr/bin/env node
/**
 * wilanis-deploy [root] --profile <name> [--profile <name>]... [--target image,compose,helm,plan] [-o <dir>]
 * [--check] [--force]: load and check a tree as `wilanis manifest` does, build its manifest and the plan of the
 * profiles asked for, and render each target -- the files into `-o`, the plan onto stdout. Every target is rendered
 * before anything is written or printed, so a refusal of any leaves the directory as it was and prints no plan.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import type { ProjectDoc } from '@wilanis/core';
import { declaredProfile, loadProject, manifestOf, type ProjectLoad } from '@wilanis/runtime';
import { composeFiles } from './compose.js';
import { helmFiles } from './helm.js';
import { imageFiles } from './image.js';
import { type Plan, planOf, planText } from './plan.js';
import { reported } from './report.js';
import { type Rendered, shellWord, stamped, writeInto } from './write.js';

const USAGE = `wilanis-deploy [root] --profile <name> [--profile <name>]... [--target image,compose,helm,plan]
               [-o <dir>] [--check] [--force]

Derives what one deployment of the tree is from its manifest (wilanis manifest) -- one workload per profile asked
for, with the command that starts it, the addresses it listens on, what it holds open, the variables it needs by
name and how it is probed, and every connection those profiles reach whose kind names an endpoint -- and renders
it. No variable's value is read, and none is written or printed.

  --profile <name>  a profile project.json declares; repeat it for each process the deployment runs. Required: a
                    deployment is of one place, and the asker knows which. A tree that declares no profile is
                    deployed with --profile ''.
  --target <list>   what to render, comma-separated; image,compose where none is named.
                      image    Dockerfile and Dockerfile.dockerignore: the one image every workload runs
                      compose  compose.yaml, one service per workload, and .env.example, which names every
                               variable and holds no value
                      helm     values.yaml, the values of the chart charts/wilanis-tree: one Deployment per
                               workload, a Service for each that listens, the Secret's keys by name
                      plan     the plan, as JSON on stdout (packages/deploy/schemas/plan.schema.json); never
                               written into the tree, whose loader reads every *.json under the root
  -o <dir>          where the files go, inside the tree; <root>/deploy where it is not given. The image is built
                    from the root either way.
  --check           write nothing; exit 1 naming every file a write would change, as CI runs it.
  --force           overwrite a file whose first line is not the generated header, which is otherwise kept.

The tree is loaded and checked first, as wilanis manifest does: a tree with refusals prints them and exits 1. So
does a profile that holds nothing, which would start and exit; an address whose port the tree does not fix; and,
for compose and helm, an address bound to an interface nothing outside the container reaches. stdout carries the
plan and nothing else; what was written, and what would change, is said on stderr.`;

/** What a target renders from the plan alone: text for stdout, or files for the directory. */
type Target = { print: (plan: Plan) => string } | { files: (plan: Plan) => Rendered[] };

/** Every target this version renders. */
const TARGETS: Record<string, Target> = {
  image: { files: imageFiles },
  compose: { files: composeFiles },
  helm: { files: helmFiles },
  plan: { print: planText },
};

/** What is rendered where no target is named: the image and the Compose file beside it. */
const DEFAULT_TARGETS = ['image', 'compose'];

/** The flags that take no value. */
const SWITCHES = ['help', 'check', 'force'] as const;

/** The command line, read: the root, every profile and target asked for, where the files go, and each switch. */
interface Asked {
  roots: string[];
  profiles: string[];
  targets: string[];
  out: string | undefined;
  help: boolean;
  check: boolean;
  force: boolean;
}

/** A refusal of the command line itself, said with the usage beneath it. */
const misused = (reason: string): Error => new Error(`${reason}\n\n${USAGE}`);

/** What a flag is given: what follows its `=`, else the next word; and the index the reading resumes after. */
function flagValue(argv: string[], at: number, written: string | undefined): { value: string; next: number } {
  if (written !== undefined) return { value: written, next: at };
  const following = argv[at + 1];
  if (following === undefined || following.startsWith('--')) throw misused(`${argv[at]} needs a value`);
  return { value: following, next: at + 1 };
}

/** One flag of the command line, added to what was asked; answers the index the reading resumes after. */
function flagInto(asked: Asked, argv: string[], at: number): number {
  const word = argv[at] ?? '';
  const [name = '', written] = (word.startsWith('--') ? word.slice(2) : word.slice(1)).split(/=(.*)/s);
  const switched = SWITCHES.find(one => one === name && word.startsWith('--'));
  if (switched) {
    asked[switched] = true;
    return at;
  }
  const valued = word.startsWith('--') ? ['profile', 'target'] : ['o'];
  if (!valued.includes(name)) throw misused(`unknown flag ${word}`);
  const { value, next } = flagValue(argv, at, written);
  if (name === 'profile') asked.profiles.push(value);
  else if (name === 'target') asked.targets.push(...value.split(','));
  else asked.out = value;
  return next;
}

/** Every word of the command line, read in order: a flag and its value, or the root. */
function parse(argv: string[]): Asked {
  const asked: Asked = {
    roots: [],
    profiles: [],
    targets: [],
    out: undefined,
    help: false,
    check: false,
    force: false,
  };
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at] ?? '';
    if (word.startsWith('-')) at = flagInto(asked, argv, at);
    else asked.roots.push(word);
  }
  return asked;
}

/** The targets asked for, each once, refusing a command line with no profile, two roots, or a target not rendered. */
function targetsOf(asked: Asked): string[] {
  if (!asked.profiles.length) throw misused('--profile is required: name the profile, or each profile, to deploy');
  if (asked.roots.length > 1) throw misused(`one root, not ${asked.roots.length}: ${asked.roots.join(', ')}`);
  const targets = [...new Set(asked.targets.length ? asked.targets : DEFAULT_TARGETS)];
  const unknown = targets.filter(target => !Object.hasOwn(TARGETS, target));
  if (unknown.length) {
    throw misused(`no target ${unknown.join(', ')}; this version renders: ${Object.keys(TARGETS).join(', ')}`);
  }
  return targets;
}

/** The tree loaded and judged, as `wilanis manifest` judges it first; throws its refusals as `check` prints them. */
async function checked(root: string): Promise<ProjectLoad> {
  const abs = resolve(root);
  if (!existsSync(join(abs, 'project.json'))) throw new Error(`no project.json in ${abs}`);
  const loaded = await loadProject(abs);
  const answer = checkTree(loaded);
  if (!answer.ok) throw new Error(`${answer.format()}\n\n${answer.items.length} refusal(s)`);
  return loaded;
}

/** A profile asked for, held to those project.json declares (RFC 0013); `''` is the unnamed one of a tree with none. */
function profileOf(project: ProjectDoc | undefined, name: string): string {
  if (name === '' && !Object.keys(project?.profiles ?? {}).length) return name;
  return declaredProfile(project, name);
}

/** The reference the image is tagged with: the tree's name, and the version its package.json gives, else latest. */
function imageOf(root: string, name: string): string {
  const file = join(resolve(root), 'package.json');
  const version: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : undefined;
  return `${name}:${typeof version === 'string' && version ? version : 'latest'}`;
}

/** A path as a message and a header write it: from the directory the command runs in, with forward slashes. */
const shown = (path: string): string => relative(process.cwd(), resolve(path)).split(sep).join('/') || '.';

/**
 * Where the command was asked to work: the root and the directory the files go into, each as a message shows it.
 * Refuses a directory outside the tree: the image is built from the tree's root, and the Compose file names that
 * root from where it sits, which from outside the tree would be a path through a directory the plan cannot name.
 */
function placesOf(asked: Asked): { root: string; out: string; outGiven: boolean } {
  const root = shown(asked.roots[0] ?? '.');
  const out = shown(asked.out ?? join(root, 'deploy'));
  const within = relative(resolve(root), resolve(out));
  if (within.startsWith('..') || isAbsolute(within)) {
    throw misused(
      `-o ${out} is outside the tree at ${root}: the files are written inside it, where they name its root`,
    );
  }
  return { root, out, outGiven: out !== shown(join(root, 'deploy')) };
}

/** Every file the file targets render, each with the header that names the command rendering it again. */
function filesOf(plan: Plan, targets: string[], places: ReturnType<typeof placesOf>): Rendered[] {
  const profiles = plan.workloads.map(workload => workload.profile);
  return targets.flatMap(target => {
    const renders = TARGETS[target];
    if (!renders || !('files' in renders)) return [];
    const flags = [
      ...(DEFAULT_TARGETS.includes(target) ? [] : ['--target', target]),
      ...(places.outGiven ? ['-o', places.out] : []),
    ];
    return renders.files(plan).map(file => stamped(file, { root: places.root, profiles, flags }));
  });
}

/** What the print targets print, one after another. */
const printedOf = (plan: Plan, targets: string[]): string =>
  targets
    .map(target => TARGETS[target])
    .map(renders => (renders && 'print' in renders ? renders.print(plan) : ''))
    .join('');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asked = parse(argv);
  if (asked.help) {
    console.log(USAGE);
    return;
  }
  const targets = targetsOf(asked);
  const places = placesOf(asked);
  const loaded = await checked(places.root);
  const profiles = asked.profiles.map(name => profileOf(loaded.registry.project?.doc, name));
  const manifest = manifestOf(loaded, { root: asked.roots[0] ?? '.' });
  const dockerfile = relative(resolve(places.root), resolve(places.out, 'Dockerfile')).split(sep).join('/');
  const plan = planOf(manifest, { profiles, image: imageOf(places.root, manifest.name), dockerfile });
  const files = filesOf(plan, targets, places);
  const printed = printedOf(plan, targets);
  const written = files.length ? writeInto(places.out, files, asked) : { ok: true, said: [], refused: false };
  const again = argv.filter(word => word !== '--check').map(shellWord);
  if (files.length) console.error(reported({ plan, targets, places, written, check: asked.check, again }));
  if (!written.ok) process.exitCode = 1;
  else process.stdout.write(printed);
}

main().catch(error => {
  console.error((error as Error).message);
  process.exit(1);
});
