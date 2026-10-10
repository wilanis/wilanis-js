/**
 * The small trees `rehearse-stubs.test.ts` rehearses (#844), each built so that a stub holding only the fields a rule
 * reads breaks a sibling that reads another field of the same answer. One feature `rv`, with `@std` and `@cli`, fired
 * from a CLI trigger; every tree passes the checker, since a case about the walk must stand on a tree that does.
 * `treeOf` and the document helpers are exported, so a test of another part of the walk builds its tree the same way.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Kind, schemaUrl } from '@wilanis/core';

export const HERE = '@features/rv';
const MAKE = '@std/object.port.json#make';
export const NUMBER = { type: 'number' };
export const STRING = { type: 'string' };
const ITEM = { score: NUMBER, name: STRING };
export const shape = (name: string) => `${HERE}/domain/${name}.shape.json`;
export const edge = (name: string) => `${HERE}/edge/${name}.shape.json`;

export const run = (id: string, op: string, input: object) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run: op,
  in: input,
});
export const make = (id: string, value: object, type: string) => run(id, MAKE, { value, type });
export const refuse = (id: string, reason: string, type: string) =>
  run(id, '@std/outcome.port.json#refuse', { reason, message: reason, type });
export const decide = (id: string, input: object, rules: { when: string; to: string }[], otherwise: string) => ({
  type: '@wilanis/node/switch.schema.json',
  id,
  in: input,
  rules,
  else: otherwise,
});
/** A map node: the operation it runs per element of `over`, the element's fields bound by `bind`, and its other inputs. */
const map = (id: string, op: string, each: { over: string; bind: object; in: object }) => ({
  type: '@wilanis/node/map.schema.json',
  id,
  run: op,
  ...each,
});

/** A CLI trigger firing one operation. */
export const trigger = (command: string, types: { in: string; out: string }, op: string) => ({
  label: command,
  kind: '@cli/cli.trigger-kind.json',
  settings: { command },
  ...types,
  fire: { run: op },
});

/** A graph of the feature: its label, input, output and nodes. */
export const graph = (
  label: string,
  input: string,
  out: { type: string; from: string | string[] },
  nodes: object[],
) => ({
  label,
  in: input,
  out,
  nodes,
});

/** Write a tree of one feature `rv` holding the documents given by their path under the feature, into a fresh directory. */
export function treeOf(docs: Record<string, object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-stubs-'));
  const put = (rel: string, doc: object) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    const kind = rel
      .replace(/\.json$/, '')
      .split(/[./]/)
      .at(-1) as Kind;
    writeFileSync(join(dir, rel), JSON.stringify({ $schema: schemaUrl(kind), description: 'd', ...doc }));
  };
  put('project.json', { name: 'rv', plugins: [{ use: '@std' }, { use: '@cli' }] });
  put('features/rv/feature.json', {});
  for (const [rel, doc] of Object.entries(docs)) put(`features/rv/${rel}`, doc);
  return dir;
}

/**
 * `all` scans a target, makes an `Info` from the scan's `run`, and judges each finding the scan answered. The scan is a
 * graph, so no seed records its answer, and `judge`'s switch is reached only when the findings hold an element.
 */
