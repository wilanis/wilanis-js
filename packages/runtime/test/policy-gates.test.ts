/**
 * `triggersGatedBy`: which triggers a policy gates, the one answer `describe`, the viewer's policy page and the
 * manifest's policy rows all ask. Read over a registry built by hand, so the case is the matching and the order and
 * nothing a loader adds.
 */
import { type Loaded, type PolicyRef, Registry, Scope, schemaRef, type TriggerDoc } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { triggersGatedBy } from '../src/index.js';

const SIGNED_IN = '@features/access/edge/signed-in.policy.json';
const EMPLOYEES = '@features/access/edge/employees-only.policy.json';

/** One trigger of the shop feature, attaching the policies given, or none. */
function trigger(name: string, policies?: PolicyRef[]): Loaded<TriggerDoc> {
  const doc: TriggerDoc = {
    $schema: schemaRef('trigger'),
    description: `the ${name} route`,
    kind: '@http/route.trigger-kind.json',
    settings: {},
    fire: { run: `@features/shop/domain/shop.port.json#${name}` },
    ...(policies ? { policies } : {}),
  };
  return {
    kind: 'trigger',
    path: `@features/shop/edge/${name}.trigger.json`,
    name,
    feature: 'shop',
    layer: 'edge',
    doc,
  };
}

/** A scope over the triggers given, in that order, with `@access` the alias the project declares for the feature. */
function scopeOf(triggers: Loaded<TriggerDoc>[]): Scope {
  const registry = new Registry();
  for (const one of triggers) registry.add(one);
  return new Scope(registry, ref => ref.replace(/^@access\//, '@features/access/'));
}

const gated = (scope: Scope, policy: string) => triggersGatedBy(scope, policy).map(one => one.name);

describe('which triggers a policy gates', () => {
  const scope = scopeOf([
    trigger('list', [SIGNED_IN]),
    trigger('browse'),
    trigger('delete', [
      { policy: '@access/edge/employees-only.policy.json', in: { token: '{{context.headers.authorization}}' } },
      '@access/edge/signed-in.policy.json',
    ]),
    trigger('export', [{ policy: SIGNED_IN }]),
    trigger('archive', []),
  ]);

  it('matches a policy named bare or with its inputs, by its canonical path or through an alias', () => {
    expect(gated(scope, SIGNED_IN).sort()).toEqual(['delete', 'export', 'list']);
    expect(gated(scope, EMPLOYEES)).toEqual(['delete']);
  });

  it('answers in the order the registry holds the triggers, which is the order describe says them in', () => {
    expect(gated(scope, SIGNED_IN)).toEqual(['list', 'delete', 'export']);
  });

  it('answers nothing for a policy no trigger names, and never a trigger that attaches none', () => {
    expect(gated(scope, '@features/access/edge/otp-verified.policy.json')).toEqual([]);
    const names = [SIGNED_IN, EMPLOYEES].flatMap(policy => gated(scope, policy));
    expect(names).not.toContain('browse');
    expect(names).not.toContain('archive');
  });

  it('matches the canonical path only, so an alias handed in as the policy names nothing', () => {
    expect(gated(scope, '@access/edge/signed-in.policy.json')).toEqual([]);
  });
});
