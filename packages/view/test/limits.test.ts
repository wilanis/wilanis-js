/**
 * What the viewer shows of a bound (RFC 0012, step 8). The view model carries a map's `limit` and `concurrency`
 * on its node, and a trigger's deadline and body size as the runtime resolves them -- the trigger's own, else the
 * plugin's settings, else none -- so the page and `wilanis describe` read one answer; a list field's `maxItems` is
 * on the document the page already has. The page marks a map that caps or paces its list, says both in the side
 * panel, lists a trigger's bounds with the document that said each, and tags a bounded list field.
 *
 * The example writes each of them once (RFC 0012, step 9): a deadline and a body's size in `@http`'s settings, a
 * deadline of its own on `get-customer`, a ceiling and a pace on `removed`. The cases that need one absent take
 * it out of a copy of it.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DocView, VNode } from '../src/index.js';
import { scopedView } from './scoped-harness.js';

const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));
const REMOVE = '@customers/domain/remove-customers.graph.json';
const GET = '@customers/edge/get-customer.trigger.json';
const GET_FILE = 'features/customers/edge/get-customer.trigger.json';

const nodeOf = (view: DocView, id: string): VNode => {
  const node = view.graph?.nodes.find(one => one.id === id);
  if (!node) throw new Error(`no node '${id}'`);
  return node;
};

/** The `removed` map of remove-customers, in its document. */
const removedOf = (doc: any) => doc.nodes.find((node: { id: string }) => node.id === 'removed');

/** One function of the page, lifted from its source: the page is one static file with no build step. */
async function pageFunction(name: string): Promise<(...args: unknown[]) => string> {
  const page = await readFile(PAGE, 'utf8');
  const source = page.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}`))?.[0];
  if (!source) throw new Error(`no function ${name} on the page`);
  return new Function(`${source}; return ${name};`)();
}

describe("the view model: a map's ceiling and pace", () => {
  it('carries both on the map that declares them', () => {
    expect(nodeOf(scopedView(REMOVE), 'removed')).toMatchObject({ limit: 100, concurrency: 8 });
  });

  it('carries neither on a map that declares neither, so the page draws nothing for it', () => {
    const view = scopedView(REMOVE, {
      'features/customers/domain/remove-customers.graph.json': doc => {
        delete removedOf(doc).limit;
        delete removedOf(doc).concurrency;
      },
    });
    const removed = nodeOf(view, 'removed');
    expect('limit' in removed).toBe(false);
    expect('concurrency' in removed).toBe(false);
  });
});

describe("the view model: a trigger's bounds", () => {
  it("carries the trigger's own", () => {
    expect(scopedView(GET).limits?.deadlineMs).toEqual({ value: 2000 });
  });

  it("carries the plugin's where the trigger writes none, and names the plugin", () => {
    const view = scopedView(GET, {
      [GET_FILE]: doc => {
        delete doc.settings.deadlineMs;
      },
    });
    expect(view.limits).toEqual({
      deadlineMs: { value: 60000, from: '@http' },
      maxBodyBytes: { value: 1048576, from: '@http' },
    });
  });

  it('carries none on a trigger whose kind takes none', () => {
    const view = scopedView('@customers/edge/digest.trigger.json');
    expect(view.limits).toBeUndefined();
  });
});

describe('the page', () => {
  it('says a bound the way describe does', async () => {
    const fanOutText = await pageFunction('fanOutText');
    expect(fanOutText({ limit: 100, concurrency: 8 })).toBe('at most 100 elements, 8 at once');
    expect(fanOutText({ concurrency: 8 })).toBe('8 at once');
    expect(fanOutText({})).toBe('');
    const limitText = await pageFunction('limitText');
    expect(limitText('deadlineMs', { value: 2000 })).toBe('deadline 2000ms');
    expect(limitText('deadlineMs', { value: 30000, from: '@http' })).toBe('deadline 30000ms (from @http settings)');
    expect(limitText('deadlineMs', {})).toBe('deadline none');
    expect(limitText('maxBodyBytes', { value: 1048576 })).toBe('body at most 1048576 bytes');
    expect(limitText('maxBodyBytes', {})).toBe('body of any size');
  });

  it('marks a map that caps or paces its list, and says both in the side panel', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(/function marksOf\(n\)[\s\S]*?n\.limit !== undefined \|\| n\.concurrency !== undefined/);
    expect(page).toMatch(/renderNodeDetails[\s\S]*?fanOutEl\(box, n\)/);
    expect(page).toContain('a longer list fails the node as a fault before any element starts');
  });

  it("lists a trigger's bounds, and tags a bounded list field", async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(/case 'trigger': \{[\s\S]*?limitsEl\(page, v\.limits\)/);
    expect(page).toContain("'at most ' + f.maxItems");
  });
});
