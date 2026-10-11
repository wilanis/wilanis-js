/**
 * How a scenario is fired when `regress` replays it, and so how a command that records a scenario fires the run its
 * expectation is read off (#908). A run that refuses cancels only the nodes that had not started; the nodes in flight
 * settle as they settle (`packages/engine/src/run.ts`). An effect a stub answers settles in fewer steps than one a
 * handler answers, so a run whose effects were generated as it went and the replay of its stubs can end with other
 * nodes cancelled. Recording what the replay answers, fired by the one function `regress` fires with, keeps the two
 * the same.
 */
import type { Loaded, LoadResult, ScenarioDoc, TriggerDoc } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import type { Embedder } from './embed.js';
import { asWritten } from './recorded-answers.js';
import { replayedDoc } from './rehearse-recorded.js';
import { embedderFor } from './stubbing.js';

/** What every replay of one tree fires through: stubbed effects under seed 0, a fake secret for each one declared. */
export interface Replayer {
  emb: Embedder;
  stubbed: { seed: number; profile?: string; env: NodeJS.ProcessEnv };
}

/** The replayer of a tree under a profile: what `regress` replays with, and what a recorder fires a recording with. */
export function replayerFor(load: LoadResult, profile?: string): Replayer {
  const stubbed = { seed: 0, profile, env: fakeEnvFor(load) };
  return { emb: embedderFor(load, stubbed), stubbed };
}

/** An environment that holds every secret the project declares, as `stub-<name>`, so a replay reads no real one. */
function fakeEnvFor(load: LoadResult): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of Object.values(load.registry.project?.doc.secrets ?? {})) env[name] = `stub-${name.toLowerCase()}`;
  return env;
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
