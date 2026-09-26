/**
 * Which profile a process runs under, and what that profile needs of the environment before anything starts
 * (RFC 0013). Every command that runs or stubs a tree picks its profile here, by one precedence; only `start`
 * and a reload go on to ask for the variables the profile's reach reads.
 */
import { reachOf } from '@wilanis/compiler';
import type { ProjectDoc, Scope } from '@wilanis/core';

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
export function unsetSecrets(scope: Scope, profile: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const unset = new Map<string, { key: string; readers: string[] }>();
  for (const secret of reachOf(scope, profile).secrets) {
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
export function secretsRefusal(scope: Scope, profile: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const unset = unsetSecrets(scope, profile, env);
  return unset.length ? `missing secrets: ${unset.join(', ')}` : undefined;
}
