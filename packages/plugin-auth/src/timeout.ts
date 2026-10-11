/**
 * X107: an OIDC connection's `timeoutMs` longer than a Node timer can wait. Every request to the issuer is given up
 * on a timer (`fetchWithin` in `directories.ts`), and Node fires one set past `TIMER_MAX_MS` after 1 ms, so every
 * request would be aborted at once and nobody could sign in through that issuer.
 */
import { type PluginCheckContext, TIMER_MAX_MS } from '@wilanis/core';
import { doc } from './settings.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

/** X107: every OIDC connection whose `timeoutMs` is past what a Node timer can wait. */
export function checkTimeouts(scope: Scope, refuse: Refuse): void {
  const kind = scope.canon(doc('oidc.connection-kind.json'));
  for (const connection of scope.registry.all('connection')) {
    if (scope.canon(connection.doc.kind) !== kind) continue;
    const ms = connection.doc.settings.timeoutMs;
    if (typeof ms !== 'number' || ms <= TIMER_MAX_MS) continue;
    refuse({
      code: 'X107',
      file: connection.path,
      message: `timeoutMs is ${ms}; it is the most a request to the issuer may take, in milliseconds, and a Node timer waits at most ${TIMER_MAX_MS} ms (about 24.8 days): a longer one fires after 1 ms, so every request would be aborted at once`,
      at: 'settings/timeoutMs',
      hint: `set it to ${TIMER_MAX_MS} or less, or drop it for the default of 10000`,
    });
  }
}
