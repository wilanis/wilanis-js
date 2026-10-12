/**
 * The small trees `rehearse-stopped.test.ts` rehearses (RFC 0038, step 4): each hands a graph's switch a level the
 * rehearsal cannot follow out to anything it sets -- text composed from reads, or a literal -- so the trace stops, and
 * the branch says where and why. Every tree passes the checker, since a case about the walk must stand on a tree that
 * does. No tree here stops at `context`: only a data graph or a binding reads it, a data graph runs no domain operation
 * (L002), and the walk enters no binding that delegates by `run`, so no checked tree hands it on to a switch it walks.
 */
import { decide, edge, graph, HERE, make, run, STRING, shape, treeOf, trigger } from './rehearse-stubs-trees.js';

/** How `all` hands `#judge` the level its switch decides on. */
export type Stop = 'composed' | 'literal';

/** The port every tree here declares, and the verdict each of its operations answers with. */
const PORT = `${HERE}/domain/level.port.json`;
const VERDICT = { name: STRING, level: STRING };

/** What `all` hands `#judge` as the level, by the way it stops the trace. */
const HANDED: Record<Stop, string> = { composed: '{{in.target}}-{{in.target}}', literal: 'high' };

/** A graph that calls `#judge` once, at node `judged`, handing it the level as given and its target as the name. */
const calling = (label: string, level: string) =>
  graph(label, shape('Ask'), { type: shape('Verdict'), from: 'judged' }, [
    run('judged', `${PORT}#judge`, { level, name: '{{in.target}}' }),
  ]);

/**
 * `all` calls `#judge`, whose graph decides on `in.level`: `high` where it is 'high', `low` otherwise. How `all` hands
 * the level is the stop. With `other`, a second trigger fires `#other`, which hands `#judge` the literal given, so the
 * same switch is reached on a second path.
 */
export function stoppedTree(stop: Stop, more: { literal?: string; other?: string } = {}): string {
  const level = stop === 'literal' && more.literal !== undefined ? more.literal : HANDED[stop];
  const verdict = shape('Verdict');
  const ops = { description: 'd', accepts: { target: STRING }, returns: verdict };
  const judgeIn = { level: STRING, name: STRING };
  const otherTrigger = trigger('other', { in: edge('AskIn'), out: edge('Out') }, `${PORT}#other`);
  const second = more.other === undefined ? {} : { 'edge/other.trigger.json': otherTrigger };
  return treeOf({
    'domain/Verdict.shape.json': { layer: 'core', fields: VERDICT },
    'domain/Ask.shape.json': { layer: 'core', fields: { target: STRING } },
    'domain/JudgeIn.shape.json': { layer: 'core', fields: judgeIn },
    'edge/AskIn.shape.json': { layer: 'edge', fields: { target: STRING } },
    'edge/Out.shape.json': { layer: 'edge', fields: VERDICT },
    'domain/level.port.json': {
      operations: {
        all: ops,
        other: ops,
        judge: { description: 'd', accepts: judgeIn, returns: verdict },
      },
    },
    'data/level.binding.json': {
      port: PORT,
      operations: {
        all: { graph: `${HERE}/domain/all.graph.json` },
        other: { graph: `${HERE}/domain/other.graph.json` },
        judge: { graph: `${HERE}/domain/judge.graph.json` },
      },
    },
    'domain/all.graph.json': calling('All', level),
    'domain/other.graph.json': calling('Other', more.other ?? 'low'),
    'domain/judge.graph.json': graph('Judge', shape('JudgeIn'), { type: verdict, from: ['high', 'low'] }, [
      decide('isHigh', { level: '{{in.level}}' }, [{ when: "level == 'high'", to: 'high' }], 'low'),
      make('high', { name: '{{in.name}}', level: 'high' }, verdict),
      make('low', { name: '{{in.name}}', level: 'low' }, verdict),
    ]),
    'edge/level.trigger.json': trigger('level', { in: edge('AskIn'), out: edge('Out') }, `${PORT}#all`),
    ...second,
  });
}
