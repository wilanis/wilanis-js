/**
 * The graph `wilanis new graph` writes. A graph is the one kind with several forms worth scaffolding, so it lives
 * beside the rest rather than among them: the bare one node a reader replaces; with --port and with --store, the
 * load-make-keep pair a change to a record takes (scaffold-keep.ts); and with --read-then, the read-decide-write
 * shape a data graph takes when it decides from a record it first read whether to replace or remove it. Nothing
 * here is a rule of the language; it is what the shape looks like written out, with TODO where a value goes.
 *
 * Every id is named for what the node holds once it has answered, from what the author gave: the shape the
 * record is of (--type, else the collection's `of` in the store), the write --read-then names, the branch ids
 * --branch typed. `storedCustomer` is the read, `noCustomer` the refusal where there was none, and each branch's
 * write is its own id, answered as `<branch>Customer` or refused as `goneBefore<Branch>`.
 *
 * No form writes a `#patch`. A patch of a field an invariant reads is I007, and which fields a patch changes is
 * what a scaffold leaves TODO, so a tool that wrote one could not tell a patch the checker will take from one it
 * will refuse.
 */
import type { Kind } from '@wilanis/core';
import { keepWhole, loadMakeKeep } from './scaffold-keep.js';
import { nounOf, type Opts, raised, route, run, storedShape, storeOf } from './scaffold-parts.js';

/** One branch of the decision: the id its nodes are named after, and the expression that routes to it. */
interface Branch {
  id: string;
  when: string;
}

/** The store operation a branch writes with: what --read-then names. */
const WRITES = ['put', 'remove'] as const;
type Write = (typeof WRITES)[number];

/** What each write is called once it has run, which is the id of the one branch a bare --branch scaffolds. */
const WRITTEN: Record<Write, string> = { put: 'replaced', remove: 'removed' };

/** Why `--read-then patch` is not scaffolded, and the two forms that change a record instead. */
const PATCH =
  '--read-then patch is not scaffolded: a record is changed whole (RFC 0035). --port <port> writes the domain graph that loads it and lays the change over it with #merge, and --store <store> --collection <name> the data graph that #puts it; a patch of a field no invariant reads is one #patch node, written by hand';

/** The write --read-then names; a patch, or anything else that is no write, is refused with what to write instead. */
function writeOf(named: string | undefined): Write {
  if ((WRITES as readonly string[]).includes(named ?? '')) return named as Write;
  if (named === 'patch') throw new Error(PATCH);
  // a flag given bare arrives as 'true' (flagValue in cli.ts), which is no word the author wrote
  const word = named && named !== 'true' ? `, not '${named}'` : '';
  throw new Error(`--read-then takes put or remove${word}`);
}

/**
 * What a branch's write takes beyond the store and the collection: a put writes the whole record the graph takes,
 * read whole from `in`, where it was judged (I008 refuses one composed at the write); a remove, the key.
 */
function writeInput(write: Write): Record<string, unknown> {
  return write === 'put' ? { record: '{{in}}' } : { key: '{{in.id}}' };
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
  // both put and remove answer `record`, absent where there was none to write, so one switch does
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
function readDecideWrite(opts: Opts, root: string): Record<string, unknown> {
  const write = writeOf(opts['read-then']);
  const store = storeOf(opts);
  const shaped = { store, write, noun: nounOf(opts.type ?? storedShape(root, opts)), type: opts.type ?? 'TODO' };
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

/** The forms `wilanis new graph` writes, by what their flags ask for. */
type Form = 'domain' | 'keep' | 'readDecideWrite' | 'oneNode';

/** Which form the flags ask for; flags that ask for two at once, or a --branch with no write, are refused. */
function formOf(opts: Opts): Form {
  if (opts.port !== undefined) {
    if (opts.store === undefined && opts['read-then'] === undefined) return 'domain';
    throw new Error(
      '--port writes the domain graph that loads, makes and keeps a record, and --store the data graph behind its write; give one',
    );
  }
  if (opts['read-then'] !== undefined) return 'readDecideWrite';
  if (opts.branch !== undefined)
    throw new Error('--branch routes the read-decide-write form; give --read-then put|remove');
  return opts.store !== undefined || opts.collection !== undefined ? 'keep' : 'oneNode';
}

/**
 * What `wilanis new graph` writes, and the layer it belongs in. With --port it is the domain half of the
 * load-make-keep pair; with --store, or --read-then, a form that reaches a store and so is a data graph whatever
 * --layer says; with neither, one node in the layer asked for. The tree's root is where the store, the port and
 * the shape are read from, for the noun the ids are named after and the fields a write takes.
 */
export function graphScaffold(
  opts: Opts,
  schemaOf: (kind: Kind) => string,
  root: string,
): { layer: 'domain' | 'data'; doc: Record<string, unknown> } {
  const graph = (layer: 'domain' | 'data', doc: Record<string, unknown>) => ({
    layer,
    doc: { $schema: schemaOf('graph'), ...doc },
  });
  const form = formOf(opts);
  if (form === 'domain') return graph('domain', loadMakeKeep(opts, root));
  if (form === 'keep') return graph('data', keepWhole(opts, root));
  if (form === 'readDecideWrite') return graph('data', readDecideWrite(opts, root));
  return graph(opts.layer === 'data' ? 'data' : 'domain', oneNode());
}
