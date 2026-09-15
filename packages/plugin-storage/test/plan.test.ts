/**
 * The planner, pure: the steps from what a database recorded to what the tree declares (RFC 0017). No engine,
 * no connection and no row count -- what a step would cost is said in `loses` and counted elsewhere.
 *
 * One `it` per row of the RFC's Tests table, in its order.
 */
import { type Type, TypeResolver } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { type Declared, declaredOf, type Marks, marksOf, plan } from '../src/plan.js';

const types = new TypeResolver(() => undefined);

/** The RFC 0003 example's `Entry` shape, as `entries` keeps it. */
const ENTRY: Type = types.inline({
  fields: {
    id: { type: 'string' },
    url: { type: 'string' },
    method: { type: 'string' },
    ua: { type: 'string', required: false },
  },
});

/** The `entries` collection as the example declares it: keyed by id, one url per method. */
const ENTRIES: Declared = declaredOf({ of: '@x/Entry.shape.json', key: 'id', unique: [['url', 'method']] }, ENTRY);

/** The `notes` collection: a note of an entry, so it references one. */
const NOTES: Declared = declaredOf(
  { of: '@x/Note.shape.json', key: 'id', refs: { entryId: { collection: 'entries' } } },
  types.inline({ fields: { id: { type: 'string' }, entryId: { type: 'string' }, body: { type: 'string' } } }),
);

/** `notes` under its name now, with a `title` the record has never held: what `"was": "notes"` declares. */
const DRAFTS: Declared = declaredOf(
  { of: '@x/Note.shape.json', key: 'id', refs: { entryId: { collection: 'entries' } }, was: 'notes' },
  types.inline({
    fields: {
      id: { type: 'string' },
      entryId: { type: 'string' },
      body: { type: 'string' },
      title: { type: 'string', required: false },
    },
  }),
);

/** The same `entries`, with `ua` renamed `agent` in the shape and nothing else changed. */
const RENAMED: Declared = declaredOf(
  { of: '@x/Entry.shape.json', key: 'id', unique: [['url', 'method']] },
  types.inline({
    fields: {
      id: { type: 'string' },
      url: { type: 'string' },
      method: { type: 'string' },
      agent: { type: 'string', required: false },
    },
  }),
);

/** A declaration of `entries` with one field changed from the shape above. */
function entriesWith(fields: Record<string, { type: string; required?: boolean }>): Declared {
  return declaredOf(
    { of: '@x/Entry.shape.json', key: 'id', unique: [['url', 'method']] },
    types.inline({
      fields: { id: { type: 'string' }, url: { type: 'string' }, method: { type: 'string' }, ...fields },
    }),
  );
}

const noMarks: Marks = { entries: {}, notes: {} };
const does = (steps: { do: string }[]) => steps.map(step => step.do);

describe('how a collection comes to exist', () => {
  it('nothing recorded and nothing in the catalog: one create per declared collection', () => {
    const { steps } = plan({}, { entries: ENTRIES, notes: NOTES }, noMarks);
    expect(does(steps)).toEqual(['create', 'create']);
    expect(steps.map(step => step.target)).toEqual(['entries', 'notes']);
    expect(steps[0].says).toBe('create collection entries');
    // a collection that is not there yet has no field step: creating it is the whole of it
    expect(steps.every(step => step.at === undefined)).toBe(true);
  });

  it('the RFC 0003 example against its own record: no step', () => {
    const recorded = { entries: ENTRIES, notes: NOTES };
    expect(plan(recorded, { entries: ENTRIES, notes: NOTES }, noMarks)).toEqual({ steps: [], stale: [] });
  });

  it('a table in the catalog with no record: adopt, then the field steps against the adopted declared', () => {
    // the catalog holds entries as it stood before `note` was declared, so the adopt is followed by the add
    const declared = entriesWith({
      ua: { type: 'string', required: false },
      note: { type: 'string', required: false },
    });
    const { steps } = plan({}, { entries: declared }, { entries: {} }, { entries: ENTRIES });
    expect(does(steps)).toEqual(['adopt', 'add']);
    expect(steps[0].says).toBe('adopt collection entries (from the database as it stands)');
    expect(steps[1].at).toBe('note');
  });
});

