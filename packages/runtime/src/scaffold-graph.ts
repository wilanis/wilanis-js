/**
 * The graph `wilanis new graph` writes. A graph is the one kind with two forms worth scaffolding, so it lives
 * beside the rest rather than among them: the bare one node a reader replaces, and, with --store, the
 * read-decide-write shape a data graph takes whenever it changes a record it first read. Nothing here is a rule
 * of the language; it is what the shape looks like written out, with TODO where a value goes.
 */
import type { Kind } from '@wilanis/core';

/** One branch of the decision: the id its nodes are named after, and the expression that routes to it. */
interface Branch {
  id: string;
  when: string;
}

/** The store operation a branch writes with: what --read-then names. */
const WRITES = ['patch', 'put', 'remove'] as const;
type Write = (typeof WRITES)[number];

/** A run node, which is most of what a graph is made of. */
function run(id: string, label: string, op: string, values: Record<string, unknown>): Record<string, unknown> {
  return { type: '@wilanis/node/run.schema.json', id, label, run: op, in: values };
}

/** What a switch node is made of: what it reads, the rules in order, and the node nothing else routed to. */
interface Routing {
  id: string;
  label: string;
  in: Record<string, unknown>;
  rules: { when: string; to: string }[];
  otherwise: string;
}

/** A switch node: the rules in order, and the node nothing else routed to. */
function route(asked: Routing): Record<string, unknown> {
  const { otherwise, ...rest } = asked;
  return { type: '@wilanis/node/switch.schema.json', ...rest, else: otherwise };
}

/** What a branch's write takes beyond the store and the collection: a patch changes fields, a put writes a record. */
function writeInput(write: Write): Record<string, unknown> {
  if (write === 'put') return { record: 'TODO' };
  if (write === 'patch') return { key: '{{in.id}}', changes: { TODO: 'TODO' } };
  return { key: '{{in.id}}' };
}

/** What `--branch <id>:<when>` gave, as pairs. Repeating the flag adds one; a bare --branch scaffolds one to rename. */
function branchesOf(written: string | undefined): Branch[] {
  const asked = (written ?? '')
    .split(/[\n,]/)
    .map(one => one.trim())
    .filter(one => one.length > 0 && one !== 'true');
  if (!asked.length) return [{ id: 'changed', when: 'has(record)' }];
  return asked.map(one => {
    const at = one.indexOf(':');
    if (at < 1 || at === one.length - 1)
      throw new Error(
        `--branch '${one}' is not <id>:<when>, as in --branch archived:"has(record) && !has(record.note)"`,
      );
    return { id: one.slice(0, at).trim(), when: one.slice(at + 1).trim() };
  });
}

/** The four nodes one branch is: the write, the switch on what it answered, the record it answers, the refusal. */
function branchNodes(branch: Branch, write: Write, store: Record<string, string>): Record<string, unknown>[] {
  // every one of patch, put and remove answers `record`, absent where there was none to write, so one switch does
  return [
    run(branch.id, 'TODO: what this branch writes', `@storage/store.port.json#${write}`, {
      ...store,
      ...writeInput(write),
    }),
    route({
      id: `${branch.id}Route`,
      label: 'Was it still there?',
      in: { record: `{{${branch.id}.record}}` },
      rules: [{ when: 'has(record)', to: `${branch.id}Row` }],
      otherwise: `${branch.id}Missing`,
    }),
    run(`${branch.id}Row`, 'The record as it now stands', '@std/object.port.json#make', {
      value: `{{${branch.id}.record}}`,
      type: 'TODO',
    }),
    run(`${branch.id}Missing`, 'It was gone by the time we wrote', '@std/outcome.port.json#refuse', {
      reason: 'missing',
      message: 'no record {{in.id}}',
      type: 'TODO',
    }),
  ];
}

/**
 * The read-decide-write graph: read one record by its key, decide from what it holds which write it takes, write
 * it, and answer the record the write gave back or refuse where it had gone. Every node a reader must fill says
 * TODO, and no rule of the language is new -- this is the shape written out, not a feature.
 */
function readDecideWrite(opts: Record<string, string | undefined>): Record<string, unknown> {
  const write = (WRITES as readonly string[]).includes(opts['read-then'] ?? '')
    ? (opts['read-then'] as Write)
    : 'patch';
  const store = { store: opts.store ?? '@features/TODO/data/TODO.store.json', collection: opts.collection ?? 'TODO' };
  const branches = branchesOf(opts.branch);
  return {
    description:
      'TODO. Read one record, decide from what it holds which write it takes, and answer what the write gave back.',
    in: 'TODO',
    out: {
      type: 'TODO',
      from: [...branches.flatMap(one => [`${one.id}Row`, `${one.id}Missing`]), 'missing'],
    },
    nodes: [
      run('asked', 'Read the record', '@storage/store.port.json#get', { ...store, key: '{{in.id}}' }),
      route({
        id: 'route',
        label: 'Is it there, and what does it hold?',
        in: { record: '{{asked.record}}' },
        rules: branches.map(one => ({ when: one.when, to: one.id })),
        otherwise: 'missing',
      }),
      ...branches.flatMap(one => branchNodes(one, write, store)),
      run('missing', 'No such record', '@std/outcome.port.json#refuse', {
        reason: 'missing',
        message: 'no record {{in.id}}',
        type: 'TODO',
      }),
    ],
  };
}

/** The one node a bare `wilanis new graph` writes: something that runs, for a reader to replace. */
function oneNode(): Record<string, unknown> {
  return {
    description: 'TODO',
    nodes: [run('first', 'TODO', '@std/text.port.json#fill', { values: {}, template: 'hello' })],
    out: { type: 'string', from: 'first' },
  };
}

/**
 * What `wilanis new graph` writes, and the layer it belongs in. With --store it is the read-decide-write shape,
 * which reaches a store and so is a data graph whatever --layer says; without it, one node in the layer asked for.
 */
export function graphScaffold(
  opts: Record<string, string | undefined>,
  schemaOf: (kind: Kind) => string,
): { layer: 'domain' | 'data'; doc: Record<string, unknown> } {
  if (opts.store === undefined && opts.collection === undefined && opts['read-then'] === undefined)
    return { layer: opts.layer === 'data' ? 'data' : 'domain', doc: { $schema: schemaOf('graph'), ...oneNode() } };
  return { layer: 'data', doc: { $schema: schemaOf('graph'), ...readDecideWrite(opts) } };
}
