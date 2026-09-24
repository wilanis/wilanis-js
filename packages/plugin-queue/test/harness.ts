/**
 * What the worker is given in a test: a `Serving` that records what was fired and answers as the case says, an
 * environment carrying one broker connection, and the fake broker registered for it. No test here loads a tree:
 * the worker's business is what becomes of a message, and what it is given is exactly what the runtime would
 * give it. The whole path through the runtime is `start.test.ts`'s.
 */
import type { BlobScope, BlobStore, FireArgs, Hold, Serving, TriggerDoc } from '@wilanis/core';
import type { Report, RunContext } from '@wilanis/engine';
import { brokers } from '../src/brokers.js';
import { KIND } from '../src/paths.js';
import { consume } from '../src/worker.js';
import { FakeBroker } from './fake-broker.js';
import { AT_LEAST_ONCE, JOBS } from './tree.js';

/** What a fake run answers: a report, a throw, or a wait until the case lets it answer. */
export interface Answering {
  report?: Partial<Report>;
  error?: string;
  hold?: boolean;
}

/** A report refusing with one reason, as a graph ending on purpose answers. */
export const refusing = (reason: string): Partial<Report> => ({
  status: 'failed',
  nodes: { gone: { status: 'failed', reason, error: `${reason}: golf`, endedAt: 1 } },
});

/** A queue trigger, as a document: the settings a case varies and the operation it fires. */
export function trigger(
  settings: Record<string, unknown> = {},
  run = '@customers/domain/customer.port.json#remove',
): TriggerDoc {
  return {
    $schema: '@wilanis/trigger.schema.json',
    description: 'a queue trigger, for a test',
    kind: KIND,
    settings: { connection: JOBS, queue: 'removals', message: 'IdRequest', ...settings },
    fire: { run, in: { id: '{{request.message.id}}' } },
  } as TriggerDoc;
}

/** A blob store whose scopes count their release, since a delivery opens one and releases it once answered. */
function counted(counts: { scopes: number; released: number }): BlobStore {
  const store = {
    scope(): BlobScope {
      counts.scopes++;
      return {
        release: async () => {
          counts.released++;
        },
      } as unknown as BlobScope;
    },
  };
  return store as unknown as BlobStore;
}

/** What a test hands the worker in place of the runtime: the triggers served and what a fire answers. */
export function serving(
  triggers: TriggerDoc[],
  answering: (request: Record<string, unknown>) => Answering = () => ({}),
) {
  const fired: { run: string; request: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const open: (() => void)[] = [];
  const blobs = { scopes: 0, released: 0 };
  let set = triggers;
  let inputFor: Serving['inputFor'] = (_trigger, request) => ({ input: request.message });
  const serving = {
    triggers: (kind: string) => (kind === KIND ? set : []),
    fire: async ({ trigger, request }: FireArgs) => {
      fired.push({ run: trigger.fire.run, request });
      const answer = answering(request);
      if (answer.hold) await new Promise<void>(done => open.push(done));
      if (answer.error) throw new Error(answer.error);
      return {
        graph: trigger.fire.run,
        status: 'done',
        output: {},
        nodes: {},
        startedAt: 0,
        endedAt: 0,
        ...answer.report,
      } as Report;
    },
    inputFor: (trigger: TriggerDoc, request: Record<string, unknown>) => inputFor(trigger, request),
    blobs: counted(blobs),
    log: (line: string) => logs.push(line),
  } as unknown as Serving;
  return {
    serving,
    fired,
    logs,
    blobs,
    /** Let the run that is being held answer. */
    release: () => open.shift()?.(),
    /** Put a new set of triggers behind the same serving, as a reload does. */
    reloadWith: (next: TriggerDoc[]) => {
      set = next;
    },
    /** Judge inputs as the case says, as the runtime judges them against the trigger's in. */
    judging: (judge: Serving['inputFor']) => {
      inputFor = judge;
    },
  };
}

/** One held thing, as the worker handed it to the runtime. */
export type Held = { label: string; stop: () => Promise<void> };

/**
 * Run the consume step against a serving, with a broker registered for the jobs connection's kind unless the
 * case says none is. Answers what the step answered and what it held.
 */
export async function consuming(
  given: Serving,
  input: Record<string, unknown> = {},
  broker: FakeBroker | 'none' = new FakeBroker(),
) {
  const held: Held[] = [];
  const hold: Hold = what => held.push(what);
  const env: Record<string, unknown> = {
    connections: {
      [JOBS]: { kind: AT_LEAST_ONCE, settings: {} },
      '@connections/other.connection.json': { kind: AT_LEAST_ONCE, settings: {} },
    },
    canon: (ref: string) => ref,
    serving: given,
    hold,
  };
  if (broker !== 'none') brokers(env).register(AT_LEAST_ONCE, broker);
  const answer = await consume({ in: input, ctx: { env } as unknown as RunContext });
  return {
    answer: answer as { queues: number; connections: number },
    held,
    stop: () => Promise.all(held.map(one => one.stop())),
  };
}

/** Wait until a condition holds, looking every few milliseconds; false when it never did. */
export async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise(done => setTimeout(done, 5));
  return ok();
}