describe('a collection that is gone, and one that took its place', () => {
  it('notes no longer declared: drop collection notes, and what it loses is every row', () => {
    const { steps } = plan({ entries: ENTRIES, notes: NOTES }, { entries: ENTRIES }, { entries: {} });
    expect(does(steps)).toEqual(['drop']);
    expect(steps[0]).toMatchObject({ target: 'notes', says: 'drop collection notes', loses: 'every row of notes' });
  });

  it('notes gone and drafts declared with was: one renameCollection, then field steps against notes’s record', () => {
    const marks: Marks = { entries: {}, drafts: marksOf({ of: '@x/Note.shape.json', key: 'id', was: 'notes' }) };
    const { steps, stale } = plan({ entries: ENTRIES, notes: NOTES }, { entries: ENTRIES, drafts: DRAFTS }, marks);
    expect(does(steps)).toEqual(['renameCollection', 'add']);
    expect(steps[0]).toMatchObject({ target: 'drafts', from: 'notes', says: 'rename collection notes → drafts' });
    expect(steps[1]).toMatchObject({ target: 'drafts', at: 'title' });
    // nothing has applied on the run that plans the rename, so the mark is not stale yet
    expect(stale).toEqual([]);
  });

  it('the run after: drafts recorded under its own name and notes gone, so the was mark is stale', () => {
    const marks: Marks = { entries: {}, drafts: marksOf({ of: '@x/Note.shape.json', key: 'id', was: 'notes' }) };
    const { steps, stale } = plan({ entries: ENTRIES, drafts: DRAFTS }, { entries: ENTRIES, drafts: DRAFTS }, marks);
    expect(steps).toEqual([]);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ target: 'drafts', says: 'was.drafts has been applied' });
    expect(stale[0].hint).toContain('"was": "notes"');
  });
});

describe('a field that changed its name', () => {
  it('ua gone and agent added with no renamed: remove ua and add agent, and the remove says what it loses', () => {
    const { steps } = plan({ entries: ENTRIES }, { entries: RENAMED }, { entries: {} });
    expect(does(steps)).toEqual(['add', 'remove']);
    expect(steps[0]).toMatchObject({ at: 'agent', says: 'add agent  string, optional' });
    expect(steps[1]).toMatchObject({ at: 'ua', loses: 'values of ua in every row that holds one' });
  });

  it('the same with renamed agent ← ua: one rename, and a second run says the mark is stale', () => {
    const marks: Marks = { entries: { renamed: { agent: 'ua' } } };
    const first = plan({ entries: ENTRIES }, { entries: RENAMED }, marks);
    expect(does(first.steps)).toEqual(['rename']);
    expect(first.steps[0]).toMatchObject({ at: 'agent', from: 'ua', says: 'rename ua → agent' });
    expect(first.stale).toEqual([]);

    // the record now holds `agent`; the mark is noise for the next reader and a lie to the next fresh database
    const second = plan({ entries: RENAMED }, { entries: RENAMED }, marks);
    expect(second.steps).toEqual([]);
    expect(second.stale[0]).toMatchObject({ target: 'entries', at: 'agent', says: 'renamed.agent has been applied' });
    expect(second.stale[0].hint).toContain('"renamed": { "agent": "ua" }');
  });

  it('renamed agent ← ua with both recorded: the mark is done, and agent reads as itself', () => {
    // RFC 0017 point 4 wants the old name in the record *and the new one not*: renaming ua onto an agent that
    // already exists is not a rename, so the mark is stale and the record's own ua is what is dropped
    const both = declaredOf(
      { of: '@x/Entry.shape.json', key: 'id', unique: [['url', 'method']] },
      types.inline({
        fields: {
          id: { type: 'string' },
          url: { type: 'string' },
          method: { type: 'string' },
          ua: { type: 'string', required: false },
          agent: { type: 'string', required: false },
        },
      }),
    );
    const marks: Marks = { entries: { renamed: { agent: 'ua' } } };
    const { steps, stale } = plan({ entries: both }, { entries: RENAMED }, marks);
    expect(does(steps)).toEqual(['remove']);
    expect(steps[0]).toMatchObject({ at: 'ua' });
    expect(stale[0]).toMatchObject({ target: 'entries', at: 'agent', says: 'renamed.agent has been applied' });
  });

  it('renamed agent ← nope, with nope not in the record: refused, and the hint names the record’s fields', () => {
    const { steps } = plan({ entries: ENTRIES }, { entries: RENAMED }, { entries: { renamed: { agent: 'nope' } } });
    const refused = steps.filter(step => step.refused);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ do: 'rename', at: 'agent', from: 'nope' });
    expect(refused[0].refused).toContain('id, url, method, ua');
  });
});

