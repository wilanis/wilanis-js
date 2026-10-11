/**
 * X004 on an http connection's `timeoutMs`: `send` (`request.ts`) hands it to `setTimeout`, and Node fires a timer set
 * past 2147483647 ms after 1 ms, so a timeout of 30 days would abort every request at once. A timeout under 1 could
 * never be met either. Dropping it leaves the default of 30000 ms, which the hint says.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree, TIMER_MAX_MS } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { INCLUDES, localCopy } from './harness.js';
import { EXAMPLE_PLUGINS as PLUGINS } from './plugins.js';

/** The X004 refusals of the example whose customer API connection says `timeoutMs`. */
function refused(timeoutMs: number) {
  const dir = localCopy({
    more: edit =>
      edit('connections/customers-api.connection.json', connection => {
        connection.settings.timeoutMs = timeoutMs;
      }),
  });
  try {
    return checkTree(loadTree(dir, PLUGINS, INCLUDES)).items.filter(item => item.code === 'X004');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("X004: a connection's timeout", () => {
  it('refuses one longer than a Node timer can wait, and says what dropping it leaves', () => {
    const found = refused(30 * 24 * 60 * 60 * 1000);
    expect(found.map(item => [item.file, item.at])).toEqual([
      ['@connections/customers-api.connection.json', 'settings/timeoutMs'],
    ]);
    expect(found[0].message).toMatch(/a longer one fires after 1 ms, so every request would be aborted at once/);
    expect(found[0].hint).toBe('set it to 2147483647 or less, or drop it for the default of 30000');
  });

  it('refuses one under 1, which no request could meet', () => {
    expect(refused(0).map(item => item.hint)).toEqual(['set it to 1 or more, or drop it for the default of 30000']);
  });

  it('takes one at the bound', () => {
    expect(refused(TIMER_MAX_MS)).toEqual([]);
  });
});
