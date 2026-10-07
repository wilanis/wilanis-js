/**
 * A tree of one cli trigger, `check`, whose graph reads a `Read` and decides on it three times (#845): `status`
 * names two of its three enum members and sends the third, by its else, to `ok`, which makes a `Result` whose
 * status is the same enum; `agree` reads a boolean; and `moved` compares two fields of the same answer,
 * `has(previous) && previous == commit`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Kind, schemaUrl } from '@wilanis/core';

const HOME = '@features/scan';
const PORT = `${HOME}/domain/scan.port.json`;
const RESULT = `${HOME}/domain/Result.shape.json`;
const READ = `${HOME}/domain/Read.shape.json`;
const STATUS = { type: 'string', enum: ['clean', 'findings', 'broke'] };

const run = (id: string, op: string, input: object) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run: op,
  in: input,
});
const make = (id: string, value: object, type: string) => run(id, '@std/object.port.json#make', { value, type });
const refuse = (id: string, reason: string) =>
  run(id, '@std/outcome.port.json#refuse', { reason, message: reason, type: RESULT });
const decide = (id: string, input: object, rules: { when: string; to: string }[], otherwise: string) => ({
  type: '@wilanis/node/switch.schema.json',
  id,
  in: input,
  rules,
  else: otherwise,
});

/** The graph `check` fires: every decision on `got`, each with a refusal of its own. */
const CHECK = {
  in: `${HOME}/domain/Ask.shape.json`,
  out: { type: RESULT, from: ['good', 'same', 'broke', 'disagree'] },
  nodes: [
    run('got', `${PORT}#read`, { target: '{{in.target}}' }),
    decide(
      'status',
      { status: '{{got.status}}' },
      [
        { when: "status == 'clean'", to: 'ok' },
        { when: "status == 'findings'", to: 'broke' },
      ],
      'ok',
    ),
    refuse('broke', 'broke'),
    make('ok', { status: '{{got.status}}', count: '{{got.count}}' }, RESULT),
    decide('agree', { agrees: '{{got.agrees}}', n: '{{ok.count}}' }, [{ when: 'agrees', to: 'moved' }], 'disagree'),
    refuse('disagree', 'disagree'),
    decide(
      'moved',
      { previous: '{{got.previous}}', commit: '{{got.commit}}' },
      [{ when: 'has(previous) && previous == commit', to: 'same' }],
      'good',
    ),
    refuse('same', 'same'),
    make('good', { status: '{{ok.status}}', count: '{{ok.count}}' }, RESULT),
  ],
};

/** Every document of the tree but the project, by its path under the feature. */
const DOCS: Record<string, object> = {
  'domain/Read.shape.json': {
    layer: 'core',
    fields: {
      status: STATUS,
      agrees: { type: 'boolean' },
      count: { type: 'number' },
      commit: { type: 'string' },
      previous: { type: 'string', required: false },
    },
  },
  'domain/Result.shape.json': { layer: 'core', fields: { status: STATUS, count: { type: 'number' } } },
  'domain/Ask.shape.json': { layer: 'core', fields: { target: { type: 'string' } } },
  'edge/AskIn.shape.json': { layer: 'edge', fields: { target: { type: 'string' } } },
  'edge/Out.shape.json': { layer: 'edge', fields: { status: { type: 'string' }, count: { type: 'number' } } },
  'domain/scan.port.json': {
    operations: {
      check: { description: 'd', accepts: { target: { type: 'string' } }, returns: RESULT, refuses: true },
      read: { description: 'd', accepts: { target: { type: 'string' } }, returns: READ },
    },
  },
  'data/scan.binding.json': {
    port: PORT,
    operations: {
      check: { graph: `${HOME}/domain/check.graph.json` },
      read: { graph: `${HOME}/data/read.graph.json` },
    },
  },
  'data/read.graph.json': {
    in: `${HOME}/domain/Ask.shape.json`,
    out: { type: READ, from: 'r' },
    nodes: [make('r', { status: 'broke', agrees: false, count: 0, commit: '{{in.target}}' }, READ)],
  },
  'domain/check.graph.json': CHECK,
  'edge/check.trigger.json': {
    kind: '@cli/cli.trigger-kind.json',
    settings: { command: 'check' },
    in: `${HOME}/edge/AskIn.shape.json`,
    out: `${HOME}/edge/Out.shape.json`,
    fire: { run: `${PORT}#check` },
  },
};

/** The tree's directory, written fresh. */
export function scanTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-scan-'));
  const put = (rel: string, doc: object) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    const kind = rel
      .replace(/\.json$/, '')
      .split(/[./]/)
      .at(-1) as Kind;
    writeFileSync(join(dir, rel), JSON.stringify({ $schema: schemaUrl(kind), description: 'd', ...doc }));
  };
  put('project.json', { name: 'scan', plugins: [{ use: '@std' }, { use: '@cli' }] });
  put('features/scan/feature.json', {});
  for (const [rel, doc] of Object.entries(DOCS)) put(`features/scan/${rel}`, doc);
  return dir;
}
