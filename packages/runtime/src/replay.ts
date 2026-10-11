/**
 * How a scenario is fired when `regress` replays it, and so how a command that records a scenario fires the run its
 * expectation is read off (#908). A run that refuses cancels only the nodes that had not started; the nodes in flight
 * settle as they settle (`packages/engine/src/run.ts`). An effect a stub answers settles in fewer steps than one a
 * handler answers, so a run whose effects were generated as it went and the replay of its stubs can end with other
 * nodes cancelled. Recording what the replay answers, fired by the one function `regress` fires with, keeps the two
 * the same. Where the replay ends another way than the run (another node ended it first), the run is not recorded at
 * all (`endedOtherwise`, #935).
 */
import type { Loaded, LoadResult, ScenarioDoc, TriggerDoc } from '@wilanis/core';
import { type NodeReport, type Outcome, outcomeOf, type Report } from '@wilanis/engine';
import type { Embedder } from './embed.js';
import { asWritten } from './recorded-answers.js';
import { replayedDoc } from './rehearse-recorded.js';
import { embedderFor } from './stubbing.js';

/**
 * What every replay of one tree fires through: stubbed effects under seed 0, and so (`embedderFor`) a fake value for
 * every secret the project declares, so a replay reads no real one.
 */
export interface Replayer {
  emb: Embedder;
  stubbed: { seed: number; profile?: string };
}

/** The replayer of a tree under a profile: what `regress` replays with, and what a recorder fires a recording with. */
export function replayerFor(load: LoadResult, profile?: string): Replayer {
  const stubbed = { seed: 0, profile };
  return { emb: embedderFor(load, stubbed), stubbed };
}

/** The trigger a scenario names, as the tree has it; nothing where it has none, which `wilanis check` refuses (S001). */
export const triggerOf = (load: LoadResult, sc: Pick<ScenarioDoc, 'trigger'>): Loaded<TriggerDoc> | undefined =>
  load.registry.all('trigger').find(trigger => trigger.path === load.resolve(sc.trigger));

/** What a replay reads of a scenario: the policy it fires in its trigger's place, its input and context, and where it cancels. */
type Fired = Pick<ScenarioDoc, 'policy' | 'in' | 'context' | 'cancelAt'>;

/**
 * One scenario fired as `regress` fires it: its trigger, or the root of the policy it names, with its input, its
 * context and the stubs given -- and where it pins a cancellation, aborted at that effect (`cancelledReplay`).
 */
export function replayedReport(
  load: LoadResult,
  replayer: Replayer,
  sc: Fired,
  how: { trigger: Loaded<TriggerDoc>; stubs: Record<string, unknown> },
): Promise<Report> {
  const fired = replayedDoc(load, sc, how.trigger);
  if (sc.cancelAt) return cancelledReplay(load, replayer.stubbed, fired, { sc, stubs: how.stubs });
  return replayer.emb.fire(fired, sc.in, sc.context ?? {}, { stubs: how.stubs });
}

/** What a recorder fires its recording with: the way in, and the input, context and stubs it will write. */
export type Replayable = Pick<ScenarioDoc, 'trigger' | 'policy' | 'in' | 'context' | 'stubs'>;

/**
 * The report a recorded scenario's expectation is read off: the scenario fired as `regress` will fire it, from the
 * values as the file holds them (`asWritten`: a key whose value JSON leaves out is not stubbed, and its effect is
 * answered as `regress` answers it), so a recorded scenario replays the same whatever order the run that recorded
 * its stubs happened to settle in.
 */
export function recordedReport(load: LoadResult, replayer: Replayer, recorded: Replayable): Promise<Report> {
  const sc = asWritten(recorded) as Replayable;
  const trigger = triggerOf(load, sc);
  if (!trigger) throw new Error(`a recorded run names trigger '${sc.trigger}', which the tree does not have`);
  return replayedReport(load, replayer, sc, { trigger, stubs: sc.stubs ?? {} });
}

