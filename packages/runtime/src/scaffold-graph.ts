/**
 * The graph `wilanis new graph` writes. A graph is the one kind with two forms worth scaffolding, so it lives
 * beside the rest rather than among them: the bare one node a reader replaces, and, with --store, the
 * read-decide-write shape a data graph takes whenever it changes a record it first read. Nothing here is a rule
 * of the language; it is what the shape looks like written out, with TODO where a value goes.
 *
 * Every id is named for what the node holds once it has answered, from what the author gave: the shape the
 * record is of (--type, else the collection's `of` in the store), the write --read-then names, the branch ids
 * --branch typed. `storedCustomer` is the read, `noCustomer` the refusal where there was none, and each branch's
 * write is its own id, answered as `<branch>Customer` or refused as `goneBefore<Branch>`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Kind, makeResolver, stem } from '@wilanis/core';

/** One branch of the decision: the id its nodes are named after, and the expression that routes to it. */
interface Branch {
  id: string;
  when: string;
}

/** The store operation a branch writes with: what --read-then names. */
const WRITES = ['patch', 'put', 'remove'] as const;
type Write = (typeof WRITES)[number];

/** What each write is called once it has run, which is the id of the one branch a bare --branch scaffolds. */
const WRITTEN: Record<Write, string> = { patch: 'patched', put: 'replaced', remove: 'removed' };

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
function route(routing: Routing): Record<string, unknown> {
  const { otherwise, ...rest } = routing;
  return { type: '@wilanis/node/switch.schema.json', ...rest, else: otherwise };
}

/** A word with its first letter raised, to join it onto another: customer becomes Customer. */
const raised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** A word with its first letter lowered, to start an id with it: Customer becomes customer. */
const lowered = (word: string) => word.charAt(0).toLowerCase() + word.slice(1);

/** What the store names as the shape of a collection, read off the store document when the tree has it. */
function storedShape(root: string, store: string, collection: string): string | undefined {
  const project = join(root, 'project.json');
  const aliases = existsSync(project)
    ? ((JSON.parse(readFileSync(project, 'utf8')) as { aliases?: Record<string, string> }).aliases ?? {})
    : {};
  const path = makeResolver(aliases, new Set())(store);
  if (!path.startsWith('@features/')) return undefined;
  const file = join(root, path.slice(1));
  if (!existsSync(file)) return undefined;
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { collections?: Record<string, { of?: string }> };
  return doc.collections?.[collection]?.of;
}

/** The noun every id is built on: the stem of the shape the record is of, or `record` where nothing says. */
function nounOf(opts: Record<string, string | undefined>, root: string): string {
  const shape = opts.type ?? (opts.store && opts.collection ? tryStoredShape(root, opts) : undefined);
  const named = shape ? lowered(stem(shape)) : '';
  return /^[a-z][A-Za-z0-9]*$/.test(named) ? named : 'record';
}

/** The store's word for the collection's shape, or nothing where the store is not there to read or not JSON. */
function tryStoredShape(root: string, opts: Record<string, string | undefined>): string | undefined {
  try {
    return storedShape(root, opts.store ?? '', opts.collection ?? '');
  } catch {
    return undefined;
  }
}

/** What a branch's write takes beyond the store and the collection: a patch changes fields, a put writes a record. */
function writeInput(write: Write): Record<string, unknown> {
  if (write === 'put') return { record: 'TODO' };
  if (write === 'patch') return { key: '{{in.id}}', changes: { TODO: 'TODO' } };
  return { key: '{{in.id}}' };
}

/** What `--branch <id>:<when>` gave, as pairs. Repeating the flag adds one; a bare --branch scaffolds one to rename. */
function branchesOf(written: string | undefined, write: Write): Branch[] {
  const given = (written ?? '')
    .split(/[\n,]/)
    .map(one => one.trim())
    .filter(one => one.length > 0 && one !== 'true');
  if (!given.length) return [{ id: WRITTEN[write], when: 'has(record)' }];
  return given.map(one => {
    const at = one.indexOf(':');
    if (at < 1 || at === one.length - 1)
      throw new Error(
        `--branch '${one}' is not <id>:<when>, as in --branch archived:"has(record) && !has(record.note)"`,
      );
    return { id: one.slice(0, at).trim(), when: one.slice(at + 1).trim() };
  });
}

/** What the read-decide-write graph is written from: the store it reaches, the write, the noun and the type. */
interface Shaped {
  store: Record<string, string>;
  write: Write;
  noun: string;
  type: string;
}

