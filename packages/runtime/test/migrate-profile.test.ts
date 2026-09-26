/**
 * Which profile `wilanis migrate` plans under: the one `start` would run, by RFC 0013's precedence through
 * `activeProfile`, said on its first line and handed to every plugin's migrate member -- for a plan, an apply and
 * the history alike -- so the connection behind a store and the secrets asked for are the ones the tree starts with.
 */
import { rmSync } from 'node:fs';
import { loadTree } from '@wilanis/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnosticsOf, withMigration } from '../src/diagnostics.js';
import { migrate, PROFILE_VARIABLE } from '../src/index.js';
import type { MigrateOptions } from '../src/migrate.js';
import { step, target, tree } from './migrate-harness.js';

/** live and production, live the default, as the example declares them; a test may declare others. */
const DECLARED = { live: true, production: false };

/**
 * What the command said first, what every call of the migrate member was handed, and the envelope's profile, over
 * a tree declaring the profiles given; `null` for a tree that declares none.
 */
async function planned(opts: MigrateOptions = {}, profiles: Record<string, boolean> | null = DECLARED) {
  const { dir, seen, calls, plugins } = tree({ targets: [target([step()])] }, { profiles: profiles ?? undefined });
  const said: string[] = [];
  try {
    const answer = await migrate(loadTree(dir, plugins), { ...opts, log: line => said.push(line) });
    const diag = diagnosticsOf(loadTree(dir, plugins), { items: answer.refusals }, { command: 'migrate', root: '.' });
    const envelope = withMigration(diag, answer);
    return { first: said[0], handed: seen.map(ctx => ctx.profile), profile: envelope.profile, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('wilanis migrate: the profile it plans under (RFC 0013, #711)', () => {
  const kept = process.env[PROFILE_VARIABLE];
  beforeEach(() => {
    delete process.env[PROFILE_VARIABLE];
  });
  afterEach(() => {
    if (kept === undefined) delete process.env[PROFILE_VARIABLE];
    else process.env[PROFILE_VARIABLE] = kept;
  });

  it('plans under WILANIS_PROFILE when no --profile is given, and says so first', async () => {
    process.env[PROFILE_VARIABLE] = 'production';
    expect(await planned()).toMatchObject({
      first: 'profile production',
      handed: ['production'],
      profile: 'production',
    });
  });

  it('plans under the profile marked default when neither names one', async () => {
    expect(await planned()).toMatchObject({ first: 'profile live', handed: ['live'], profile: 'live' });
  });

  it('takes --profile over WILANIS_PROFILE, as start does', async () => {
    process.env[PROFILE_VARIABLE] = 'production';
    expect(await planned({ profile: 'live' })).toMatchObject({ first: 'profile live', handed: ['live'] });
  });

  it('applies and reads the history under the same choice', async () => {
    process.env[PROFILE_VARIABLE] = 'production';
    // the plan and the apply are two calls of the member, and each is handed the profile the plan was made under
    expect(await planned({ apply: true })).toMatchObject({
      handed: ['production', 'production'],
      profile: 'production',
    });
    expect(await planned({ history: true })).toMatchObject({
      first: 'profile production',
      handed: ['production'],
      profile: 'production',
    });
  });

  it('refuses a profile the project does not declare with the message start gives, before any plugin runs', async () => {
    // named by the flag, then by the variable with no flag
    for (const [opts, variable] of [
      [{ profile: 'staging' }, undefined],
      [{}, 'staging'],
    ] as const) {
      if (variable) process.env[PROFILE_VARIABLE] = variable;
      const { dir, calls, plugins } = tree({ targets: [target([step()])] }, { profiles: DECLARED });
      await expect(migrate(loadTree(dir, plugins), { ...opts, log: () => {} })).rejects.toThrow(
        "no profile 'staging'; project.json declares: live (default), production",
      );
      expect(calls).toEqual([]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a project that declares profiles and marks none default, when none is named', async () => {
    await expect(planned({}, { live: false, production: false })).rejects.toThrow(
      'which profile? project.json declares live, production and marks none default',
    );
  });

  it('says none is declared where the project declares no profile, and hands its members default', async () => {
    expect(await planned({}, null)).toMatchObject({
      first: 'profile none declared',
      handed: ['default'],
      profile: 'default',
    });
  });
});
