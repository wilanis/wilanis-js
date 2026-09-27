/**
 * What the viewer shows of a queue (RFC 0009, step 6), over the example's: the view model carries, on the
 * broker's connection, what its kind delivers, the triggers receiving from it and the calls sending to it; and, on
 * the queue trigger, the connection it receives from and the call whose messages it receives. The pairing is the
 * runtime's, so the page and `wilanis describe` cannot pair a call with a different trigger. The page's functions
 * are lifted from its source and run over a stand-in for the DOM, since the page is one static file.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { type Drawn, drawn, lifted, PAGE, words } from './page-harness.js';
import { scopedView } from './scoped-harness.js';

const JOBS = '@connections/jobs.connection.json';
const QUEUED = '@features/customers/edge/remove-queued.trigger.json';
const PUBLISHING = '@features/customers/data/publish-removal.graph.json';

/** The call the example's queue is sent through, as the view model carries it. */
const PUBLISHED = {
  file: PUBLISHING,
  label: 'Publish a removal',
  where: 'published',
  node: true,
  address: 'queue "removals"',
  receivers: [{ path: QUEUED, label: 'removals queue' }],
};

describe('the view model: a queue', () => {
  it('carries on the connection what its kind delivers, who receives from it and who sends to it', () => {
    expect(scopedView(JOBS).delivery).toEqual({
      delivery: 'at-least-once',
      means: 'a message not acknowledged is delivered again, so what it fires may run twice',
      receivers: [{ path: QUEUED, label: 'removals queue', said: 'queue "removals", maxAttempts 5, backoffMs 1000' }],
      senders: [PUBLISHED],
    });
  });

  it('carries on the queue trigger the connection it receives from and the call whose messages it receives', () => {
    expect(scopedView(QUEUED).receives).toEqual({
      connection: JOBS,
      label: 'Jobs',
      delivery: 'at-least-once',
      senders: [PUBLISHED],
    });
  });

  it('carries neither on a connection or a trigger that has no queue', () => {
    expect(scopedView('@connections/customers-api.connection.json').delivery).toBeUndefined();
    expect(scopedView('@customers/edge/enqueue-removal.trigger.json').receives).toBeUndefined();
  });

  it('carries a call no trigger of this tree receives, and a trigger nothing here sends to', () => {
    const edits = {
      'features/customers/data/publish-removal.graph.json': (doc: any) => {
        doc.nodes[0].in.queue = 'audit';
      },
    };
    expect(scopedView(JOBS, edits).delivery?.senders).toEqual([
      { ...PUBLISHED, address: 'queue "audit"', receivers: [] },
    ]);
    expect(scopedView(QUEUED, edits).receives?.senders).toEqual([]);
  });
});

describe('the connection page', () => {
  it('says what it delivers, lists the triggers receiving from it, and tables each call with its receiver', async () => {
    const { deliveryEl } = await lifted('sendLink', 'deliveryEl');
    const page = drawn({ tag: 'main' });
    deliveryEl(page, scopedView(JOBS).delivery);
    const said = page.children.map(words);
    expect(said[0]).toBe(
      'Delivers at-least-once: a message not acknowledged is delivered again, so what it fires may run twice.',
    );
    expect(said).toContain('Received by (1)');
    expect(said).toContain('trigger removals queue queue "removals", maxAttempts 5, backoffMs 1000');
    expect(said).toContain('Sent to by (1)');
    const table = page.children.at(-1) as Drawn;
    expect(table.children.slice(1).map(row => row.children.map(words))).toEqual([
      ['Publish a removal › published', 'queue "removals"', 'removals queue'],
    ]);
    // the call opens its graph at the node
    expect(table.children[1].children[0].children[0]).toMatchObject({ path: PUBLISHING, node: 'published' });
  });

  it('draws the connection page through it, after the settings', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(
      /case 'connection': \{[\s\S]*?valuesTable\(d\.settings\)\);\n\s*if \(v\.delivery\) deliveryEl\(page, v\.delivery\);/,
    );
  });
});

describe('the trigger page', () => {
  it('lists the calls whose messages it receives, each opening its graph at the node', async () => {
    const { sentByEl } = await lifted('sendLink', 'sentByEl');
    const page = drawn({ tag: 'main' });
    sentByEl(page, scopedView(QUEUED).receives?.senders);
    expect(page.children.map(words)).toEqual(['Sent by (1)', 'Publish a removal › published queue "removals"']);
    const none = drawn({ tag: 'main' });
    sentByEl(none, []);
    expect(none.children.map(words)).toEqual([
      'Sent by (0)',
      'Nothing in this tree sends what it receives; another tree may.',
    ]);
  });

  it('says in the chain what it receives from and what that delivers, after what fires it', async () => {
    const page = await readFile(PAGE, 'utf8');
    const trigger = page.match(/case 'trigger': \{[\s\S]*?break;\n {6}\}/)?.[0] ?? '';
    expect(trigger).toMatch(
      /step\('fired by', by\)\);\n\s*if \(v\.receives\)[^\n]*', which delivers ' \+ v\.receives\.delivery[^\n]*step\('receives from', from\)/,
    );
    expect(trigger).toContain('if (v.receives) sentByEl(page, v.receives.senders);');
  });
});