/** The ids one branch's nodes answer under: the record it answers, and the refusal where the record had gone. */
const leavesOf = (branch: Branch, noun: string) => ({
  answered: `${branch.id}${raised(noun)}`,
  gone: `goneBefore${raised(branch.id)}`,
});

/** The four nodes one branch is: the write, the switch on what it answered, the record it answers, the refusal. */
function branchNodes(branch: Branch, shaped: Shaped): Record<string, unknown>[] {
  const { answered, gone } = leavesOf(branch, shaped.noun);
  // every one of patch, put and remove answers `record`, absent where there was none to write, so one switch does
  return [
    run(branch.id, 'TODO: what this branch writes', `@storage/store.port.json#${shaped.write}`, {
      ...shaped.store,
      ...writeInput(shaped.write),
    }),
    route({
      id: `stillThereAfter${raised(branch.id)}`,
      label: 'Was it still there?',
      in: { record: `{{${branch.id}.record}}` },
      rules: [{ when: 'has(record)', to: answered }],
      otherwise: gone,
    }),
    run(answered, 'The record as it now stands', '@std/object.port.json#make', {
      value: `{{${branch.id}.record}}`,
      type: shaped.type,
    }),
    run(gone, 'It was gone by the time we wrote', '@std/outcome.port.json#refuse', {
      reason: 'missing',
      message: 'no record {{in.id}}',
      type: shaped.type,
    }),
  ];
}

/**
 * The read-decide-write graph: read one record by its key, decide from what it holds which write it takes, write
 * it, and answer the record the write gave back or refuse where it had gone. Every node a reader must fill says
 * TODO, and no rule of the language is new -- this is the shape written out, not a feature.
 */
function readDecideWrite(opts: Record<string, string | undefined>, root: string): Record<string, unknown> {
  const write = (WRITES as readonly string[]).includes(opts['read-then'] ?? '')
    ? (opts['read-then'] as Write)
    : 'patch';
  const store = { store: opts.store ?? '@features/TODO/data/TODO.store.json', collection: opts.collection ?? 'TODO' };
  const shaped = { store, write, noun: nounOf(opts, root), type: opts.type ?? 'TODO' };
  const branches = branchesOf(opts.branch, write);
  const [read, none] = [`stored${raised(shaped.noun)}`, `no${raised(shaped.noun)}`];
  const leaves = branches.flatMap(one => Object.values(leavesOf(one, shaped.noun)));
  return {
    description:
      'TODO. Read one record, decide from what it holds which write it takes, and answer what the write gave back.',
    in: 'TODO',
    out: { type: shaped.type, from: [...leaves, none] },
    nodes: [
      run(read, 'Read the record', '@storage/store.port.json#get', { ...store, key: '{{in.id}}' }),
      route({
        id: 'whichWrite',
        label: 'Is it there, and what does it hold?',
        in: { record: `{{${read}.record}}` },
        rules: branches.map(one => ({ when: one.when, to: one.id })),
        otherwise: none,
      }),
      ...branches.flatMap(one => branchNodes(one, shaped)),
      run(none, 'No such record', '@std/outcome.port.json#refuse', {
        reason: 'missing',
        message: 'no record {{in.id}}',
        type: shaped.type,
      }),
    ],
  };
}

/** The one node a bare `wilanis new graph` writes: something that runs, for a reader to replace. */
function oneNode(): Record<string, unknown> {
  return {
    description: 'TODO',
    nodes: [run('greeting', 'TODO', '@std/text.port.json#fill', { values: {}, template: 'hello' })],
    out: { type: 'string', from: 'greeting' },
  };
}

/**
 * What `wilanis new graph` writes, and the layer it belongs in. With --store it is the read-decide-write shape,
 * which reaches a store and so is a data graph whatever --layer says; without it, one node in the layer asked for.
 * The tree's root is where the store is read from, for the shape its ids are named after.
 */
export function graphScaffold(
  opts: Record<string, string | undefined>,
  schemaOf: (kind: Kind) => string,
  root: string,
): { layer: 'domain' | 'data'; doc: Record<string, unknown> } {
  if (opts.store === undefined && opts.collection === undefined && opts['read-then'] === undefined)
    return { layer: opts.layer === 'data' ? 'data' : 'domain', doc: { $schema: schemaOf('graph'), ...oneNode() } };
  return { layer: 'data', doc: { $schema: schemaOf('graph'), ...readDecideWrite(opts, root) } };
}
