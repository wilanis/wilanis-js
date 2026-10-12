/**
 * The small trees `rehearse-handed.test.ts` rehearses (RFC 0038): each hands a graph's `in` a value the rehearsal can
 * follow out to something it sets -- a value a map hands every element, a value a call copies from a node, an object a
 * call writes out, the trigger's input under another name, an element a map writes through a guard -- or, in the
 * people tree, a value a guard upstream judged first. Every tree passes the checker, since a case about the walk must
 * stand on a tree that does.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Kind, schemaUrl } from '@wilanis/core';
import {
  decide,
  edge,
  graph,
  HERE,
  ITEM,
  make,
  map,
  NUMBER,
  run,
  STRING,
  shape,
  treeOf,
  trigger,
} from './rehearse-stubs-trees.js';

/** The verdict every judging graph here answers with, one per branch of its switch. */
const VERDICT = { name: STRING, level: STRING };

/**
 * `all` scans, makes an `Info` from the scan's `run`, and maps `#judge` over the findings, binding `score` and `name`
 * of each and handing every element alike `previous`, from `{{info.run}}` (M2). `judge` decides on `in.score`, then on
 * `in.previous`: the second is steered only where the map's own `in` is followed out to `info`.
 */
export function broadcastTree(): string {
  const port = `${HERE}/domain/triage.port.json`;
  const asked = { target: STRING, list: { type: `${shape('Item')}[]` } };
  const verdict = shape('Verdict');
  return treeOf({
    'domain/Item.shape.json': { layer: 'core', fields: ITEM },
    'domain/Info.shape.json': { layer: 'core', fields: { run: STRING } },
    'domain/Scan.shape.json': { layer: 'core', fields: { run: STRING, findings: { type: `${shape('Item')}[]` } } },
    'domain/Verdict.shape.json': { layer: 'core', fields: VERDICT },
    'domain/JudgeIn.shape.json': { layer: 'core', fields: { ...ITEM, previous: STRING } },
    'domain/Ask.shape.json': { layer: 'core', fields: asked },
    'edge/ItemIn.shape.json': { layer: 'edge', fields: ITEM },
    'edge/AskIn.shape.json': {
      layer: 'edge',
      fields: { target: STRING, list: { type: `${edge('ItemIn')}[]`, maxItems: 10 } },
    },
    'edge/Out.shape.json': { layer: 'edge', fields: VERDICT },
    'domain/triage.port.json': {
      operations: {
        all: { description: 'd', accepts: asked, returns: `${verdict}[]` },
        scan: { description: 'd', accepts: asked, returns: shape('Scan') },
        judge: { description: 'd', accepts: { ...ITEM, previous: STRING }, returns: verdict },
      },
    },
    'data/triage.binding.json': {
      port,
      operations: {
        all: { graph: `${HERE}/domain/all.graph.json` },
        scan: { graph: `${HERE}/data/scan.graph.json` },
        judge: { graph: `${HERE}/domain/judge.graph.json` },
      },
    },
    'data/scan.graph.json': graph('Scan', shape('Ask'), { type: shape('Scan'), from: 's' }, [
      make('s', { run: '{{in.target}}', findings: '{{in.list}}' }, shape('Scan')),
    ]),
    'domain/all.graph.json': graph('All', shape('Ask'), { type: `${verdict}[]`, from: 'judged' }, [
      run('scanned', `${port}#scan`, { target: '{{in.target}}', list: '{{in.list}}' }),
      make('info', { run: '{{scanned.run}}' }, shape('Info')),
      map('judged', `${port}#judge`, {
        over: '{{scanned.findings}}',
        bind: { score: 'score', name: 'name' },
        in: { previous: '{{info.run}}' },
      }),
    ]),
    'domain/judge.graph.json': graph('Judge', shape('JudgeIn'), { type: verdict, from: ['high', 'first', 'low'] }, [
      decide('isHigh', { score: '{{in.score}}' }, [{ when: 'score > 5', to: 'isFirst' }], 'low'),
      decide('isFirst', { previous: '{{in.previous}}' }, [{ when: 'len(previous) == 0', to: 'first' }], 'high'),
      make('high', { name: '{{in.name}}', level: '{{in.previous}}' }, verdict),
      make('first', { name: '{{in.name}}', level: 'first' }, verdict),
      make('low', { name: '{{in.name}}', level: 'low' }, verdict),
    ]),
    'edge/triage.trigger.json': trigger('triage', { in: edge('AskIn'), out: `${edge('Out')}[]` }, `${port}#all`),
  });
}

