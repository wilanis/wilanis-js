/**
 * X107: an OIDC connection's `timeoutMs` is a Node timer's wait (`fetchWithin`), and Node fires a timer set past
 * 2147483647 ms after 1 ms, so a longer one would abort every request to the issuer at once. The example names no
 * OIDC issuer, so each case writes one beside its connections and reads the refusals back.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, schemaRef, TIMER_MAX_MS } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { INCLUDES, localCopy, PLUGINS } from './harness.js';

/** The X107 refusals of the example with one OIDC issuer whose connection says `timeoutMs`. */
function refused(timeoutMs: number) {
  const dir = localCopy({
    'project.json': project => {
      project.secrets.oidcClient = 'CUSTOMERS_OIDC_CLIENT_SECRET';
    },
  });
  writeFileSync(
    join(dir, 'connections/issuer.connection.json'),
    JSON.stringify({
      $schema: schemaRef('connection'),
      description: 'an OpenID Connect issuer the employees could sign in through',
      kind: '@auth/oidc.connection-kind.json',
      settings: {
        issuer: 'https://issuer.example.com',
        clientId: 'customers',
        clientSecret: '{{secrets.oidcClient}}',
        timeoutMs,
      },
    }),
  );
  try {
    return checkTree(loadTree(dir, PLUGINS, INCLUDES)).items.filter(item => item.code === 'X107');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('X107: an OIDC timeout longer than a Node timer can wait', () => {
  it('refuses 30 days, which Node would fire after 1 ms, aborting every request to the issuer at once', () => {
    const found = refused(30 * 24 * 60 * 60 * 1000);
    expect(found.map(item => [item.file, item.at])).toEqual([
      ['@connections/issuer.connection.json', 'settings/timeoutMs'],
    ]);
    expect(found[0].message).toMatch(/a longer one fires after 1 ms, so every request would be aborted at once/);
    expect(found[0].hint).toBe('set it to 2147483647 or less, or drop it for the default of 10000');
  });

  it('takes a timeout at the bound', () => {
    expect(refused(TIMER_MAX_MS)).toEqual([]);
  });
});
