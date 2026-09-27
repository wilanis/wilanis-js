/**
 * The addresses a profile listens on (RFC 0024), as the manifest prints them under `profiles.<name>.listens`: one
 * row per startup step that runs under the profile whose operation's port document declares `listens`, each part of
 * the address read from the places that declaration names, in the order the handler reads them. It is read off the
 * documents alone: it never runs a handler, never reads the environment and never reads the clock, so a port a
 * secret supplies is one the tree does not fix.
 */
import { type Bound, runsUnder, type Scope, type StartupStep } from '@wilanis/core';
import { type Place, placesOf } from './address-said.js';
import { sortedBy } from './manifest-rows.js';

/** One address a profile listens on: the operation that binds it, the interface, and the port. */
export interface ListenRow {
  operation: string;
  /** The interface as written: a literal, or a `{{secrets.*}}` read kept as its text; null for every interface. */
  host: string | null;
  /** The port, where the tree fixes one; null where a secret supplies it or nothing does. */
  port: number | null;
}

/** What one place holds for a step: the step's `in`, the plugin's settings, or the declared default. */
function valueIn(place: Place, step: StartupStep, settings: Record<string, unknown>): unknown {
  if ('input' in place) return step.in?.[place.input];
  if ('setting' in place) return settings[place.setting];
  return place.default;
}

/**
 * The first place that writes a part, as written: the handler takes the step's value over the plugin's and the
 * plugin's over the default, and so does this, a value that is not a literal among them. Nothing where none does.
 */
function written(bound: Bound<unknown> | undefined, step: StartupStep, settings: Record<string, unknown>): unknown {
  const values = (bound ? placesOf(bound) : []).map(place => valueIn(place, step, settings));
  return values.find(value => value !== undefined && value !== null);
}

/** A port the tree fixes: a whole number written literally. A template is the environment's, and 0 asks for any. */
const portOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

/** An interface the tree writes, a secret read among them; an empty one binds every interface, as none does. */
const hostOf = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The settings project.json gives the plugin that grants a port; none for a port no plugin grants. */
const settingsOf = (scope: Scope, use: string | undefined): Record<string, unknown> =>
  scope.project?.plugins.find(plugin => use !== undefined && plugin.use === use)?.settings ?? {};

/** The address one step binds, where the operation it runs declares `listens`; nothing where it does not. */
function listenRow(scope: Scope, step: StartupStep): ListenRow | undefined {
  const hit = scope.op(step.run);
  if (typeof hit === 'string' || !hit.op.listens) return undefined;
  const settings = settingsOf(scope, hit.port.native);
  const { port, host } = hit.op.listens;
  return {
    operation: `${hit.path}#${hit.opName}`,
    host: hostOf(written(host, step, settings)),
    port: portOf(written(port, step, settings)),
  };
}

/**
 * Every address the tree listens on under a profile (the unnamed one where `profile` is absent), by operation and,
 * for two steps that run one, in the order the steps are declared. Each part is the step's `in.<input>`, else the
 * granting plugin's `settings.<setting>`, else the declared `default`, else null: a port only where a number is
 * written, a host where any string is, a `{{secrets.*}}` read kept as its text.
 */
export function listensOf(scope: Scope, profile?: string): ListenRow[] {
  const steps = (scope.project?.startup ?? []).filter(step => runsUnder(step, profile));
  return sortedBy(
    steps.flatMap(step => listenRow(scope, step) ?? []),
    row => row.operation,
  );
}
