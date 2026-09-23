/**
 * What a page is told about a switch's `catch` (RFC 0014, step 11). The example's `get-row` declares the guide's:
 * `fetched` breaking routes to `unreachable`, which refuses `upstream`. Every rule of
 * the switch carries the catch, the caught node carries the switch, and one catch edge runs from the top of the
 * ladder to the target, labelled with what broke. The trigger page closes its refusal table with the sentence
 * `wilanis describe` closes the trigger's with, read here from the runtime so the two cannot drift.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { UNCAUGHT_FAULT } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import type { DocView } from '../src/index.js';
import { scopedView } from './scoped-harness.js';

const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));
const FILE = 'features/customers/data/get-row.graph.json';
const GET_ROW = `@${FILE}`;

/** get-row with its catch taken out, and the refusal it routed to with it. */
function uncaught(doc: any): void {
  delete doc.nodes.find((node: any) => node.id === 'outcome').catch;
  doc.nodes = doc.nodes.filter((node: any) => node.id !== 'unreachable');
  doc.out.from = doc.out.from.filter((id: string) => id !== 'unreachable');
}

const nodeOf = (view: DocView, id: string) => view.graph!.nodes.find(node => node.id === id);

describe('the view of a switch that catches a fault', () => {
  const view = scopedView(GET_ROW);

  it('carries the catch on every rule of the switch', () => {
    const rules = view.graph!.nodes.filter(node => node.decision?.id === 'outcome');
    expect(rules.map(rule => rule.id)).toEqual(['outcome/1', 'outcome/2']);
    for (const rule of rules) expect(rule.decision!.catch).toEqual({ fetched: 'unreachable' });
  });

  it('marks the caught node with the switch that catches it, and no other node', () => {
    expect(nodeOf(view, 'fetched')!.caughtBy).toBe('outcome');
    const marked = view.graph!.nodes.filter(node => node.caughtBy).map(node => node.id);
    expect(marked).toEqual(['fetched']);
  });

  it('draws one catch edge from the top of the ladder to the target, labelled with what broke', () => {
    const catches = view.graph!.edges.filter(edge => edge.kind === 'catch');
    expect(catches).toEqual([
      { from: 'outcome/1', fromPort: '', to: 'unreachable', toPort: '', kind: 'catch', label: 'fetched broke' },
    ]);
  });

  it('carries nothing of a catch where the switch has none', () => {
    const plain = scopedView(GET_ROW, { [FILE]: uncaught });
    expect(plain.graph!.edges.some(edge => edge.kind === 'catch')).toBe(false);
    expect(plain.graph!.nodes.some(node => node.caughtBy || node.decision?.catch)).toBe(false);
  });
});

describe('the page draws a catch and closes the refusal table', () => {
  it('draws the catch edge dashed, says who catches a caught node, and closes the table with the runtime sentence', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain('.edge.catch { stroke-dasharray:');
    expect(page).toContain("frag('its fault is caught by ')");
    expect(page).toContain(JSON.stringify(UNCAUGHT_FAULT));
  });
});