/**
 * A scenario that pins a cancellation, replayed: its `cancelAt` is taken out of the stubs `stubsOf` resolved, so the
 * run reaches that effect's stub, which aborts the run's signal there. A node, never a duration, so the replay is the
 * same on every machine; an embedder of its own, since the stub that aborts is this run's alone.
 */
function cancelledReplay(
  load: LoadResult,
  stubbed: Replayer['stubbed'],
  trigger: TriggerDoc,
  replayed: { sc: Fired; stubs: Record<string, unknown> },
): Promise<Report> {
  const { sc } = replayed;
  const path = sc.cancelAt ?? '';
  const control = new AbortController();
  const emb = embedderFor(load, { ...stubbed, cancelAt: { path, abort: () => control.abort() } });
  const { [path]: _, ...stubs } = replayed.stubs;
  return emb.fire(trigger, sc.in, sc.context ?? {}, { stubs, signal: control.signal });
}

/** How a run ended: how, a refusal's reason, and the node that ended it, by its dotted path. */
interface Ending {
  /** What two runs must share to have ended the same: the kind of ending, a refusal's reason, and the node. */
  same: string;
  /** The ending as the tail of a sentence about the run: `refuses as missing at 'op.noCustomer'`. */
  said: string;
}

/**
 * The node that ended a run that refused or broke, by its dotted path down through every call that failed with it (an
 * element of a map by its index), and the outcome there; nothing for a run that ended another way.
 */
function endedAt(report: Report, prefix: string[] = []): { path: string; outcome: Outcome } | undefined {
  const outcome = outcomeOf(report);
  if (outcome.kind !== 'refused' && outcome.kind !== 'faulted') return undefined;
  const path = [...prefix, outcome.at];
  const below = belowOf(report.nodes[outcome.at]);
  return (below && endedAt(below.report, [...path, ...below.step])) ?? { path: path.join('.'), outcome };
}

/** The run a failed node failed with: its call's, or the first failed element's of a map, with that element's index. */
function belowOf(node: NodeReport | undefined): { report: Report; step: string[] } | undefined {
  if (node?.sub) return { report: node.sub, step: [] };
  const index = node?.items?.findIndex(item => item.status === 'failed') ?? -1;
  const sub = index >= 0 ? node?.items?.[index]?.sub : undefined;
  return sub && { report: sub, step: [String(index)] };
}

/** How a run ended, as `Ending` says it. A fault's message is said and not compared: the node names the fault. */
function endingOf(report: Report): Ending {
  const ended = endedAt(report);
  if (ended?.outcome.kind === 'refused') {
    const said = `refuses as ${ended.outcome.reason} at '${ended.path}'`;
    return { same: said, said };
  }
  if (ended?.outcome.kind === 'faulted') {
    const same = `breaks at '${ended.path}'`;
    return { same, said: `${same}: ${ended.outcome.error}` };
  }
  return { same: ENDED[report.status], said: ENDED[report.status] };
}

/** How a run that neither refused nor broke ended, as the tail of a sentence about it. */
const ENDED: Record<Report['status'], string> = {
  done: 'answers',
  failed: 'fails',
  blocked: 'blocks',
  cancelled: 'is cancelled',
};

/**
 * Why a recorder does not write a run (#935): the run that chose the stubs and the replay of those stubs ended in
 * another way, with another reason, or at another node. A refusal ends a run while the nodes in flight settle as they
 * settle, so another node can end the replay first. The file would then pin the replay's ending under a name and a
 * line that say the first run's. Said as the tail of the recorder's line, with both endings and `again`, the command
 * that records again once the tree is fixed; nothing where both runs ended the same.
 */
export function endedOtherwise(first: Report, replayed: Report, again: string): string | undefined {
  const [was, now] = [endingOf(first), endingOf(replayed)];
  if (was.same === now.same) return undefined;
  return (
    `NOT RECORDED: the run that chose the stubs ${was.said}, and the replay of those stubs ${now.said}. ` +
    'Which node ends the run depends on which settles first: make one of the two run only after the other is ' +
    `decided, or make it stop refusing or breaking, then run ${again} again`
  );
}
