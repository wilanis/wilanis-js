/** Handlers the kernel tests share: arithmetic, echoes, sleeps, a fault and refusals, this engine's and a foreign one's. */
import { Refusal } from '../src/index.js';

/** A refusal thrown by a plugin that bundles its own copy of the engine: an Error named Refusal, not ours. */
function foreign(reason: unknown, message: string): Error {
  const error = new Error(message);
  error.name = 'Refusal';
  return Object.assign(error, { reason });
}

export const handlers = {
  double: async ({ in: input }: { in: Record<string, unknown> }) => Number(input.x) * 2,
  boom: async () => {
    throw new Error('boom');
  },
  refuse: async ({ in: input }: { in: Record<string, unknown> }) => {
    throw new Refusal(String(input.reason), `no ${input.what}`, input.detail as Record<string, unknown> | undefined);
  },
  /** Refuses the way a plugin with its own copy of the engine would: `reason` a string unless told otherwise. */
  refuseForeign: async ({ in: input }: { in: Record<string, unknown> }) => {
    throw foreign('reason' in input ? input.reason : undefined, `no ${input.what}`);
  },
  echo: async ({ in: input }: { in: Record<string, unknown> }) => input,
  sleepOrBoom: async ({ in: input }: { in: Record<string, unknown> }) => {
    await new Promise(resolve => setTimeout(resolve, Number(input.ms)));
    if (input.tag === 'boom') throw new Error('boom');
    return input.tag;
  },
  sleep: async ({ in: input }: { in: Record<string, unknown> }) => {
    await new Promise(resolve => setTimeout(resolve, Number(input.ms)));
    return input.tag;
  },
};
