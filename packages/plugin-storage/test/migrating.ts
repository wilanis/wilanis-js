/**
 * What the `migrate` member's cases are driven against: a tree with two connections, and a fake engine that
 * behaves like a database rather than like a stub (RFC 0017).
 *
 * The engine here is deliberately unforgiving. A fake that answered zero rows for anything asked would let a
 * plan that counts rows in a table it has not created yet pass green and fail against PostgreSQL, which is
 * exactly what happened once: so this one throws `relation "<target>" does not exist` for a collection neither
 * its record nor its catalog has ever seen, and answers a row count only for a collection it holds. What the
 * cases pin is the member, and what the engine pins is that the member never asks a database a question the
 * database cannot answer.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildEnv } from '@wilanis/compiler';
import { loadTree, type MigrateContext, type PluginModule, Scope, schemaRef } from '@wilanis/core';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import type { Applied, Applying, Declared, Engine, On, Recording, Step } from '../src/index.js';
import storage, { engines } from '../src/index.js';
import { ENGINE, KIND, engine as kindPlugin } from './harness.js';

export const ENTRIES = '@connections/entries.connection.json';
export const NOTES = '@connections/notes.connection.json';

/** What a case says a connection already holds: the record, the catalog beside it, and the rows in the way. */
export interface Holding {
  /** what the record says a collection is, by name */
  recorded?: Record<string, Declared>;
  /** what the catalog holds for a collection the record has never seen, by name */
  found?: Record<string, Declared>;
  /** what the catalog holds for a collection the record *has* seen, where a case makes the two disagree */
  catalog?: Record<string, Declared>;
  /** how many rows stand in a step's way, by the collection the step is about */
  rows?: Record<string, number>;
}

/** What the fake engine was asked to do, so a case can say which steps reached it and on which connection. */
export interface Asked {
  applied: Ran[];
  counted: Step[];
}

/** One plan the fake engine applied, as it remembers it: what reached it, and who said they were running it. */
interface Ran {
  on: string;
  steps: Step[];
  record: Recording;
  applying: Applying;
}

/**
 * The name this fake keeps a collection under: the folded one, as PostgreSQL's is, because that is the harder
 * of the two contracts and the one a mistake hides behind. An engine that folds answers its record and its
 * history under a name that is not always the tree's spelling, so a planner reading both would see two
 * collections where there is one -- and plan a `drop` of the live table. Folding here is what makes a case
 * over `auditLog` able to catch that; a fake that kept names as given never could.
 */
const folded = (collection: string) => collection.toLowerCase();

/** A table of a case's own, read under the name the engine keeps, so a case may write the tree's spelling. */
const under = <T>(table: Record<string, T> | undefined, collection: string): T | undefined =>
  table && Object.entries(table).find(([name]) => folded(name) === folded(collection))?.[1];

/**
 * One applied plan as the fake engine records it, so the answer reads as a real one and not as a placeholder.
 * Every collection is named the way the engine keeps it -- folded -- since that is what a record keyed by the
 * table's own name answers back, and it is exactly the spelling a plan must not mistake for a second table.
 */
function recordOf(ran: Ran, id: number): Applied {
  const { steps, record } = ran;
  const targets = Object.keys(record).map(folded);
  return {
    id,
    appliedAt: '2026-09-11T09:14:02.000Z',
    by: ran.applying.by,
    tree: ran.applying.tree,
    connection: ran.on,
    targets,
    steps: Object.fromEntries(
      targets.map(name => [name, steps.filter(step => folded(step.target) === name).map(step => step.says)]),
    ),
  };
}

/**
 * An engine over the tables a case fills, which refuses what a database would refuse. A count against a
 * collection it has never heard of is not zero rows: it is the error PostgreSQL answers, and a plan that asks
 * for one has a bug the count would otherwise hide. Every name it answers is folded, as that engine's are.
 */
export function fake(holding: Record<string, Holding>, opts: { keeps?: boolean } = {}) {
  const asked: Asked = { applied: [], counted: [] };
  const held = (on: On) => holding[on.connection] ?? {};
  const engine = {
    async recorded(on: On, collection: string) {
      return under(held(on).recorded, collection);
    },
    async inspect(on: On, collection: string) {
      const one = held(on);
      return under(one.catalog, collection) ?? under(one.found, collection);
    },
    async rows(on: On, step: Step) {
      asked.counted.push(step);
      const one = held(on);
      const exists =
        under(one.recorded, step.target) ?? under(one.catalog, step.target) ?? under(one.found, step.target);
      if (!exists) throw new Error(`relation "${folded(step.target)}" does not exist`);
      return under(one.rows, step.target) ?? 0;
    },
    async apply(on: On, steps: Step[], record: Recording, applying: Applying) {
      const ran: Ran = { on: on.connection, steps, record, applying };
      asked.applied.push(ran);
      return recordOf(ran, asked.applied.length);
    },
    // a record holding a collection got there by a plan that applied, so the history names it: a real database
    // reads both out of one table, and a fake whose history forgot what its own record holds would let a plan
    // that never looks past the tree's own collections pass green. The names are folded, as the record's are
    async history(on: On) {
      const seeded = Object.keys(held(on).recorded ?? {});
      const earlier: Ran[] = seeded.length
        ? [
            {
              on: on.connection,
              steps: [],
              record: Object.fromEntries(seeded.map(name => [name, null])),
              applying: { by: 'deploy@ci', tree: 'kept' },
            },
          ]
        : [];
      const since = asked.applied.filter(one => one.on === on.connection);
      return [...since.map((one, at) => recordOf(one, at + 1)).reverse(), ...earlier.map(one => recordOf(one, 0))];
    },
    named: folded,
    attempts: () => true,
    keeps: () => opts.keeps !== false,
  } as unknown as Engine;
  return { engine, asked };
}

