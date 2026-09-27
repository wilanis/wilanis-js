/**
 * What `planOf` refuses (RFC 0024), in the shape `wilanis start` refuses a variable nobody set: a sentence saying
 * what the manifest shows, then `→` and the edit that fixes it. Neither is a checker rule, and so neither has a
 * code: a tree that never deploys is not wrong for holding nothing, and a port nothing fixes is only wrong once
 * somebody asks for a container. Both are read off the manifest alone. A fixed host that is no wildcard is not
 * refused here: a plan is what the tree says, and only a published port makes a loopback bind wrong, so that one
 * belongs to the renderers that publish one.
 */
import type { Manifest } from '@wilanis/runtime';
import { sorted } from './order.js';

/** One profile's block of a manifest. */
type ProfileBlock = Manifest['profiles'][string];

/** What a deployed profile is for, said to the one who asked for a profile that holds nothing. */
const KEEPS_RUNNING =
  'a deployed profile keeps something running; deploy a profile whose startup opens a listener, a consumer or a ' +
  'scheduler, and run a one-shot profile with wilanis start';

/** A profile as a message names it: by its name, or as the unnamed one of a tree that declares none. */
const profileSaid = (profile: string): string => (profile === '' ? 'the unnamed profile' : `profile '${profile}'`);

/** A profile the manifest holds no block for, since it was printed for other profiles or the tree has none so named. */
function unknownProfile(manifest: Manifest, profile: string): string {
  const held = Object.keys(manifest.profiles).map(name => (name === '' ? "'' (the unnamed profile)" : name));
  return (
    `the manifest holds no ${profileSaid(profile)}; it holds ${held.length ? held.join(', ') : 'none'}\n` +
    '→ ask for one it holds, or plan from the manifest of every profile: wilanis manifest <root>, without --profile'
  );
}

/** A profile whose startup holds nothing open, which would start, answer and exit in a container. */
const holdsNothing = (profile: string): string =>
  `${profileSaid(profile)} holds nothing: every startup step it runs answers and ends\n→ ${KEEPS_RUNNING}`;

/** The startup steps that run an operation under a profile, as a message names them. */
function stepsSaid(manifest: Manifest, operation: string, profile: string): string {
  const steps = manifest.startup.filter(
    step => step.run === operation && (step.profiles === null || step.profiles.includes(profile)),
  );
  const labels = sorted(steps.flatMap(step => (step.label === null ? [] : [`'${step.label}'`])));
  return labels.length ? `the ${labels.join(' or ')} step` : 'its startup step';
}

/** The plugin that grants the port an operation is of, as a message names its settings. */
function settingsSaid(manifest: Manifest, operation: string): string {
  const path = operation.split('#')[0];
  const grantedBy = manifest.ports.native.find(port => port.path === path)?.grantedBy;
  return grantedBy ? `the ${grantedBy} plugin's settings` : 'the settings of the plugin that grants it';
}

/**
 * An address whose port nothing fixes: a secret supplies it, or nothing writes it and the port declares no default.
 * The manifest names the operation, the steps that run it and the plugin that grants it, but not the key under which
 * the step's `in` and the plugin's settings are read, so the hint names the command that prints it rather than a key
 * this package would have to know a plugin to guess.
 */
function portUnfixed(manifest: Manifest, operation: string, profile: string): string {
  const steps = stepsSaid(manifest, operation, profile);
  const settings = settingsSaid(manifest, operation);
  const port = operation.split('#')[0];
  return (
    `'${operation}' listens on a port this tree does not fix under ${profileSaid(profile)}: neither ${steps}'s ` +
    `"in" nor ${settings} give it as a number\n` +
    `→ write the port as a number in ${steps}'s "in", or in ${settings}; wilanis describe ${port} names the key each ` +
    'is read from'
  );
}

/** Everything one profile's block is refused for: holding nothing, and every address whose port is not fixed. */
function refusalsOfBlock(manifest: Manifest, profile: string, block: ProfileBlock): string[] {
  const unfixed = block.listens.filter(row => row.port === null).map(row => row.operation);
  return [
    ...(block.holds.length ? [] : [holdsNothing(profile)]),
    ...sorted(unfixed).map(operation => portUnfixed(manifest, operation, profile)),
  ];
}

/**
 * Every refusal of a plan of these profiles, in the order the profiles are given, each a message and its hint: a
 * profile the manifest holds no block for, a profile that holds nothing, and an address whose port nothing fixes.
 * Nothing where the plan may be made.
 */
export function refusalsOf(manifest: Manifest, profiles: string[]): string[] {
  return profiles.flatMap(profile => {
    const block = Object.hasOwn(manifest.profiles, profile) ? manifest.profiles[profile] : undefined;
    return block ? refusalsOfBlock(manifest, profile, block) : [unknownProfile(manifest, profile)];
  });
}
