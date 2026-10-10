/**
 * The site as a declared input (RFC 0032), as the viewer shows it: a node calling an operation that asks for its
 * site lists the field marked `provided`, with the literal the compiler writes there, so a reader sees what the
 * handler is handed without running anything; the page greys it and never calls it missing; and a port's page tags
 * the field as the compiler's.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree, schemaRef } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { type DocView, viewOf } from '../src/index.js';
import { PAGE } from './page-harness.js';
import { copied, EXAMPLE, INCLUDES, PLUGINS } from './scoped-harness.js';

/** The runtime's note fixture, by its documents alone: the viewer runs nothing, so it needs no handler. */
const NOTE_DOCS = fileURLToPath(new URL('../../runtime/test/fixtures/plugin-note/docs', import.meta.url));
const NOTE_IT = '@features/notes/data/note-it.graph.json';

/** A graph that calls the fixture's `record`, giving `text` and never `site`, in a feature of its own. */
const NOTES: Record<string, unknown> = {
  'features/notes/feature.json': {
    $schema: schemaRef('feature'),
    description: 'notes beside a run',
    effects: ['@note/note.port.json#record'],
  },
  'features/notes/data/note-it.graph.json': {
    $schema: schemaRef('graph'),
    label: 'Note it',
    description: 'one note of the text given',
    in: 'string',
    out: { type: 'boolean', from: 'noted' },
    nodes: [
      {
        type: '@wilanis/node/run.schema.json',
        id: 'noted',
        label: 'The note',
        run: '@note/note.port.json#record',
        in: { text: '{{in}}' },
      },
    ],
  },
};

/** The views asked for, over a copy of the example with the notes feature planted and the fixture named. */
function viewsOf(paths: string[]): DocView[] {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-view-site-'));
  try {
    cpSync(EXAMPLE, dir, { recursive: true, filter: copied });
    for (const [file, doc] of Object.entries(NOTES)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify(doc));
    }
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    project.plugins.push({ use: '@note' });
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
    const plugins = { ...PLUGINS, '@note': { root: '@note', docs: NOTE_DOCS, handlers: {} } };
    const load = loadTree(dir, plugins, INCLUDES);
    return paths.map(path => {
      const seen = viewOf(load, path);
      if (!seen) throw new Error(`no view for ${path}`);
      return seen;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the viewer's node panel", () => {
  it('lists a provided field marked provided, with the literal the compiler writes, never as missing', () => {
    const [graph] = viewsOf([NOTE_IT]);
    const noted = graph.graph!.nodes.find(node => node.id === 'noted')!;
    expect(noted.inputs.map(port => port.name)).toEqual(['text', 'site']);
    expect(noted.inputs[1]).toMatchObject({
      name: 'site',
      type: '@std/Site.shape.json',
      required: true,
      provided: true,
      literal: JSON.stringify({ file: NOTE_IT, at: 'nodes/noted' }),
    });
    expect(noted.inputs[1].missing).toBeUndefined();
    expect(noted.inputs[0]).toMatchObject({ name: 'text', type: 'string' });
    expect(noted.inputs[0].provided).toBeUndefined();
  });

  it('greys the field on the page and says it is the compiler’s, in the panel, on the node and on the port’s page', async () => {
    const page = await readFile(PAGE, 'utf8');
    // the side panel names the row provided, and shows the literal greyed
    expect(page).toMatch(/renderNodeDetails[\s\S]*?p\.provided \? 'provided' : p\.required === false \? 'opt' : 'req'/);
    expect(page).toMatch(/if \(p\.provided\) \{ const v = el\('span', 'val provided'/);
    // the node draws the pin's name greyed rather than as missing
    expect(page).toMatch(/p\.missing \? ' miss' : p\.provided \? ' provided' : req \? '' : ' opt'/);
    // the port's page tags the field
    expect(page).toContain("'provided: the compiler writes it, never a call site'");
    expect(page).toMatch(/\.provided \{ color: var\(--dim\); \}/);
  });
});