describe('a field added, removed or changed', () => {
  it('note added optional and agent added with defaults: add, and the default is what a row already there receives', () => {
    const declared = entriesWith({
      ua: { type: 'string', required: false },
      note: { type: 'string', required: false },
      agent: { type: 'string', required: false },
    });
    const marks: Marks = { entries: { defaults: { agent: 'unknown' } } };
    const { steps } = plan({ entries: ENTRIES }, { entries: declared }, marks);
    expect(does(steps)).toEqual(['add', 'add']);
    expect(steps[0]).toMatchObject({ at: 'note', says: 'add note  string, optional' });
    expect(steps[0].default).toBeUndefined();
    expect(steps[1]).toMatchObject({
      at: 'agent',
      default: 'unknown',
      says: 'add agent  string, optional, default "unknown"',
    });
  });

  it('note added required with no default: add, and it says what the empty rows would cost', () => {
    // every row already there has nothing to put in the column, so the step costs what `require` costs and
    // step 4 classes it from the count: refused unless allowed as destructive
    const declared = entriesWith({ ua: { type: 'string', required: false }, note: { type: 'string' } });
    const bare = plan({ entries: ENTRIES }, { entries: declared }, { entries: {} });
    expect(does(bare.steps)).toEqual(['add']);
    expect(bare.steps[0]).toMatchObject({ at: 'note', says: 'add note  string, required', loses: 'rows with no note' });

    // a default says what every empty row receives, so nothing is at stake and the step is additive
    const given = plan({ entries: ENTRIES }, { entries: declared }, { entries: { defaults: { note: 'none' } } });
    expect(given.steps[0]).toMatchObject({
      at: 'note',
      default: 'none',
      says: 'add note  string, required, default "none"',
    });
    expect(given.steps[0].loses).toBeUndefined();
  });

  it('method from string to number: retype, and what it loses is what no cast carries', () => {
    const { steps } = plan(
      { entries: ENTRIES },
      { entries: entriesWith({ method: { type: 'number' }, ua: { type: 'string', required: false } }) },
      { entries: {} },
    );
    expect(does(steps)).toEqual(['retype']);
    expect(steps[0]).toMatchObject({ at: 'method', was: 'string', says: 'retype method  string → number' });
    expect(steps[0].loses).toBe('values of method no cast can carry from string to number');
  });

  it('ua required now: require, with the default where the store declares one and the empty rows it loses otherwise', () => {
    const declared = entriesWith({ ua: { type: 'string' } });
    const bare = plan({ entries: ENTRIES }, { entries: declared }, { entries: {} });
    expect(does(bare.steps)).toEqual(['require']);
    expect(bare.steps[0]).toMatchObject({ at: 'ua', says: 'require ua', loses: 'rows with no ua' });
    expect(bare.steps[0].default).toBeUndefined();

    // a default turns the step additive: every empty row has something to receive
    const withDefault = plan({ entries: ENTRIES }, { entries: declared }, { entries: { defaults: { ua: 'unknown' } } });
    expect(withDefault.steps[0]).toMatchObject({ default: 'unknown', says: 'require ua, default "unknown"' });
  });

  it('ua optional now where it was required: relax, and nothing is lost', () => {
    const required = entriesWith({ ua: { type: 'string' } });
    const { steps } = plan({ entries: required }, { entries: ENTRIES }, { entries: {} });
    expect(does(steps)).toEqual(['relax']);
    expect(steps[0]).toMatchObject({ at: 'ua', says: 'relax ua' });
    // relaxing costs no data: a required field becoming optional loses a guarantee and nothing else
    expect(steps[0].loses).toBeUndefined();
  });
});

