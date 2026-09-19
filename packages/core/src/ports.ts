/**
 * The second direction of the plugin contract (RFC 0005): a plugin calls a port it requires, and the runtime
 * runs the binding the host chose for it. What a plugin is handed is `env.ports`; what it catches when the
 * binding does not answer is a `PortError`, which says how the run ended.
 */
import type { Outcome } from '@wilanis/engine';

/**
 * What a plugin is given, as `env.ports`, to call a port it requires: one operation (`path#operation`) run
 * through the binding the active profile chose, answering what the operation returns. It refuses any operation
 * not under a port some plugin requires, so a handler cannot reach an arbitrary domain port.
 */
export type FirePort = (op: string, input: Record<string, unknown>) => Promise<unknown>;

/** How the binding behind one required operation ended when it did not answer, as `env.ports` throws it. */
export class PortError extends Error {
  constructor(
    readonly op: string,
    readonly outcome: Exclude<Outcome, { kind: 'answered' }>,
  ) {
    super(`${op} ${said(outcome)}`);
    this.name = 'PortError';
  }
}

/** One ending in words: the reason refused with, the node that broke, or the roots nothing supplied. */
function said(outcome: Exclude<Outcome, { kind: 'answered' }>): string {
  if (outcome.kind === 'refused') return `refused '${outcome.reason}' at '${outcome.at}': ${outcome.message}`;
  if (outcome.kind === 'faulted') return `failed at '${outcome.at}': ${outcome.error}`;
  return `blocked: nothing supplied ${outcome.needs.join(', ')}`;
}
