/**
 * What a page is told about repeating a call (RFC 0011): what a call site declares -- `retry`, `timeoutMs` --
 * on a node or a binding operation, and what an operation promises -- `idempotent`, `key` -- on the target a
 * node runs. Each is copied as written and only where it is written, so a site that runs once carries nothing
 * and a page draws no badge for it. Whether a retry is safe is the checker's; its refusals are on the page.
 */
import type { Operation, Retry } from '@wilanis/core';

/** What one call site declares about its tries: the retry and the bound, each only where it is written. */
export interface VAttempts {
  retry?: Retry;
  timeoutMs?: number;
}

/** What one operation promises about a repeated call: idempotent always or when an expression holds, or its key. */
export interface VPromised {
  idempotent?: boolean | string;
  key?: string;
}

/** The retry and the bound one node or binding operation declares, and nothing where it declares neither. */
export const attemptsOf = (site: VAttempts): VAttempts => ({
  ...(site.retry ? { retry: site.retry } : {}),
  ...(site.timeoutMs !== undefined ? { timeoutMs: site.timeoutMs } : {}),
});

/** What one operation promises about being called again, and nothing where it promises nothing. */
export const promisedOf = (op: Pick<Operation, 'idempotent' | 'key'>): VPromised => ({
  ...(op.idempotent !== undefined ? { idempotent: op.idempotent } : {}),
  ...(op.key ? { key: op.key } : {}),
});