describe('a constraint added or dropped', () => {
  it('[url] added to unique, and [url, method] removed: unique and ununique', () => {
    const declared = declaredOf({ of: '@x/Entry.shape.json', key: 'id', unique: [['url']] }, ENTRY);
    const { steps } = plan({ entries: ENTRIES }, { entries: declared }, { entries: {} });
    expect(does(steps)).toEqual(['unique', 'ununique']);
    expect(steps[0]).toMatchObject({ at: 'url', over: ['url'], says: 'unique   [url]' });
    expect(steps[1]).toMatchObject({ over: ['url', 'method'], says: 'ununique [url, method]' });
    expect(steps[1].loses).toBe('the guarantee that no two rows repeat [url, method]');
  });

  it('entryId refs added, and removed: ref and unref', () => {
    const without = declaredOf(
      { of: '@x/Note.shape.json', key: 'id' },
      types.inline({ fields: { id: { type: 'string' }, entryId: { type: 'string' }, body: { type: 'string' } } }),
    );
    const added = plan({ notes: without }, { notes: NOTES }, { notes: {} });
    expect(does(added.steps)).toEqual(['ref']);
    expect(added.steps[0]).toMatchObject({ at: 'entryId', to: 'entries', says: 'ref      entryId → entries' });

    const dropped = plan({ notes: NOTES }, { notes: without }, { notes: {} });
    expect(does(dropped.steps)).toEqual(['unref']);
    expect(dropped.steps[0]).toMatchObject({ at: 'entryId', to: 'entries', says: 'unref    entryId → entries' });
  });

  it('entryId refs moved from entries to users: unref the old and ref the new, never silence', () => {
    // a reference is the pair (field, collection): comparing on the field alone would leave the record
    // disagreeing with the database, since the field is in both and neither step would fire
    const toUsers = declaredOf(
      { of: '@x/Note.shape.json', key: 'id', refs: { entryId: { collection: 'users' } } },
      types.inline({ fields: { id: { type: 'string' }, entryId: { type: 'string' }, body: { type: 'string' } } }),
    );
    const { steps } = plan({ notes: NOTES }, { notes: toUsers }, { notes: {} });
    expect(does(steps)).toEqual(['ref', 'unref']);
    expect(steps[0]).toMatchObject({ at: 'entryId', to: 'users', says: 'ref      entryId → users' });
    expect(steps[1]).toMatchObject({ at: 'entryId', to: 'entries', says: 'unref    entryId → entries' });
  });
});

describe('what no count can make possible', () => {
  it('key from id to slug: refused, and the hint says declare, copy and drop', () => {
    const declared = declaredOf(
      { of: '@x/Entry.shape.json', key: 'slug', unique: [['url', 'method']] },
      types.inline({
        fields: {
          slug: { type: 'string' },
          url: { type: 'string' },
          method: { type: 'string' },
          ua: { type: 'string', required: false },
        },
      }),
    );
    const { steps } = plan({ entries: ENTRIES }, { entries: declared }, { entries: {} });
    const refused = steps.filter(step => step.refused);
    expect(refused[0]).toMatchObject({ target: 'entries', at: 'slug', says: 'key id → slug' });
    expect(refused[0].refused).toContain('declare it');
    expect(refused[0].refused).toContain('one-off graph');
    // its own verb, so an engine that dispatches on `do` never reads a refused key change as a cast
    expect(refused[0].do).toBe('rekey');
  });
});
