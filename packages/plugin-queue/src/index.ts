/**
 * @wilanis/plugin-queue, the @queue plugin: a message on a queue as a trigger, publishing as an effect, and the
 * worker a startup step names. It says what a queue is and what may be asked of one; which broker keeps it is a
 * connection of a kind a broker plugin grants, reached through the `Broker` contract and the table
 * `brokers(env)` holds. This package carries no broker, speaks no broker's language, and depends on core and
 * engine alone.
 *
 * What consumes the queues is the `holds` operation a project's startup list names, not this module's own
 * doing: a tree that names no step consumes nothing, as a tree that names no listener serves nothing. The
 * trigger kind's runtime is here for `encode` -- `wilanis run` and the rehearsal then say what the message would
 * have become, through the same `outcomeOf` the worker tells the broker with.
 */
import { fileURLToPath } from 'node:url';
import type { PluginModule, TriggerRuntime } from '@wilanis/core';
import { outcomeOf } from './outcome.js';
import { CONSUME, ENSURE, KIND, PUBLISH, ROOT } from './paths.js';
import { ensure, publish } from './publish.js';
import { check } from './rules.js';
import { consume } from './worker.js';

export type { Answer, Broker, Delivery, Handle, Message, Outcome, Reached } from './brokers.js';
export { Brokers, brokerFor, brokers } from './brokers.js';
export type { Consumed, Worked } from './deliver.js';
export { contextOf, deliver } from './deliver.js';
export type { Decided, Outcomes } from './outcome.js';
export { DEFAULT_BACKOFF_MS, DEFAULT_MAX_ATTEMPTS, OUTCOMES, outcomeOf, outcomesOf } from './outcome.js';
export { CONSUME, ENSURE, KIND, PUBLISH, ROOT } from './paths.js';

const DOCS = fileURLToPath(new URL('../docs', import.meta.url));

const runtime: TriggerRuntime = {
  // the work is the consume step's: a queue consumed from here would be worked by a tree that never asked
  async start(triggers, _fire, { log }) {
    if (triggers.length) log(`queue: ${triggers.length} trigger(s) -- consumed while a startup step names ${CONSUME}`);
    return async () => {};
  },
  // what the message would become on its first delivery, and the refusal behind it where there was one
  encode: (trigger, report) => {
    const { outcome, reason, message } = outcomeOf(trigger, report);
    return reason === undefined ? { outcome } : { outcome, reason, message };
  },
};

const queue: PluginModule = {
  root: ROOT,
  docs: DOCS,
  handlers: { [PUBLISH]: publish, [ENSURE]: ensure, [CONSUME]: consume },
  triggers: { [KIND]: runtime },
  check,
};

export default queue;