/**
 * How `all` hands `#judge` the level it decides on: copied from its node `facts` (M16), inside an object it writes out,
 * or straight from the trigger's input under another name.
 */
export type Handed = 'node' | 'object' | 'renamed';

/** What `#judge` accepts under each way of handing, what `all` hands it, and the read its switch decides on. */
const HANDINGS: Record<Handed, { accepts: object; given: object; read: string }> = {
  node: { accepts: { level: STRING }, given: { level: '{{facts.level}}' }, read: '{{in.level}}' },
  object: {
    accepts: { meta: { type: shape('Meta') } },
    given: { meta: { level: '{{facts.level}}' } },
    read: '{{in.meta.level}}',
  },
  renamed: { accepts: { tier: STRING }, given: { tier: '{{in.level}}' }, read: '{{in.tier}}' },
};

/**
 * `all` makes `facts` from the trigger's target and calls `#judge`, bound to a graph whose switch decides on the level
 * it was handed. The call composes nothing, so each way of handing leads the read out to one thing the rehearsal sets.
 */
export function calledTree(handed: Handed): string {
  const port = `${HERE}/domain/level.port.json`;
  const verdict = shape('Verdict');
  const how = HANDINGS[handed];
  // the trigger hands the level itself where the call renames it, and a target `facts` is made from otherwise
  const asked = handed === 'renamed' ? { level: STRING } : { target: STRING };
  const facts = handed === 'renamed' ? [] : [make('facts', { level: '{{in.target}}' }, shape('Facts'))];
  return treeOf({
    'domain/Meta.shape.json': { layer: 'core', fields: { level: STRING } },
    'domain/Facts.shape.json': { layer: 'core', fields: { level: STRING } },
    'domain/Verdict.shape.json': { layer: 'core', fields: VERDICT },
    'domain/Ask.shape.json': { layer: 'core', fields: asked },
    'domain/JudgeIn.shape.json': { layer: 'core', fields: how.accepts },
    'edge/AskIn.shape.json': { layer: 'edge', fields: asked },
    'edge/Out.shape.json': { layer: 'edge', fields: VERDICT },
    'domain/level.port.json': {
      operations: {
        all: { description: 'd', accepts: asked, returns: verdict },
        judge: { description: 'd', accepts: how.accepts, returns: verdict },
      },
    },
    'data/level.binding.json': {
      port,
      operations: {
        all: { graph: `${HERE}/domain/all.graph.json` },
        judge: { graph: `${HERE}/domain/judge.graph.json` },
      },
    },
    'domain/all.graph.json': graph('All', shape('Ask'), { type: verdict, from: 'judged' }, [
      ...facts,
      run('judged', `${port}#judge`, how.given),
    ]),
    'domain/judge.graph.json': graph('Judge', shape('JudgeIn'), { type: verdict, from: ['high', 'low'] }, [
      decide('isHigh', { level: how.read }, [{ when: "level == 'high'", to: 'high' }], 'low'),
      make('high', { name: 'judged', level: 'high' }, verdict),
      make('low', { name: 'judged', level: 'low' }, verdict),
    ]),
    'edge/level.trigger.json': trigger('level', { in: edge('AskIn'), out: edge('Out') }, `${port}#all`),
  });
}

/**
 * `all` makes `facts` and calls `#judge` with its level; `judge` takes a `Level`, on which an invariant stands, so its
 * `in` is guarded at `in:check` and every read of `in` in it reads `in:ok`. It hands that level on to `#rate`, whose
 * graph decides on it: the read lands on `in:ok` in `judge`, and goes on as `in`, out to `facts`.
 */
