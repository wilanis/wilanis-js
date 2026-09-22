/**
 * A tree small enough to break one way at a time: one feature with something to fire, and a project whose
 * startup list names the exporter. Every case copies it, edits one document, and answers the refusal codes,
 * as `packages/plugin-schedule/test` does for its own.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import otel from '../src/index.js';
import { EXPORT, ROOT } from '../src/paths.js';

export const PLUGINS: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, [ROOT]: otel };

/** One document of the tree, by the path it sits at. */
export type Docs = Record<string, unknown>;

/** The tree as it stands when nothing is broken: a collector named outright, and a step that exports to it. */
export function tree(): Docs {
  return {
    'project.json': {
      $schema: schemaRef('project'),
      description: 'a tree that says what its runs did',
      name: 'traced',
      plugins: [
        { use: '@std' },
        { use: '@cli' },
        {
          use: ROOT,
          from: '@wilanis/plugin-otel',
          settings: { endpoint: 'http://localhost:4318/v1/traces', service: 'monitor' },
        },
      ],
      startup: [{ label: 'Export traces', run: EXPORT }],
    },
    'features/customers/feature.json': {
      $schema: schemaRef('feature'),
      description: 'what the monitor observes',
    },
    'features/customers/domain/Digest.shape.json': {
      $schema: schemaRef('shape'),
      description: 'what a digest says',
      layer: 'core',
      fields: { count: { type: 'number' } },
    },
    'features/customers/domain/customer.port.json': {
      $schema: schemaRef('port'),
      description: 'what the monitor can be asked for',
      operations: {
        digest: { description: 'the digest of what was seen', returns: '@features/customers/domain/Digest.shape.json' },
      },
    },
    'features/customers/data/digest.binding.json': {
      $schema: schemaRef('binding'),
      description: 'how the digest is made',
      port: '@features/customers/domain/customer.port.json',
      operations: { digest: { graph: '@features/customers/data/count.graph.json' } },
    },
    'features/customers/data/count.graph.json': {
      $schema: schemaRef('graph'),
      description: 'how many were seen',
      out: { type: '@features/customers/domain/Digest.shape.json', from: 'counted' },
      nodes: [
        {
          id: 'counted',
          type: '@wilanis/node/run.schema.json',
          run: '@std/object.port.json#make',
          in: { value: { count: 0 }, type: '@features/customers/domain/Digest.shape.json' },
        },
      ],
    },
    'features/customers/edge/DigestView.shape.json': {
      $schema: schemaRef('shape'),
      description: 'the digest as a caller sees it',
      layer: 'edge',
      fields: { count: { type: 'number' } },
    },
    'features/customers/edge/digest.trigger.json': {
      $schema: schemaRef('trigger'),
      label: 'digest',
      description: 'what a command line asks for, so a case can fire this tree for real',
      settings: { command: 'digest' },
      out: '@features/customers/edge/DigestView.shape.json',
      kind: '@cli/cli.trigger-kind.json',
      fire: { run: '@features/customers/domain/customer.port.json#digest' },
    },
  };
}

/** Write a tree into a directory of its own; the caller removes it. */
export function write(docs: Docs): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-otel-'));
  for (const [relative, doc] of Object.entries(docs)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  return dir;
}

/** The refusals a tree answers with, as code and where each points. */
export function refusals(docs: Docs): { code: string; at: string; file: string; message: string }[] {
  const dir = write(docs);
  const found = checkTree(loadTree(dir, PLUGINS)).items;
  rmSync(dir, { recursive: true, force: true });
  return found.map(one => ({ code: one.code, at: one.at ?? '', file: one.file, message: one.message }));
}

/** The tree with its @otel settings replaced by what a case wants to try. */
export function withSettings(settings: Record<string, unknown>): Docs {
  const docs = tree();
  (docs['project.json'] as { plugins: { settings?: unknown }[] }).plugins[2].settings = settings;
  return docs;
}

/** The refusals of one code a settings table answers with; the case names the code it is proving. */
export const judging = (settings: Record<string, unknown>, code: string) =>
  refusals(withSettings(settings)).filter(one => one.code === code);
