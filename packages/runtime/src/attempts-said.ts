/**
 * What `wilanis describe` says about repeating a call (RFC 0011): what an operation promises about being called
 * again, on its port's line, and what a call site declares about trying it again and bounding it, on the line
 * of the node or the binding operation that declares it. Nothing is judged here -- whether a retry is safe
 * where it is written is the checker's -- so a reader is told the words the documents carry, said once.
 */
import type { Operation, Retry } from '@wilanis/core';

/**
 * What an operation promises about a repeated call: idempotent always, idempotent where an expression over
 * its inputs holds, or the accepted field it recognises a repeat by. Empty when it promises none of them.
 */
export function promisedSaid(op: Pick<Operation, 'idempotent' | 'key'>): string {
  if (op.idempotent === true) return '  (idempotent)';
  if (typeof op.idempotent === 'string') return `  (idempotent when ${op.idempotent})`;
  return op.key ? `  (key: ${op.key})` : '';
}

/** How a retry reads: how many more tries, then what it waits before the second and what answer it tries again. */
function retrySaid(retry: Retry): string {
  const backoff = retry.backoffMs ? [`${retry.backoffMs}ms backoff`] : [];
  const when = retry.when ? [`when ${retry.when}`] : [];
  const both = [...backoff, ...when];
  return `  retries ${retry.times}${both.length ? ` (${both.join(', ')})` : ''}`;
}

/**
 * What a call site declares about its tries: how often it is tried again and on what, and the most it may take.
 * Empty on a site that declares neither, which is every site that runs once and waits as long as its handler.
 */
export function attemptsSaid(site: { retry?: Retry; timeoutMs?: number }): string {
  const retry = site.retry ? retrySaid(site.retry) : '';
  const timeout = site.timeoutMs !== undefined ? `  timeout ${site.timeoutMs}ms` : '';
  return `${retry}${timeout}`;
}
