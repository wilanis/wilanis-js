/**
 * What fires a trigger, in one line: the settings it writes, in words its kind's own document gives. The runtime
 * learns no kind's vocabulary here -- a route's `route` and a schedule's `cron` are read the same way, as fields
 * the kind declares -- so `wilanis map` and the viewer's `fired by` step say a new kind's settings the day it
 * ships, and say them alike.
 */
import type { Loaded, Scope, TriggerDoc } from '@wilanis/core';
import { LIMIT_SETTINGS } from './limits-said.js';

/** The types a kind may declare a setting of that say a value in a line, rather than name a type or hold parts. */
const SCALARS: readonly unknown[] = ['string', 'number', 'boolean'];

/**
 * The settings of one trigger that say when or where it fires: every one its kind declares a string, a number or
 * a boolean, in the order the kind declares them, each as `name value` with the value as written -- `cron
 * "0 3 * * *", timezone "UTC"`, `route "/customers", method "GET"`. A setting naming a type or holding parts of
 * its own is left to `describe`, and a bound to the line that says where it came from; empty for a trigger that
 * writes none, or whose kind the tree does not have.
 */
export function settingsSaid(trigger: Loaded<TriggerDoc>, scope: Scope): string {
  const written = trigger.doc.settings ?? {};
  const declared = scope.get('trigger-kind', trigger.doc.kind)?.doc.settings?.fields ?? {};
  const bounds: readonly string[] = LIMIT_SETTINGS;
  return Object.entries(declared)
    .filter(([name, field]) => SCALARS.includes(field.type) && name in written && !bounds.includes(name))
    .map(([name]) => `${name} ${JSON.stringify(written[name])}`)
    .join(', ');
}
