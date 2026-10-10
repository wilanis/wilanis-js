/**
 * The tree RFC 0032's cases run against: a copy of the example that names the note fixture (`fixtures/plugin-note`)
 * and calls its port from the three kinds of site a native operation has -- a graph's node, a binding's delegation
 * and a startup step -- in a feature of its own, `notes`, planted beside the example's. The customers' `create-row`
 * gains the `noted` node of the RFC's worked example, so a stubbed run of the REST registration shows the site in
 * its report.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type LoadResult, loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';
import note from './fixtures/plugin-note/index.js';

export const NOTE_PORT = '@note/note.port.json';
export const NOTES_PORT = '@features/notes/domain/notes.port.json';
export const NOTE_IT = 'features/notes/data/note-it.graph.json';
export const NOTES_BINDING = 'features/notes/data/notes.binding.json';
export const CREATE_ROW = 'features/customers/data/create-row.graph.json';
export const PROJECT = 'project.json';

/** The RFC's worked example: a node of `create-row` that notes every record made, giving `text` and never `site`. */
export const NOTED = {
  type: '@wilanis/node/run.schema.json',
  id: 'noted',
  label: 'Note the record',
  description: 'Every record made through this graph is noted, so the test can see which site made it.',
  run: `${NOTE_PORT}#record`,
  in: { text: '{{in.email}}' },
};

/** The notes feature: one domain port met by a graph (`record`) and by a delegation (`delegate`). */
const NOTES_FEATURE: Record<string, unknown> = {
  'features/notes/feature.json': {
    $schema: schemaRef('feature'),
    description: 'notes beside a run, kept with the site that wrote each',
    exports: [NOTES_PORT],
    effects: [`${NOTE_PORT}#record`],
  },
  'features/notes/domain/notes.port.json': {
    $schema: schemaRef('port'),
    description: 'keep a note',
    operations: {
      record: {
        description: 'note the text, through a graph',
        accepts: { text: { type: 'string' } },
        returns: 'boolean',
      },
      delegate: {
        description: 'note the text, by delegation',
        accepts: { text: { type: 'string' } },
        returns: 'boolean',
      },
    },
  },
  [NOTE_IT]: {
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
        run: `${NOTE_PORT}#record`,
        in: { text: '{{in}}' },
      },
    ],
  },
  [NOTES_BINDING]: {
    $schema: schemaRef('binding'),
    label: 'Notes',
    description: 'the notes port over the fixture',
    port: NOTES_PORT,
    operations: {
      record: { graph: '@features/notes/data/note-it.graph.json' },
      delegate: { description: 'By delegation', run: `${NOTE_PORT}#record`, in: {} },
    },
  },
};

/** The startup step naming the fixture's `holds` operation, which the compiler tells which step it is. */
export const WATCH_STEP = { label: 'Keep the site', run: `${NOTE_PORT}#watch`, required: true };

export type Edit = (doc: any) => void;

/** A document of a copy, read, edited in place and written back. */
export function editing(dir: string, file: string, edit: Edit): void {
  const path = join(dir, file);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  edit(doc);
  writeFileSync(path, JSON.stringify(doc));
}

/** The example with the notes feature planted, the fixture named, `noted` in `create-row` and the watch step at the end of startup. */
export function siteTree(): string {
  const dir = copyOfExample();
  for (const [file, doc] of Object.entries(NOTES_FEATURE)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(doc));
  }
  editing(dir, PROJECT, project => {
    project.plugins.push({ use: '@note' });
    project.startup.push(WATCH_STEP);
    // production says what it reaches (C021), and now reaches the note
    project.profiles.production.permits.push(NOTE_PORT);
  });
  editing(dir, 'features/customers/feature.json', feature => feature.effects.push(`${NOTE_PORT}#record`));
  editing(dir, CREATE_ROW, graph => {
    graph.nodes.push(NOTED);
    // the note answers nothing the row needs, so the switch reads it to show it ran (G008 otherwise)
    graph.nodes.find((node: { id: string }) => node.id === 'outcome').in.noted = '{{noted}}';
  });
  return dir;
}

/** The plugins the tree loads with: the example's and the fixture, the fixture's documents edited where a case breaks one. */
export function pluginsWith(edit?: { doc: string; edit: Edit }): Record<string, PluginModule> {
  if (!edit) return { ...PLUGINS, '@note': note };
  const docs = mkdtempSync(join(tmpdir(), 'wilanis-note-'));
  cpSync(note.docs, docs, { recursive: true });
  editing(docs, edit.doc, edit.edit);
  return { ...PLUGINS, '@note': { ...note, docs } };
}

/** The tree loaded, with the fixture's documents as shipped or with one edited. */
export const loadSite = (dir: string, edit?: { doc: string; edit: Edit }): LoadResult =>
  loadTree(dir, pluginsWith(edit), INCLUDES);

/** Run one case against the planted tree, then take it away, whether it answered or threw. */
export async function withSite(use: (dir: string) => unknown): Promise<void> {
  const dir = siteTree();
  try {
    await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