export function throughGuardTree(): string {
  const port = `${HERE}/domain/level.port.json`;
  const verdict = shape('Verdict');
  const level = { level: STRING };
  const graphOf = (name: string) => `${HERE}/domain/${name}.graph.json`;
  return treeOf({
    'domain/Facts.shape.json': { layer: 'core', fields: level },
    'domain/Level.shape.json': { layer: 'core', fields: level },
    'domain/Verdict.shape.json': { layer: 'core', fields: VERDICT },
    'domain/Ask.shape.json': { layer: 'core', fields: { target: STRING } },
    'domain/a-level-is-named.invariant.json': {
      label: 'A level is named',
      holds: { on: shape('Level'), when: 'len(level) > 0' },
    },
    'edge/AskIn.shape.json': { layer: 'edge', fields: { target: STRING } },
    'edge/Out.shape.json': { layer: 'edge', fields: VERDICT },
    'domain/level.port.json': {
      operations: {
        all: { description: 'd', accepts: { target: STRING }, returns: verdict },
        judge: { description: 'd', accepts: level, returns: verdict },
        rate: { description: 'd', accepts: level, returns: verdict },
      },
    },
    'data/level.binding.json': {
      port,
      operations: Object.fromEntries(['all', 'judge', 'rate'].map(name => [name, { graph: graphOf(name) }])),
    },
    'domain/all.graph.json': graph('All', shape('Ask'), { type: verdict, from: 'judged' }, [
      make('facts', { level: '{{in.target}}' }, shape('Facts')),
      run('judged', `${port}#judge`, { level: '{{facts.level}}' }),
    ]),
    'domain/judge.graph.json': graph('Judge', shape('Level'), { type: verdict, from: 'named' }, [
      run('rated', `${port}#rate`, { level: '{{in.level}}' }),
      make('named', { name: '{{in.level}}', level: '{{rated.level}}' }, verdict),
    ]),
    'domain/rate.graph.json': graph('Rate', shape('Facts'), { type: verdict, from: ['high', 'low'] }, [
      decide('isHigh', { level: '{{in.level}}' }, [{ when: "level == 'high'", to: 'high' }], 'low'),
      make('high', { name: 'rated', level: 'high' }, verdict),
      make('low', { name: 'rated', level: 'low' }, verdict),
    ]),
    'edge/level.trigger.json': trigger('level', { in: edge('AskIn'), out: edge('Out') }, `${port}#all`),
  });
}

/** A rule on the plan as a whole, so the node that makes it is a guarded site whose answer holds the list mapped over. */
const PLAN_WRITES = { label: 'A plan writes', holds: { on: shape('Plan'), when: 'len(writes) > 0' } };

/** The fields of an edit a site write takes, each bound by its own name from the plan's list. */
const EDIT = { page: STRING, privateHits: NUMBER };

/**
 * `refresh` makes a plan from the trigger's edits and maps `site.port.json#write` over `{{plan.writes}}`, every field
 * bound by its own name (Item 12). The write is bound to a data graph whose `in` is a `PageEdit`, on which an
 * invariant stands, so the compiler guards each element the map writes at `in:check`. The plan's list is of `Edit`,
 * another shape with the same fields, so nothing upstream judged the rule. With `planHeld`, a rule on the whole plan
 * makes `plan` a guarded site, so the list the map runs over is the answer of `plan:check`.
 */
export function eachGuardTree(planHeld = false): string {
  const port = `${HERE}/domain/site.port.json`;
  const written = shape('Written');
  const plan = { writes: { type: `${shape('Edit')}[]` } };
  return treeOf({
    'domain/Edit.shape.json': { layer: 'core', fields: EDIT },
    'domain/PageEdit.shape.json': { layer: 'core', fields: EDIT },
    'domain/Plan.shape.json': { layer: 'core', fields: plan },
    'domain/Written.shape.json': { layer: 'core', fields: EDIT },
    ...(planHeld ? { 'domain/a-plan-writes.invariant.json': PLAN_WRITES } : {}),
    'domain/nothing-private-is-written.invariant.json': {
      label: 'Nothing private is written',
      holds: { on: shape('PageEdit'), when: 'privateHits == 0' },
    },
    'edge/EditIn.shape.json': { layer: 'edge', fields: EDIT },
    'edge/PlanIn.shape.json': { layer: 'edge', fields: { writes: { type: `${edge('EditIn')}[]`, maxItems: 10 } } },
    'edge/Out.shape.json': { layer: 'edge', fields: EDIT },
    'domain/site.port.json': {
      operations: {
        refresh: { description: 'd', accepts: plan, returns: `${written}[]` },
        write: { description: 'd', accepts: EDIT, returns: written },
      },
    },
    'data/site.binding.json': {
      port,
      operations: {
        refresh: { graph: `${HERE}/domain/refresh.graph.json` },
        write: { graph: `${HERE}/data/write.graph.json` },
      },
    },
    'domain/refresh.graph.json': graph('Refresh', shape('Plan'), { type: `${written}[]`, from: 'written' }, [
      make('plan', { writes: '{{in.writes}}' }, shape('Plan')),
      map('written', `${port}#write`, {
        over: '{{plan.writes}}',
        bind: { page: 'page', privateHits: 'privateHits' },
        in: {},
      }),
    ]),
    'data/write.graph.json': graph('Write', shape('PageEdit'), { type: written, from: 'page' }, [
      make('page', { page: '{{in.page}}', privateHits: '{{in.privateHits}}' }, written),
    ]),
    'edge/refresh.trigger.json': trigger('refresh', { in: edge('PlanIn'), out: `${edge('Out')}[]` }, `${port}#refresh`),
  });
}

