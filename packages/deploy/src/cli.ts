#!/usr/bin/env node
/**
 * wilanis-deploy [root] --profile <name> [--profile <name>]... [--target plan]: load and check a tree as `wilanis
 * manifest` does, build its manifest, and print the plan of the profiles asked for. Nothing is written into the
 * tree, and nothing is printed for a tree the checker refuses or a plan `planOf` refuses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import type { ProjectDoc } from '@wilanis/core';
import { declaredProfile, loadProject, manifestOf, type ProjectLoad } from '@wilanis/runtime';
import { type Plan, planOf, planText } from './plan.js';

const USAGE = `wilanis-deploy [root] --profile <name> [--profile <name>]... [--target plan]

Derives what one deployment of the tree is from its manifest (wilanis manifest): one workload per profile asked
for, with the command that starts it, the addresses it listens on, what it holds open, the variables it needs by
name and how it is probed; and every connection those profiles reach whose kind names an endpoint, which the
environment must provide. No variable's value is read, and none is printed.

  --profile <name>  a profile project.json declares; repeat it for each process the deployment runs. Required: a
                    deployment is of one place, and the asker knows which. A tree that declares no profile is
                    deployed with --profile ''.
  --target plan     the plan, as JSON on stdout (packages/deploy/schemas/plan.schema.json): the one target this
                    version renders, and the default. It is never written into the tree, whose loader reads every
                    *.json under the root.

The tree is loaded and checked first, as wilanis manifest does: a tree with refusals prints them and exits 1. So
does a profile that holds nothing, which would start and exit, and an address whose port the tree does not fix.`;

/** What each target prints, from the plan alone. */
const TARGETS: Record<string, (plan: Plan) => string> = { plan: planText };

/** The command line, read: the root, every profile asked for, every target, and whether only help was asked. */
interface Asked {
  roots: string[];
  profiles: string[];
  targets: string[];
  help: boolean;
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
  const [name, written] = (argv[at] ?? '').slice(2).split(/=(.*)/s);
  if (name === 'help') {
    asked.help = true;
    return at;
  }
  if (name !== 'profile' && name !== 'target') throw misused(`unknown flag --${name}`);
  const { value, next } = flagValue(argv, at, written);
  if (name === 'profile') asked.profiles.push(value);
  else asked.targets.push(...value.split(','));
  return next;
}

/** Every word of the command line, read in order: a flag and its value, or the root. */
function parse(argv: string[]): Asked {
  const asked: Asked = { roots: [], profiles: [], targets: [], help: false };
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at] ?? '';
    if (word.startsWith('--')) at = flagInto(asked, argv, at);
    else asked.roots.push(word);
  }
  return asked;
}

/** What each target asked for prints, refusing a command line with no profile, two roots, or a target not rendered. */
function renderersOf(asked: Asked): ((plan: Plan) => string)[] {
  if (!asked.profiles.length) throw misused('--profile is required: name the profile, or each profile, to deploy');
  if (asked.roots.length > 1) throw misused(`one root, not ${asked.roots.length}: ${asked.roots.join(', ')}`);
  const targets = asked.targets.length ? asked.targets : ['plan'];
  const unknown = targets.filter(target => !Object.hasOwn(TARGETS, target));
  if (unknown.length) {
    throw misused(`no target ${unknown.join(', ')}; this version renders: ${Object.keys(TARGETS).join(', ')}`);
  }
  return targets.map(target => TARGETS[target]);
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

async function main(): Promise<void> {
  const asked = parse(process.argv.slice(2));
  if (asked.help) {
    console.log(USAGE);
    return;
  }
  const renderers = renderersOf(asked);
  const root = asked.roots[0] ?? '.';
  const loaded = await checked(root);
  const profiles = asked.profiles.map(name => profileOf(loaded.registry.project?.doc, name));
  const manifest = manifestOf(loaded, { root });
  const plan = planOf(manifest, { profiles, image: imageOf(root, manifest.name) });
  for (const render of renderers) process.stdout.write(render(plan));
}

main().catch(error => {
  console.error((error as Error).message);
  process.exit(1);
});