export function nonemptyTree(): string {
  const port = `${HERE}/domain/triage.port.json`;
  const asked = { target: STRING, list: { type: `${shape('Item')}[]` } };
  return treeOf({
    'domain/Item.shape.json': { layer: 'core', fields: ITEM },
    'domain/Info.shape.json': { layer: 'core', fields: { run: STRING } },
    'domain/Scan.shape.json': { layer: 'core', fields: { run: STRING, findings: { type: `${shape('Item')}[]` } } },
    'domain/Verdict.shape.json': { layer: 'core', fields: { name: STRING, level: STRING } },
    'domain/JudgeIn.shape.json': { layer: 'core', fields: { ...ITEM, previous: STRING } },
    'domain/Ask.shape.json': { layer: 'core', fields: asked },
    'edge/ItemIn.shape.json': { layer: 'edge', fields: ITEM },
    'edge/AskIn.shape.json': {
      layer: 'edge',
      fields: { target: STRING, list: { type: `${edge('ItemIn')}[]`, maxItems: 10 } },
    },
    'edge/Out.shape.json': { layer: 'edge', fields: { name: STRING, level: STRING } },
    'domain/triage.port.json': {
      operations: {
        all: { description: 'd', accepts: asked, returns: `${shape('Verdict')}[]` },
        scan: { description: 'd', accepts: asked, returns: shape('Scan') },
        judge: { description: 'd', accepts: { ...ITEM, previous: STRING }, returns: shape('Verdict') },
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
    'domain/all.graph.json': graph('All', shape('Ask'), { type: `${shape('Verdict')}[]`, from: 'judged' }, [
      run('scanned', `${port}#scan`, { target: '{{in.target}}', list: '{{in.list}}' }),
      make('info', { run: '{{scanned.run}}' }, shape('Info')),
      map('judged', `${port}#judge`, {
        over: '{{scanned.findings}}',
        bind: { score: 'score', name: 'name' },
        in: { previous: '{{info.run}}' },
      }),
    ]),
    'domain/judge.graph.json': graph('Judge', shape('JudgeIn'), { type: shape('Verdict'), from: ['high', 'low'] }, [
      make('facts', { score: '{{in.score}}', name: '{{in.name}}' }, shape('Item')),
      decide('decide', { score: '{{facts.score}}' }, [{ when: 'score > 5', to: 'high' }], 'low'),
      make('high', { name: '{{in.name}}', level: '{{in.previous}}' }, shape('Verdict')),
      make('low', { name: '{{in.name}}', level: 'low' }, shape('Verdict')),
    ]),
    'edge/triage.trigger.json': trigger('triage', { in: edge('AskIn'), out: `${edge('Out')}[]` }, `${port}#all`),
  });
}

/**
 * `check` reads a scan and decides on it three times over: on its `status`, then on whether it `agrees`, then on whether
 * it moved. The second and third switches stand behind the first, and all three read the one answer `got`.
 */
export function layersTree(): string {
  const port = `${HERE}/domain/scan.port.json`;
  const result = shape('Result');
  const read = {
    status: { type: 'string', enum: ['clean', 'findings', 'broke'] },
    agrees: { type: 'boolean' },
    count: NUMBER,
    commit: STRING,
    previous: { type: 'string', required: false },
  };
  return treeOf({
    'domain/Read.shape.json': { layer: 'core', fields: read },
    'domain/Result.shape.json': { layer: 'core', fields: { status: STRING, count: NUMBER } },
    'domain/Ask.shape.json': { layer: 'core', fields: { target: STRING } },
    'edge/AskIn.shape.json': { layer: 'edge', fields: { target: STRING } },
    'edge/Out.shape.json': { layer: 'edge', fields: { status: STRING, count: NUMBER } },
    'domain/scan.port.json': {
      operations: {
        check: { description: 'd', accepts: { target: STRING }, returns: result, refuses: true },
        read: { description: 'd', accepts: { target: STRING }, returns: shape('Read') },
      },
    },
    'data/scan.binding.json': {
      port,
      operations: {
        check: { graph: `${HERE}/domain/check.graph.json` },
        read: { graph: `${HERE}/data/read.graph.json` },
      },
    },
    'data/read.graph.json': graph('Read', shape('Ask'), { type: shape('Read'), from: 'r' }, [
      make('r', { status: 'broke', agrees: false, count: 0, commit: '{{in.target}}' }, shape('Read')),
    ]),
    'domain/check.graph.json': graph(
      'Check',
      shape('Ask'),
      { type: result, from: ['good', 'same', 'broke', 'disagree'] },
      [
        run('got', `${port}#read`, { target: '{{in.target}}' }),
        decide('status', { status: '{{got.status}}' }, [{ when: "status == 'clean'", to: 'ok' }], 'broke'),
        refuse('broke', 'broke', result),
        make('ok', { status: '{{got.status}}', count: '{{got.count}}' }, result),
        decide('agree', { agrees: '{{got.agrees}}', n: '{{ok.count}}' }, [{ when: 'agrees', to: 'moved' }], 'disagree'),
        refuse('disagree', 'disagree', result),
        decide('moved', { commit: '{{got.commit}}' }, [{ when: "commit == 'same'", to: 'same' }], 'good'),
        refuse('same', 'same', result),
        make('good', { status: '{{ok.status}}', count: '{{ok.count}}' }, result),
      ],
    ),
    'edge/check.trigger.json': trigger('check', { in: edge('AskIn'), out: edge('Out') }, `${port}#check`),
  });
}

/**
 * `report` reads a record whose `meta` is optional and decides on `has(meta.cost)`, a field inside it. The branch that
 * takes it keeps the whole `meta`, whose `modules` is required, so a `meta` made to hold only `cost` breaks the make.
 */
export function parentTree(): string {
  const port = `${HERE}/domain/rep.port.json`;
  const result = shape('Result');
  const meta = { cost: { type: 'number', required: false }, modules: NUMBER };
  return treeOf({
    'domain/Meta.shape.json': { layer: 'core', fields: meta },
    'domain/Read.shape.json': {
      layer: 'core',
      fields: { meta: { type: shape('Meta'), required: false }, commit: STRING },
    },
    'domain/Result.shape.json': {
      layer: 'core',
      fields: { c: { type: 'number', required: false }, meta: { type: shape('Meta'), required: false } },
    },
    'domain/Ask.shape.json': { layer: 'core', fields: { target: STRING } },
    'edge/AskIn.shape.json': { layer: 'edge', fields: { target: STRING } },
    'edge/MetaOut.shape.json': { layer: 'edge', fields: meta },
    'edge/Out.shape.json': {
      layer: 'edge',
      fields: { c: { type: 'number', required: false }, meta: { type: edge('MetaOut'), required: false } },
    },
    'domain/rep.port.json': {
      operations: {
        report: { description: 'd', accepts: { target: STRING }, returns: result },
        read: { description: 'd', accepts: { target: STRING }, returns: shape('Read') },
      },
    },
    'data/rep.binding.json': {
      port,
      operations: {
        report: { graph: `${HERE}/domain/report.graph.json` },
        read: { graph: `${HERE}/data/read.graph.json` },
      },
    },
    'data/read.graph.json': graph('Read', shape('Ask'), { type: shape('Read'), from: 'r' }, [
      make('r', { commit: '{{in.target}}' }, shape('Read')),
    ]),
    'domain/report.graph.json': graph('Report', shape('Ask'), { type: result, from: ['measured', 'notMeasured'] }, [
      run('got', `${port}#read`, { target: '{{in.target}}' }),
      decide('has', { meta: '{{got.meta}}' }, [{ when: 'has(meta.cost)', to: 'measured' }], 'notMeasured'),
      make('measured', { c: '{{got.meta.cost}}', meta: '{{got.meta}}' }, result),
      make('notMeasured', {}, result),
    ]),
    'edge/report.trigger.json': trigger('report', { in: edge('AskIn'), out: edge('Out') }, `${port}#report`),
  });
}

/**
 * `all` makes a list of `Finding` from the trigger's items with a `map` of `#make`, and a field invariant on `Finding`
 * guards that list: the compiler moves the map aside to `made:made` and judges each element at `in:check`.
 */
export function mappedTree(): string {
  const port = `${HERE}/domain/triage.port.json`;
  const finding = shape('Finding');
  return treeOf({
    'domain/Item.shape.json': { layer: 'core', fields: ITEM },
    'domain/Finding.shape.json': { layer: 'core', fields: ITEM },
    'domain/a-finding-is-named.invariant.json': {
      label: 'A finding is named',
      holds: { on: finding, when: 'len(name) > 0' },
    },
    'domain/Batch.shape.json': { layer: 'core', fields: { items: { type: `${shape('Item')}[]` } } },
    'edge/ItemIn.shape.json': { layer: 'edge', fields: ITEM },
    'edge/BatchIn.shape.json': { layer: 'edge', fields: { items: { type: `${edge('ItemIn')}[]`, maxItems: 10 } } },
    'edge/Out.shape.json': { layer: 'edge', fields: ITEM },
    'domain/triage.port.json': {
      operations: {
        all: { description: 'd', accepts: { items: { type: `${shape('Item')}[]` } }, returns: `${finding}[]` },
      },
    },
    'data/triage.binding.json': { port, operations: { all: { graph: `${HERE}/domain/all.graph.json` } } },
    'domain/all.graph.json': graph('All', shape('Batch'), { type: `${finding}[]`, from: 'made' }, [
      map('made', MAKE, { over: '{{in.items}}', bind: { value: '' }, in: { type: finding } }),
    ]),
    'edge/triage.trigger.json': trigger('triage', { in: edge('BatchIn'), out: `${edge('Out')}[]` }, `${port}#all`),
  });
}

/**
 * `all` makes an `Item` of each of the trigger's items with a `map` of `#make`, and judges each made item with a second
 * `map`, so the list the second map runs over is the first map's answer -- which the kernel answers element by element,
 * at `made.<index>`, never at `made` (#869). `judge`'s switch is reached only when the trigger's items hold an element.
 */
export function chainedTree(): string {
  const port = `${HERE}/domain/triage.port.json`;
  return treeOf({
    'domain/Item.shape.json': { layer: 'core', fields: ITEM },
    'domain/Verdict.shape.json': { layer: 'core', fields: { name: STRING, level: STRING } },
    'domain/Batch.shape.json': { layer: 'core', fields: { items: { type: `${shape('Item')}[]` } } },
    'edge/ItemIn.shape.json': { layer: 'edge', fields: ITEM },
    'edge/BatchIn.shape.json': { layer: 'edge', fields: { items: { type: `${edge('ItemIn')}[]`, maxItems: 10 } } },
    'edge/Out.shape.json': { layer: 'edge', fields: { name: STRING, level: STRING } },
    'domain/triage.port.json': {
      operations: {
        all: { description: 'd', accepts: { items: { type: `${shape('Item')}[]` } }, returns: `${shape('Verdict')}[]` },
        judge: { description: 'd', accepts: ITEM, returns: shape('Verdict') },
      },
    },
    'data/triage.binding.json': {
      port,
      operations: {
        all: { graph: `${HERE}/domain/all.graph.json` },
        judge: { graph: `${HERE}/domain/judge.graph.json` },
      },
    },
    'domain/all.graph.json': graph('All', shape('Batch'), { type: `${shape('Verdict')}[]`, from: 'judged' }, [
      map('made', MAKE, { over: '{{in.items}}', bind: { value: '' }, in: { type: shape('Item') } }),
      map('judged', `${port}#judge`, { over: '{{made}}', bind: { score: 'score', name: 'name' }, in: {} }),
    ]),
    'domain/judge.graph.json': graph('Judge', shape('Item'), { type: shape('Verdict'), from: ['high', 'low'] }, [
      make('facts', { score: '{{in.score}}', name: '{{in.name}}' }, shape('Item')),
      decide('decide', { score: '{{facts.score}}' }, [{ when: 'score > 5', to: 'high' }], 'low'),
      make('high', { name: '{{in.name}}', level: 'high' }, shape('Verdict')),
      make('low', { name: '{{in.name}}', level: 'low' }, shape('Verdict')),
    ]),
    'edge/triage.trigger.json': trigger('triage', { in: edge('BatchIn'), out: `${edge('Out')}[]` }, `${port}#all`),
  });
}
