/**
 * Which profile a process runs under, what that profile needs of the environment before anything starts
 * (RFC 0013), and which triggers it serves. Every command that runs or stubs a tree picks its profile here, by
 * one precedence; only `start` and a reload go on to ask for the variables the profile's reach reads. A command
 * that fires triggers under the profile fires only those it walks (`walkedUnder`), since those are the ones the
 * checker judged there: `run` refuses one it does not, and `rehearse`, `fuzz` and `regress` skip them and say so.
 */
import { type ReachedSecret, reachOf, servedUnder, walkedUnder } from '@wilanis/compiler';
import type { Loaded, ProjectDoc, Scope, TriggerDoc } from '@wilanis/core';

/** The variable that names the profile when no `--profile` was given. */
export const PROFILE_VARIABLE = 'WILANIS_PROFILE';

/** The declared profiles as a message lists them, the default marked. */
function listed(project: ProjectDoc | undefined): string {
  const names = Object.entries(project?.profiles ?? {}).map(([name, one]) =>
    one.default ? `${name} (default)` : name,
  );
  return names.length ? names.join(', ') : 'none';
}

/** A name given on the command line or in the environment, held to the profiles the project declares. */
export function declaredProfile(project: ProjectDoc | undefined, name: string): string {
  if (project?.profiles?.[name]) return name;
  throw new Error(`no profile '${name}'; project.json declares: ${listed(project)}`);
}

/**
 * The profile this process runs under, or nothing for the unnamed profile of a project that declares none:
 * `--profile`, else `WILANIS_PROFILE` (an empty one is unset), else the one profile marked `default`, else --
 * where none is declared -- the unnamed profile. Throws for a name the project does not declare, and for a
 * project that declares profiles and gives no way to choose one.
 */
export function activeProfile(
  project: ProjectDoc | undefined,
  given: { flag?: string; env: NodeJS.ProcessEnv },
): string | undefined {
  const named = given.flag || given.env[PROFILE_VARIABLE];
  if (named) return declaredProfile(project, named);
  const profiles = Object.entries(project?.profiles ?? {});
  if (!profiles.length) return undefined;
  const defaults = profiles.filter(([, one]) => one.default === true).map(([name]) => name);
  if (defaults.length === 1) return defaults[0];
  const marks = defaults.length ? `marks ${defaults.join(' and ')} default` : 'marks none default';
  throw new Error(
    `which profile? project.json declares ${profiles.map(([name]) => name).join(', ')} and ${marks}\n` +
      `→ --profile <name>, or set ${PROFILE_VARIABLE}, or mark one profile "default": true`,
  );
}

/**
 * Every variable the profile's reach reads and the environment does not set, each once, with the secret key it
 * backs and who reads it: `VAR (key, read by <document or '@plugin settings'>)`. Variables are named, values
 * never. A key the project does not map to a variable is the checker's (C001, B007), not the environment's.
 */
export function unsetSecrets(
  scope: Scope,
  profile: string | undefined,
  env: NodeJS.ProcessEnv,
  also: ReachedSecret[] = [],
): string[] {
  const unset = new Map<string, { key: string; readers: string[] }>();
  for (const secret of [...reachOf(scope, profile).secrets, ...also]) {
    if (secret.variable === undefined || env[secret.variable] !== undefined) continue;
    const seen = unset.get(secret.variable) ?? { key: secret.key, readers: [] };
    if (!seen.readers.includes(secret.readBy)) seen.readers.push(secret.readBy);
    unset.set(secret.variable, seen);
  }
  return [...unset].map(([variable, { key, readers }]) => `${variable} (${key}, read by ${readers.join(', ')})`);
}

/**
 * Why a profile may not be served in this environment -- the variables its reach reads and nobody set -- or
 * nothing. `start` says it before any postLoad and adds that nothing is serving; a reload says it and keeps
 * the last good tree.
 */
export function secretsRefusal(
  scope: Scope,
  profile: string | undefined,
  env: NodeJS.ProcessEnv,
  also: ReachedSecret[] = [],
): string | undefined {
  const unset = unsetSecrets(scope, profile, env, also);
  return unset.length ? `missing secrets: ${unset.join(', ')}` : undefined;
}

/** The profiles whose startup serves a trigger, in the project's order. */
function serving(scope: Scope, trigger: TriggerDoc): string[] {
  return scope.profiles().filter(one => servedUnder(scope, trigger, one));
}

/**
 * Why `wilanis run` will not fire a trigger under a profile that does not serve it -- the kind no step of its
 * startup serves, and the profiles that serve it -- or nothing where the profile walks it (`walkedUnder`).
 */
export function unservedRefusal(
  scope: Scope,
  trigger: Loaded<TriggerDoc>,
  profile: string | undefined,
): string | undefined {
  if (walkedUnder(scope, trigger.doc, profile)) return undefined;
  const others = serving(scope, trigger.doc);
  return (
    `profile '${profile}' does not serve ${trigger.path}: no startup step it runs serves kind ` +
    `'${trigger.doc.kind}' (served under ${others.join(', ')})\n` +
    `→ --profile ${others[0]}, or run the step that serves the kind under '${profile}' too`
  );
}

/**
 * What a command firing every trigger under a profile says of the ones it left out: a line per set of profiles
 * serving them, how many and where they are served; nothing where it left none out. `triggers` holds the trigger
 * of each thing the command would have run, once per thing, so a count of scenarios counts scenarios.
 */
export function skippedLines(
  scope: Scope,
  profile: string | undefined,
  triggers: Loaded<TriggerDoc>[],
  what: string,
): string[] {
  const counts = new Map<string, number>();
  for (const trigger of triggers) {
    if (walkedUnder(scope, trigger.doc, profile)) continue;
    const others = serving(scope, trigger.doc).join(', ');
    counts.set(others, (counts.get(others) ?? 0) + 1);
  }
  return [...counts].map(
    ([others, count]) => `skipped ${count} ${what} profile '${profile}' does not serve (served under ${others})`,
  );
}