const PEOPLE = '@features/people';
const PERSON = `${PEOPLE}/domain/Person.shape.json`;
const PEOPLE_PORT = `${PEOPLE}/domain/people.port.json`;
const CARD = `${PEOPLE}/domain/Card.shape.json`;
const FIELDS = { name: STRING, email: STRING };

/** A data graph over a taken `Person`: it makes the person again from `in`, as a write's answer would be read. */
const keepGraph = (label: string) => ({
  label,
  in: PERSON,
  out: { type: PERSON, from: 'kept' },
  nodes: [make('kept', { name: '{{in.name}}', email: '{{in.email}}' }, PERSON)],
});

/**
 * What `register` hands `keep`: the person's own fields, which the guard at `person:check` judged; the draft's name
 * beside the person's email; or the person's name beside the draft's email.
 */
export type People = 'person' | 'draft' | 'email';

/** What `register` hands `keep` under each variant, field by field. */
const KEPT: Record<People, object> = {
  person: { name: '{{person.name}}', email: '{{person.email}}' },
  draft: { name: '{{in.name}}', email: '{{person.email}}' },
  email: { name: '{{person.name}}', email: '{{in.email}}' },
};

/**
 * `register` fires a domain graph that makes a `Person` (a made site, guarded at `person:check`) and hands it to
 * `keep`, bound to a data graph whose `in` is a `Person` (a taken site, guarded at `in:check`); `rename` fires `store`
 * straight from the trigger's input, into a data graph of its own with the same taken guard. `handed` says what
 * `register` hands `keep`. The tree is written into a fresh directory, answered for the caller to remove.
 */
export function peopleTree(handed: People = 'person'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-held-'));
  const put = (rel: string, doc: object) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    const kind = rel
      .replace(/\.json$/, '')
      .split(/[./]/)
      .at(-1) as Kind;
    writeFileSync(join(dir, rel), JSON.stringify({ $schema: schemaUrl(kind), description: 'd', ...doc }));
  };
  put('project.json', { name: 'people', plugins: [{ use: '@std' }, { use: '@cli' }] });
  put('features/people/feature.json', {});
  for (const name of ['Person', 'Draft', 'Card'])
    put(`features/people/domain/${name}.shape.json`, { layer: 'core', fields: FIELDS });
  for (const name of ['Signup', 'PersonView'])
    put(`features/people/edge/${name}.shape.json`, { layer: 'edge', fields: FIELDS });
  put('features/people/domain/a-person-is-reachable.invariant.json', {
    label: 'A person is reachable',
    holds: { on: PERSON, when: 'len(name) > 0 && len(email) > 0' },
  });
  put('features/people/domain/people.port.json', {
    operations: {
      register: { description: 'd', accepts: FIELDS, returns: CARD },
      keep: { description: 'd', accepts: FIELDS, returns: PERSON },
      store: { description: 'd', accepts: FIELDS, returns: PERSON },
    },
  });
  put('features/people/data/people.binding.json', {
    port: PEOPLE_PORT,
    operations: {
      register: { graph: `${PEOPLE}/domain/register-person.graph.json` },
      keep: { graph: `${PEOPLE}/data/keep-person.graph.json` },
      store: { graph: `${PEOPLE}/data/store-person.graph.json` },
    },
  });
  put('features/people/domain/register-person.graph.json', {
    label: 'Register a person',
    in: `${PEOPLE}/domain/Draft.shape.json`,
    out: { type: CARD, from: 'card' },
    nodes: [
      make('person', { name: '{{in.name}}', email: '{{in.email}}' }, PERSON),
      run('kept', `${PEOPLE_PORT}#keep`, KEPT[handed]),
      make('card', { name: '{{kept.name}}', email: '{{person.email}}' }, CARD),
    ],
  });
  put('features/people/data/keep-person.graph.json', keepGraph('Keep a person'));
  put('features/people/data/store-person.graph.json', keepGraph('Store a person'));
  for (const [command, op] of [
    ['register', 'register'],
    ['rename', 'store'],
  ])
    put(
      `features/people/edge/${command}.trigger.json`,
      trigger(
        command,
        { in: `${PEOPLE}/edge/Signup.shape.json`, out: `${PEOPLE}/edge/PersonView.shape.json` },
        `${PEOPLE_PORT}#${op}`,
      ),
    );
  return dir;
}