/** One collection as a store declares it, with the marks RFC 0017 adds. */
type Declares = { of: string; key: string; unique?: string[][]; renamed?: Record<string, string>; was?: string };

/** The tree the cases plan: two connections, each with a store of its own, over two shapes that differ by a name. */
function documents(collections: { entries: Record<string, Declares>; notes: Record<string, Declares> }) {
  const connection = (name: string) => ({
    $schema: schemaRef('connection'),
    description: `where the ${name} live`,
    kind: KIND,
    settings: {},
  });
  return {
    'project.json': {
      $schema: schemaRef('project'),
      name: 'kept',
      description: 'a tree that keeps what it observes, over two connections',
      plugins: [{ use: '@std' }, { use: '@storage' }, { use: ENGINE }],
    },
    'connections/entries.connection.json': connection('entries'),
    'connections/notes.connection.json': connection('notes'),
    'features/monitor/feature.json': { $schema: schemaRef('feature'), description: 'what the monitor observes' },
    'features/monitor/domain/Entry.shape.json': {
      $schema: schemaRef('shape'),
      description: 'one observed call',
      layer: 'core',
      fields: { id: { type: 'string' }, url: { type: 'string' }, ua: { type: 'string', required: false } },
    },
    'features/monitor/domain/Renamed.shape.json': {
      $schema: schemaRef('shape'),
      description: 'the same call, with the user agent under the name a rename gave it',
      layer: 'core',
      fields: { id: { type: 'string' }, url: { type: 'string' }, agent: { type: 'string', required: false } },
    },
    'features/monitor/data/entries.store.json': {
      $schema: schemaRef('store'),
      description: 'the entries kept so far',
      connection: ENTRIES,
      collections: collections.entries,
    },
    'features/monitor/data/notes.store.json': {
      $schema: schemaRef('store'),
      description: 'the notes kept so far',
      connection: NOTES,
      collections: collections.notes,
    },
  };
}

/** The shape most collections of these cases keep: an id, a url and an optional user agent. */
export const SHAPE = '@features/monitor/domain/Entry.shape.json';

/** The same shape with the agent under the name a rename gave it, so a `renamed` mark has something to name. */
export const RENAMED_SHAPE = '@features/monitor/domain/Renamed.shape.json';

/** `entries` as the tree declares it, with whatever marks a case adds. */
export const declares = (over: Partial<Declares> = {}): Declares => ({ of: SHAPE, key: 'id', ...over });

/** What a case varies about the tree it plans: the collections each connection's store declares. */
export interface Trees {
  entries?: Record<string, Declares>;
  notes?: Record<string, Declares>;
}

/** Write a tree into a directory of its own, which the operating system clears. */
function write(docs: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-storage-migrate-'));
  for (const [relative, doc] of Object.entries(docs)) {
    if (typeof doc !== 'object') continue;
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  return dir;
}

/** Every plugin these cases load: the built-ins, @storage itself, and the fake kind a store may name. */
const PLUGINS: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, '@storage': storage, [ENGINE]: kindPlugin };

/**
 * The context `migrate` is given, over a tree written for the case and an engine registered the way a real one
 * registers itself: in the table the environment carries, under the connection kind it grants.
 */
export function context(trees: Trees = {}, opts: { adopt?: boolean; allowDestructive?: string[] } = {}) {
  const dir = write(
    documents({
      entries: trees.entries ?? { entries: declares() },
      notes: trees.notes ?? { notes: declares() },
    }),
  );
  const load = loadTree(dir, PLUGINS);
  const scope = new Scope(load.registry, load.resolve);
  const { env } = buildEnv(scope);
  const ctx: MigrateContext = {
    root: dir,
    registry: load.registry,
    scope,
    settings: {},
    env,
    log: () => undefined,
    profile: 'default',
    allowDestructive: opts.allowDestructive ?? [],
    adopt: opts.adopt ?? false,
  };
  return { ctx, env, register: (engine: Engine) => engines(env).register(KIND, engine) };
}

/** The steps of one target, as `do` and `says`, which is what a case reads a plan by. */
export const said = (steps: { do: string; says: string }[]) => steps.map(step => `${step.do} ${step.says}`);
