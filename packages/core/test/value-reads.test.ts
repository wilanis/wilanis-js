/**
 * `secretKeysRead`: which secrets a value reads, the one answer C019, the manifest's connection rows and
 * `wilanis migrate` all ask of the settings and inputs a document writes.
 */
import { describe, expect, it } from 'vitest';
import { secretKeysRead } from '../src/index.js';

describe('which secrets a value reads', () => {
  it('names every key a template reads under secrets, at any depth, in lists and inside text', () => {
    const settings = {
      url: '{{secrets.databaseUrl}}',
      pool: { auth: { password: 'pw={{secrets.dbPassword}};' } },
      hosts: ['{{secrets.primary}}', 'replica.internal'],
    };
    expect(secretKeysRead(settings)).toEqual(['databaseUrl', 'dbPassword', 'primary']);
  });

  it('names a key once, where the value first reads it', () => {
    expect(
      secretKeysRead({ one: '{{secrets.b}}', two: '{{secrets.a}} and {{secrets.b}}', three: '{{secrets.a}}' }),
    ).toEqual(['b', 'a']);
  });

  it('names the key a deeper read starts from, and allows the spaces a template may hold', () => {
    expect(secretKeysRead('{{secrets.api.token}}')).toEqual(['api']);
    expect(secretKeysRead("{{ secrets['api-key'] }}")).toEqual(['api-key']);
  });

  it('reads no secret from another root, from a literal, or from the bare root, which names no key', () => {
    const value = { who: '{{context.principal}}', said: 'secrets.jwt', port: 8080, off: null, whole: '{{secrets}}' };
    expect(secretKeysRead(value)).toEqual([]);
    expect(secretKeysRead(undefined)).toEqual([]);
  });
});
