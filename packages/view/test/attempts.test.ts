/**
 * What the viewer shows of repeating a call (RFC 0011, step 8). The view model carries what a call site
 * declares -- `retry`, `timeoutMs` -- on the node or binding operation that declares it, and what an operation
 * promises -- `idempotent`, `key` -- on the target a node runs; the page draws a mark on a node that is tried
 * again or bounded, says the policy in the side panel, and lists the promises among an operation's flags.
 *
 * The example declares no retry yet, so the cases write one into a copy of it.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DocView, VNode } from '../src/index.js';
import { scopedView } from './scoped-harness.js';

const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));
const GET_ROW = '@customers/data/get-row.graph.json';
const REST = '@features/customers/data/customers-rest.binding.json';
const RETRY = { times: 2, backoffMs: 200, when: 'status >= 500' };

/** The copy of the example with the guide's retry and bound on get-row's request. */
const retried = () =>
  scopedView(GET_ROW, {
    'features/customers/data/get-row.graph.json': doc => {
      const fetched = doc.nodes.find((node: { id: string }) => node.id === 'fetched');
      fetched.retry = RETRY;
      fetched.timeoutMs = 5000;
    },
  });

const nodeOf = (view: DocView, id: string): VNode => {
  const node = view.graph?.nodes.find(one => one.id === id);
  if (!node) throw new Error(`no node '${id}'`);
  return node;
};

describe('the view model: what a call site declares', () => {
  it('carries the retry and the bound on the node that declares them', () => {
    const fetched = nodeOf(retried(), 'fetched');
    expect(fetched.retry).toEqual(RETRY);
    expect(fetched.timeoutMs).toBe(5000);
  });

  it('carries neither on a node that declares neither, so the page draws nothing for it', () => {
    const fetched = nodeOf(scopedView(GET_ROW), 'fetched');
    expect('retry' in fetched).toBe(false);
    expect('timeoutMs' in fetched).toBe(false);
  });

  it('carries them on a binding operation, on the port page and on the node that reaches it', () => {
    const edits = {
      'features/customers/data/customers-rest.binding.json': (doc: any) => {
        doc.operations.listEvery.retry = { times: 1 };
        doc.operations.listEvery.timeoutMs = 8000;
      },
    };
    const port = scopedView('@customers/domain/customer.port.json', edits);
    const rest = port.implementations?.find(one => one.path === REST);
    expect(rest?.operations.listEvery).toMatchObject({ retry: { times: 1 }, timeoutMs: 8000 });
    expect('retry' in (rest?.operations.listAll ?? {})).toBe(false);
    // a domain graph's node running customer.listEvery is told, per binding, how each meets it
    const target = nodeOf(scopedView('@customers/domain/digest.graph.json', edits), 'all').target;
    expect(target?.bindings?.find(one => one.path === REST)).toMatchObject({ retry: { times: 1 }, timeoutMs: 8000 });
  });
});

describe('the view model: what an operation promises', () => {
  it('carries the expression an operation is idempotent under on the target a node runs', () => {
    const target = nodeOf(scopedView(GET_ROW), 'fetched').target;
    expect(target?.idempotent).toBe("method == 'GET' || method == 'HEAD' || method == 'PUT' || method == 'DELETE'");
    expect(target && 'key' in target).toBe(false);
  });

  it('carries nothing on a target whose operation promises nothing', () => {
    const target = nodeOf(scopedView(GET_ROW), 'customer').target;
    expect(target && 'idempotent' in target).toBe(false);
  });
});

// the page is one static file with no build step, so what it draws is read from its own source
describe('the page', () => {
  it('says a call site the way describe does', async () => {
    const page = await readFile(PAGE, 'utf8');
    const source = page.match(/function attemptsText\(site\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(source).toBeDefined();
    const attemptsText = new Function(`${source}; return attemptsText;`)();
    expect(attemptsText({ retry: RETRY, timeoutMs: 5000 })).toBe(
      'retries 2 (200ms backoff, when status >= 500), timeout 5000ms',
    );
    expect(attemptsText({ retry: { times: 1 } })).toBe('retries 1');
    expect(attemptsText({})).toBe('');
  });

  it('marks a node that is tried again or bounded, and says the policy in the side panel', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(/function marksOf\(n\)[\s\S]*?n\.retry \|\| n\.timeoutMs !== undefined/);
    expect(page).toMatch(/renderNodeDetails[\s\S]*?triesEl\(box, n\)/);
    expect(page).toContain('A refusal is never tried again');
  });

  it('lists what an operation promises among its flags, and a binding operation its tries', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain("el('span', 'badge ok', 'idempotent when')");
    expect(page).toContain("el('code', null, op.idempotent)");
    expect(page).toContain("'key: ' + op.key");
    expect(page).toMatch(/case 'binding': \{[\s\S]*?attemptsText\(op\)/);
  });
});
